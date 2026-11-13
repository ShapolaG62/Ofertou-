'use strict';
// ============================================================================
// Tradutor de SQL: SQLite -> MySQL 8
// ----------------------------------------------------------------------------
// O projeto foi escrito com o modulo nativo `node:sqlite`. Para rodar em
// MySQL sem mexer em nenhum dos ~60 arquivos que usam o banco, a traducao
// fica concentrada aqui.
//
// O que e traduzido:
//   datas ............ datetime('now'), datetime('now','-30 days'), date('now')
//   insercoes ........ INSERT OR IGNORE / INSERT OR REPLACE
//   conflitos ....... ON CONFLICT (...) DO UPDATE -> ON DUPLICATE KEY UPDATE
//   texto ............ 'a' || 'b' -> CONCAT('a','b')
//   funcoes ......... group_concat(x, sep), random(), COLLATE NOCASE
//   DDL ............. CREATE TABLE / CREATE INDEX / ALTER TABLE (tipos, chaves)
//   PRAGMA .......... PRAGMA foreign_keys -> SET FOREIGN_KEY_CHECKS
//   sqlite_master ... SELECT sql FROM sqlite_master -> SHOW CREATE TABLE
//
// Observacoes:
//   - As datas sao guardadas em UTC no formato 'YYYY-MM-DD HH:MM:SS' (igual ao
//     SQLite), entao os textos continuam comparaveis da mesma maneira.
//   - As colunas de texto que entram em indice viram VARCHAR(191); as outras
//     viram LONGTEXT, que aceita qualquer tamanho sem cortar informacao.
// ============================================================================

const MASCARA = '\u0001';       // marca os literais escondidos durante a analise
const MARCA_MOD = '\u0002';     // marca os modificadores resolvidos na execucao
const PROTEGE = '\u0003';       // protege trechos que nao podem ser alterados

// Palavras reservadas do MySQL que aparecem no projeto como nome de coluna.
const RESERVADAS = new Set(['key']);

// ---------------------------------------------------------------------------
// Extracao de literais
// ---------------------------------------------------------------------------

// Esconde os literais (texto entre aspas) e os comentarios, devolvendo o SQL
// mascarado e a lista de literais. Assim as regras abaixo nunca confundem um
// texto do codigo com um dado gravado no banco.
function extrairLiterais(sql) {
  const literais = [];
  const valores = [];
  let saida = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let valor = '';
      while (j < sql.length) {
        if (c !== '`' && sql[j] === '\\') { valor += sql[j + 1] ?? ''; j += 2; continue; }
        if (sql[j] === c) {
          if (sql[j + 1] === c) { valor += c; j += 2; continue; }
          j++; break;
        }
        valor += sql[j]; j++;
      }
      saida += MASCARA + literais.length + MASCARA;
      literais.push(sql.slice(i, j));
      valores.push(valor);
      i = j;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') { const f = sql.indexOf('\n', i); i = f === -1 ? sql.length : f; continue; }
    if (c === '/' && sql[i + 1] === '*') { const f = sql.indexOf('*/', i + 2); i = f === -1 ? sql.length : f + 2; continue; }
    saida += c; i++;
  }
  return { mascarado: saida, literais, valores };
}

function restaurar(mascarado, literais) {
  return mascarado.replace(/\u0001(\d+)\u0001/g, (_, n) => literais[Number(n)]);
}

// O valor do literal (sem as aspas) quando o trecho e um literal mascarado.
function valorDoToken(token, valores) {
  const m = /^\u0001(\d+)\u0001$/.exec(String(token || '').trim());
  if (!m) return null;
  return valores[Number(m[1])];
}

// ---------------------------------------------------------------------------
// Utilitarios de texto
// ---------------------------------------------------------------------------

// Indice do parentese que fecha o aberto em `abre`.
function fimDaChamada(s, abre) {
  let nivel = 0;
  for (let i = abre; i < s.length; i++) {
    if (s[i] === '(') nivel++;
    else if (s[i] === ')') { nivel--; if (nivel === 0) return i; }
  }
  return s.length - 1;
}

// Abertura do parentese que fecha em `fecha`.
function aberturaDaChamada(s, fecha) {
  let nivel = 0;
  for (let i = fecha; i >= 0; i--) {
    if (s[i] === ')') nivel++;
    else if (s[i] === '(') { nivel--; if (nivel === 0) return i; }
  }
  return 0;
}

// Separa os argumentos de uma chamada, respeitando parenteses e virgulas.
function separarArgs(texto) {
  const partes = [];
  let nivel = 0;
  let ini = 0;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (c === '(') nivel++;
    else if (c === ')') nivel--;
    else if (c === ',' && nivel === 0) { partes.push(texto.slice(ini, i)); ini = i + 1; }
  }
  partes.push(texto.slice(ini));
  return partes.map(p => p.trim());
}

// Separa o SQL em comandos, respeitando literais e comentarios.
function separarComandos(sql) {
  const { mascarado, literais } = extrairLiterais(sql);
  const comandos = [];
  let ini = 0;
  for (let i = 0; i < mascarado.length; i++) {
    if (mascarado[i] === ';') {
      const parte = mascarado.slice(ini, i);
      if (parte.trim()) comandos.push(restaurar(parte, literais));
      ini = i + 1;
    }
  }
  const resto = mascarado.slice(ini);
  if (resto.trim()) comandos.push(restaurar(resto, literais));
  return comandos;
}

// ---------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------

const UNIDADES = {
  day: 'DAY', days: 'DAY', hour: 'HOUR', hours: 'HOUR',
  minute: 'MINUTE', minutes: 'MINUTE', second: 'SECOND', seconds: 'SECOND',
  month: 'MONTH', months: 'MONTH', year: 'YEAR', years: 'YEAR',
};

// Converte um modificador do SQLite ('-30 days', 'start of day'...) em uma
// expressao do MySQL aplicada sobre a base informada.
function aplicarModificador(base, mod) {
  const m = /^([+-])\s*(\d+)\s+([a-z]+)$/i.exec(String(mod).trim());
  if (m && UNIDADES[m[3].toLowerCase()]) {
    const sinal = m[1] === '-' ? '-' : '+';
    return `${base} ${sinal} INTERVAL ${m[2]} ${UNIDADES[m[3].toLowerCase()]}`;
  }
  const texto = String(mod).trim().toLowerCase();
  if (texto === 'start of day') return `DATE(${base})`;
  if (texto === 'start of month') return `DATE_FORMAT(${base}, '%Y-%m-01')`;
  if (texto === 'start of year') return `DATE_FORMAT(${base}, '%Y-01-01')`;
  if (texto === 'unixepoch') return `UNIX_TIMESTAMP(${base})`;
  return base; // 'now', 'localtime' e desconhecidos: mantem a base
}

// Reescreve datetime(...) e date(...) no dialeto do MySQL, alem do operador
// "IS ?" (que so existe no SQLite).
function traduzirExpressoes(s, valores, modificadores) {
  let saida = '';
  let i = 0;
  let placeholders = 0;
  while (i < s.length) {
    const anterior = i > 0 ? s[i - 1] : ' ';

    // "coluna IS ?" -> "coluna IS NULL" ou "coluna = ?" (definido na execucao)
    const mIs = /^(\s+)IS\s+\?/i.exec(s.slice(i));
    if (mIs && !/[A-Za-z0-9_$]/.test(s[i + mIs[1].length - 1] || ' ')) {
      const marca = `${MARCA_MOD}IS${placeholders}${MARCA_MOD}`;
      modificadores.push({ indice: placeholders, marca, tipo: 'is' });
      saida += mIs[1] + marca;
      i += mIs[0].length;
      continue;
    }

    const m = /^(datetime|date)\s*\(/i.exec(s.slice(i));
    if (m && !/[A-Za-z0-9_$]/.test(anterior)) {
      const abre = i + m[0].length - 1;
      const fecha = fimDaChamada(s, abre);
      const corpo = s.slice(abre + 1, fecha);
      const args = separarArgs(corpo);
      const funcao = m[1].toLowerCase();
      const baseBruta = args[0] || '';
      const valorBase = valorDoToken(baseBruta, valores);

      const base = valorBase !== null
        ? (valorBase.toLowerCase() === 'now' ? (funcao === 'date' ? 'CURDATE()' : 'NOW()') : baseBruta)
        : baseBruta;

      const modBruto = args[1];
      let expressao;
      if (modBruto === undefined) {
        expressao = funcao === 'date' ? `DATE(${base})` : base;
      } else if (modBruto === '?') {
        // O modificador chega como parametro: resolve na hora de executar.
        const indice = placeholders + (baseBruta.includes('?') ? 1 : 0);
        const marca = MARCA_MOD + indice + MARCA_MOD;
        modificadores.push({ indice, marca, base, funcao, tipo: 'data' });
        expressao = marca;
      } else {
        const valorMod = valorDoToken(modBruto, valores);
        const mod = valorMod === null ? modBruto : valorMod;
        expressao = funcao === 'date' && valorMod === null
          ? `DATE(${base})`
          : aplicarModificador(base, mod);
      }
      saida += expressao;
      placeholders += (corpo.match(/\?/g) || []).length;
      i = fecha + 1;
      continue;
    }
    if (s[i] === '?') placeholders++;
    saida += s[i];
    i++;
  }
  return saida;
}

// ---------------------------------------------------------------------------
// Concatenacao com ||
// ---------------------------------------------------------------------------

// Le o operando de um lado do operador (dir = 1 para a direita, -1 para a esquerda).
function lerOperando(s, pos, dir) {
  if (dir === 1) {
    let p = pos;
    while (p < s.length && /\s/.test(s[p])) p++;
    if (p >= s.length) return null;
    if (s[p] === MASCARA) { const f = s.indexOf(MASCARA, p + 1); return { texto: s.slice(p, f + 1), inicio: p, fim: f + 1 }; }
    if (s[p] === '(') { const f = fimDaChamada(s, p); return { texto: s.slice(p, f + 1), inicio: p, fim: f + 1 }; }
    let ini = p;
    while (p < s.length && /[A-Za-z0-9_$.?]/.test(s[p])) p++;
    if (p < s.length && s[p] === '(') { const f = fimDaChamada(s, p); return { texto: s.slice(ini, f + 1), inicio: ini, fim: f + 1 }; }
    return { texto: s.slice(ini, p), inicio: ini, fim: p };
  }
  let q = pos - 1;
  while (q >= 0 && /\s/.test(s[q])) q--;
  if (q < 0) return null;
  const fim = q + 1;
  if (s[q] === ')') {
    const a = aberturaDaChamada(s, q);
    let ini = a;
    while (ini > 0 && /[A-Za-z0-9_$.?]/.test(s[ini - 1])) ini--;
    return { texto: s.slice(ini, fim), inicio: ini, fim };
  }
  if (s[q] === MASCARA) {
    // Literal mascarado: o texto e \u0001<numero>\u0001 (aqui estamos no fim).
    let ini = q;
    while (ini > 0 && /\d/.test(s[ini - 1])) ini--;
    if (ini > 0 && s[ini - 1] === MASCARA) ini--;
    return { texto: s.slice(ini, fim), inicio: ini, fim };
  }
  let ini = q;
  while (ini > 0 && /[A-Za-z0-9_$.?]/.test(s[ini - 1])) ini--;
  return { texto: s.slice(ini, fim), inicio: ini, fim };
}

// 'a' || 'b' vira CONCAT('a', 'b') (no MySQL o || e o operador OU).
// Uma sequencia ('a' || 'b' || 'c') vira um unico CONCAT('a', 'b', 'c').
function traduzirConcat(s) {
  const partes = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '|' && s[i + 1] === '|') {
      const esq = lerOperando(s, i, -1);
      if (!esq) { i++; continue; }
      const operandos = [esq.texto];
      let pos = i + 2;
      let ultimoFim = esq.fim;
      for (;;) {
        const dir = lerOperando(s, pos, 1);
        if (!dir) break;
        operandos.push(dir.texto);
        ultimoFim = dir.fim;
        let p = dir.fim;
        while (p < s.length && /\s/.test(s[p])) p++;
        if (s[p] === '|' && s[p + 1] === '|') { pos = p + 2; continue; }
        break;
      }
      partes.push({ inicio: esq.inicio, fim: ultimoFim, texto: `CONCAT(${operandos.join(', ')})` });
      i = ultimoFim;
      continue;
    }
    i++;
  }
  if (!partes.length) return s;
  let saida = '';
  let pos = 0;
  for (const p of partes) {
    saida += s.slice(pos, p.inicio) + p.texto;
    pos = p.fim;
  }
  saida += s.slice(pos);
  return saida;
}

// ---------------------------------------------------------------------------
// DML
// ---------------------------------------------------------------------------

function traduzirOnConflict(s) {
  // ON CONFLICT (colunas) DO UPDATE SET a = excluded.a, b = excluded.b
  // vira ON DUPLICATE KEY UPDATE a = VALUES(a), b = VALUES(b)
  return s.replace(/ON\s+CONFLICT\s*(?:\([^)]*\))?\s*DO\s+UPDATE\s+SET\s+([\s\S]*)$/i, (_, lista) => {
    const novo = lista.replace(/excluded\s*\.\s*([A-Za-z0-9_]+)/gi, (__, col) => `VALUES(\`${col}\`)`);
    return `ON DUPLICATE KEY UPDATE ${novo}`;
  });
}

function traduzirDML(s) {
  let saida = s;
  saida = saida.replace(/\bINSERT\s+OR\s+IGNORE\b/gi, 'INSERT IGNORE');
  saida = saida.replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/gi, 'REPLACE INTO');
  saida = saida.replace(/\bINSERT\s+OR\s+REPLACE\b/gi, 'REPLACE');
  saida = saida.replace(/\bINSERT\s+OR\s+([A-Za-z]+)\b/gi, 'INSERT $1');
  saida = traduzirOnConflict(saida);
  saida = saida.replace(/\brandom\s*\(\s*\)/gi, 'RAND()');
  saida = saida.replace(/\bCOLLATE\s+NOCASE\b/gi, 'COLLATE utf8mb4_general_ci');
  saida = saida.replace(/\bgroup_concat\s*\(/gi, 'GROUP_CONCAT(');
  // group_concat(x, ' | ') -> GROUP_CONCAT(x SEPARATOR ' | ')
  saida = saida.replace(/GROUP_CONCAT\s*\(([^()]*?),\s*(\u0001\d+\u0001)\s*\)/gi, 'GROUP_CONCAT($1 SEPARATOR $2)');
  saida = traduzirConcat(saida);
  return saida;
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

// Tipo da coluna no MySQL, conforme o tipo do SQLite e o uso da coluna.
function tipoMySQL(tipo, opcoes) {
  const t = String(tipo).toUpperCase().trim();
  if (/^(INT|INTEGER|BIGINT|SMALLINT|TINYINT)$/.test(t)) return 'INT';
  if (/^(REAL|DOUBLE|FLOAT)(\s+PRECISION)?$/.test(t)) return 'DOUBLE';
  if (/^(NUMERIC|DECIMAL)$/.test(t)) return 'DECIMAL(12,2)';
  if (t === 'BLOB') return 'LONGBLOB';
  if (t === 'BOOLEAN') return 'TINYINT(1)';
  if (t === 'DATETIME' || t === 'TIMESTAMP') return 'DATETIME';
  if (t === 'DATE') return 'DATE';
  if (/^(TEXT|VARCHAR|CHAR|CLOB)$/.test(t)) {
    if (opcoes.indexada) return 'VARCHAR(191)';
    if (opcoes.temDefault) return 'VARCHAR(255)';
    return 'LONGTEXT';
  }
  return tipo;
}

function nomeColuna(nome) {
  const limpo = String(nome).replace(/^[`"]|[`"]$/g, '');
  return RESERVADAS.has(limpo.toLowerCase()) ? `\`${limpo}\`` : limpo;
}

// Coloca aspas nas palavras reservadas usadas como nome (a coluna 'key').
function citarReservadas(s) {
  // Estas frases usam a palavra KEY como parte delas: nao podem ser alteradas.
  let saida = String(s).replace(/(PRIMARY|DUPLICATE|FOREIGN|UNIQUE)\s+KEY/gi, (__, p) => `${PROTEGE}${p.toUpperCase()}\u0004`);
  for (const palavra of RESERVADAS) saida = saida.replace(new RegExp(`\\b${palavra}\\b`, 'gi'), `\`${palavra}\``);
  return saida.replace(new RegExp(`${PROTEGE}(PRIMARY|DUPLICATE|FOREIGN|UNIQUE)\u0004`, 'g'), (__, p) => `${p} KEY`);
}

// Le as restricoes de uma definicao de coluna.
function lerRestricoes(resto, valores) {
  const notNull = /\bNOT\s+NULL\b/i.test(resto);
  const primaryKey = /\bPRIMARY\s+KEY\b/i.test(resto);
  const unique = /\bUNIQUE\b/i.test(resto);
  const autoInc = /\bAUTOINCREMENT\b/i.test(resto);

  let padrao = null;
  const dm = /\bDEFAULT\b/i.exec(resto);
  if (dm) {
    let p = dm.index + dm[0].length;
    while (p < resto.length && /\s/.test(resto[p])) p++;
    if (resto[p] === '(') {
      const f = fimDaChamada(resto, p);
      padrao = resto.slice(p, f + 1);
    } else {
      const m = /^([\s\S]*?)(?=\s+(?:NOT\s+NULL|NULL|PRIMARY|UNIQUE|CHECK|REFERENCES|COLLATE)\b|$)/i.exec(resto.slice(p));
      padrao = m ? m[1].trim() : null;
    }
  }

  let check = null;
  const cm = /\bCHECK\s*\(/i.exec(resto);
  if (cm) {
    const abre = cm.index + cm[0].length - 1;
    const fecha = fimDaChamada(resto, abre);
    check = resto.slice(cm.index, fecha + 1);
  }

  let ref = null;
  const rm = /\bREFERENCES\s+[\s\S]*$/i.exec(resto);
  if (rm) ref = rm[0].trim();

  return { notNull, primaryKey, unique, autoInc, padrao, check, ref, valores };
}

// Reconhece o padrao de data automatico do SQLite: DEFAULT (datetime('now')).
function tipoDoPadraoDeData(padrao, valores) {
  const m = /^\(\s*(datetime|date)\s*\(\s*(\u0001\d+\u0001)\s*\)\s*\)$/i.exec(String(padrao || '').trim());
  if (!m) return null;
  const valor = valorDoToken(m[2], valores);
  if (valor === null || String(valor).toLowerCase() !== 'now') return null;
  return m[1].toLowerCase() === 'date' ? 'DATE' : 'DATETIME';
}

// Monta a definicao de coluna no dialeto do MySQL.
function montarColuna(nome, tipo, rest, contexto) {
  const r = lerRestricoes(rest, contexto.valores);
  const indexada = r.primaryKey || r.unique || contexto.indexado(nome);
  let tipoFinal = tipoMySQL(tipo, { indexada, temDefault: !!r.padrao });

  // Coluna de data/hora com padrao automatico: vira DATETIME de verdade.
  let padrao = r.padrao;
  if (padrao) {
    const tipoData = tipoDoPadraoDeData(padrao, contexto.valores);
    if (tipoData) {
      tipoFinal = tipoData;
      padrao = tipoData === 'DATE' ? 'CURRENT_DATE' : 'CURRENT_TIMESTAMP';
    }
  }

  const partes = [nomeColuna(nome), tipoFinal];
  if (r.notNull) partes.push('NOT NULL');
  if (padrao) partes.push(`DEFAULT ${padrao}`);
  if (r.autoInc) partes.push('AUTO_INCREMENT');
  if (r.unique && !r.primaryKey) partes.push('UNIQUE');
  if (r.primaryKey) partes.push('PRIMARY KEY');
  if (r.check) partes.push(r.check);
  if (r.ref) partes.push(r.ref);
  return { sql: partes.join(' '), tipo: tipoFinal };
}

// Traduz um CREATE TABLE do SQLite para o MySQL (recebe o SQL original).
function traduzirCreateTable(sql, contexto = {}) {
  const { mascarado, literais, valores } = extrairLiterais(sql);
  const m = /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_`$]+)\s*\(/i.exec(mascarado);
  if (!m) return null;
  const tabela = m[1].replace(/[`$]/g, '');
  const abre = m[0].length - 1;
  const fecha = fimDaChamada(mascarado, abre);
  const corpo = mascarado.slice(abre + 1, fecha);
  const definicoes = separarArgs(corpo);

  // 1a passada: quais colunas fazem parte de uma chave (PK/UNIQUE de tabela).
  const emChave = new Set();
  for (const def of definicoes) {
    const cm = /^\s*(PRIMARY\s+KEY|UNIQUE)\s*\(([^)]*)\)/i.exec(def);
    if (!cm) continue;
    for (const col of cm[2].split(',')) emChave.add(col.trim().replace(/[`"]/g, '').split(/\s+/)[0]);
  }

  const ctx = { valores, indexado: (col) => emChave.has(col) || (contexto.indexado ? contexto.indexado(tabela, col) : false) };
  const colunas = [];
  const restricoes = [];
  for (const def of definicoes) {
    if (!def.trim()) continue;
    if (/^\s*(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|CONSTRAINT)\b/i.test(def)) {
      restricoes.push(citarReservadas(def));
      continue;
    }
    const cm = /^\s*([`"A-Za-z_][`"A-Za-z0-9_]*)\s+([A-Za-z]+)(\s*\([^)]*\))?\s*([\s\S]*)$/.exec(def);
    if (!cm) { restricoes.push(def); continue; }
    const nome = cm[1].replace(/[`"]/g, '');
    const tipo = cm[2] + (cm[3] || '');
    colunas.push(montarColuna(nome, tipo, cm[4] || '', ctx).sql);
  }

  const cabecalho = `CREATE TABLE IF NOT EXISTS \`${tabela}\` (\n  ${colunas.join(',\n  ')}`;
  const corpoFinal = restricoes.length ? `,\n  ${restricoes.join(',\n  ')}` : '';
  const texto = `${cabecalho}${corpoFinal}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`;
  return restaurar(texto, literais);
}

// Traduz um ALTER TABLE (ADD COLUMN). Recebe o SQL original.
function traduzirAlterTable(sql, contexto = {}) {
  const { mascarado, literais, valores } = extrairLiterais(sql);
  const m = /^\s*ALTER\s+TABLE\s+([A-Za-z0-9_`$]+)\s+ADD\s+(COLUMN\s+)?([\s\S]+)$/i.exec(mascarado);
  if (!m) return restaurar(mascarado, literais);
  const tabela = m[1].replace(/[`$]/g, '');
  const cm = /^\s*([`"A-Za-z_][`"A-Za-z0-9_]*)\s+([A-Za-z]+)(\s*\([^)]*\))?\s*([\s\S]*)$/.exec(m[3]);
  if (!cm) return restaurar(mascarado, literais);
  const ctx = { valores, indexado: (col) => (contexto.indexado ? contexto.indexado(tabela, col) : false) };
  const col = montarColuna(cm[1].replace(/[`"]/g, ''), cm[2] + (cm[3] || ''), cm[4] || '', ctx);
  return restaurar(`ALTER TABLE \`${tabela}\` ADD COLUMN ${col.sql}`, literais);
}

// ---------------------------------------------------------------------------
// Traducao principal
// ---------------------------------------------------------------------------

// Traduz um comando (um statement) do SQLite para o MySQL.
// Devolve { sql, modificadores, mostrar } onde:
//   modificadores ... ajustes de data resolvidos com os parametros na execucao
//   mostrar .......... true quando a resposta precisa ser remapeada (SHOW CREATE)
function traduzirComando(sql, contexto = {}) {
  const indexado = contexto.indexado || (() => false);
  const bruto = String(sql || '').trim();
  if (!bruto) return null;

  // SHOW CREATE TABLE: o codigo antigo lia o DDL de sqlite_master.
  const sm = /^SELECT\s+sql\s+FROM\s+sqlite_master\s+WHERE\s+type\s*=\s*'table'\s+AND\s+name\s*=\s*'([^']+)'\s*$/i.exec(bruto);
  if (sm) return { sql: `SHOW CREATE TABLE \`${sm[1]}\``, modificadores: [], mostrar: true };

  // PRAGMA
  const pg = /^PRAGMA\s+(\w+)\s*(=\s*(\w+))?/i.exec(bruto);
  if (pg) {
    const nome = pg[1].toLowerCase();
    if (nome === 'foreign_keys') {
      const valor = String(pg[3] || 'ON').toLowerCase();
      return { sql: `SET FOREIGN_KEY_CHECKS = ${valor === 'off' || valor === '0' ? 0 : 1}`, modificadores: [] };
    }
    return { sql: '', modificadores: [] };
  }

  // DDL (trabalhado no texto original, com os literais visiveis)
  if (/^\s*CREATE\s+TABLE\b/i.test(bruto)) {
    const ddl = traduzirCreateTable(bruto, { indexado });
    return { sql: ddl || bruto, modificadores: [] };
  }
  if (/^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(bruto)) {
    const { mascarado, literais } = extrairLiterais(bruto);
    return { sql: restaurar(mascarado.replace(/IF\s+NOT\s+EXISTS/i, ''), literais), modificadores: [] };
  }
  if (/^\s*ALTER\s+TABLE\b/i.test(bruto)) {
    return { sql: traduzirAlterTable(bruto, { indexado }), modificadores: [] };
  }
  if (/^\s*(DROP\s+TABLE|DROP\s+INDEX)\b/i.test(bruto)) {
    const { mascarado, literais } = extrairLiterais(bruto);
    return { sql: restaurar(mascarado, literais), modificadores: [] };
  }

  // DML (trabalhado no texto mascarado, para nao confundir dados com codigo)
  const { mascarado, literais, valores } = extrairLiterais(bruto);
  const modificadores = [];
  let s = traduzirExpressoes(mascarado, valores, modificadores);
  s = traduzirDML(s);

  // Palavra reservada: 'key' (colunas settings.key e cliente_config.key).
  s = citarReservadas(s);

  return { sql: restaurar(s, literais), modificadores };
}

// Aplica os modificadores que dependem dos parametros da consulta.
// Devolve o SQL final e os indices de parametro que sairam da consulta.
function resolverModificadores(sql, modificadores, params) {
  if (!modificadores || !modificadores.length) return { sql, remover: [] };
  const remover = [];
  let saida = sql;
  for (const mod of modificadores) {
    const valor = params[mod.indice];
    if (mod.tipo === 'is') {
      // "IS ?" vira "IS NULL" (sem parametro) ou "= ?" (mantem o parametro).
      if (valor === undefined || valor === null) {
        remover.push(mod.indice);
        saida = saida.split(mod.marca).join('IS NULL');
      } else {
        saida = saida.split(mod.marca).join('= ?');
      }
      continue;
    }
    remover.push(mod.indice);
    const expressao = aplicarModificador(mod.base, valor === undefined || valor === null ? 'now' : valor);
    saida = saida.split(mod.marca).join(expressao);
  }
  return { sql: saida, remover };
}

module.exports = {
  traduzirComando,
  traduzirDML,
  traduzirExpressoes,
  traduzirDatas: traduzirExpressoes,
  traduzirCreateTable,
  traduzirAlterTable,
  separarComandos,
  extrairLiterais,
  restaurar,
  valorDoToken,
  tipoMySQL,
  aplicarModificador,
  resolverModificadores,
};
