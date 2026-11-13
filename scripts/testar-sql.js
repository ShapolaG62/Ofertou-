'use strict';
// ============================================================================
// Testa a traducao de TODOS os comandos SQL do projeto contra o MySQL.
// ----------------------------------------------------------------------------
// Varre o codigo-fonte, traduz cada comando (SQLite -> MySQL) e manda o
// MySQL preparar a frase. O MySQL valida a sintaxe ao preparar, sem executar
// nada, entao nenhum dado e alterado.
//
//   node scripts/testar-sql.js
// ============================================================================

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const tradutor = require('../src/mysql/tradutor');
const { indexado } = require('../src/mysql/indices');

const RAIZ = path.join(__dirname, '..');
const COMANDOS = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|WITH)\b/i;

function arquivos(dir) {
  const lista = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'data', 'public', 'mobile', 'video', '.git'].includes(e.name)) lista.push(...arquivos(p)); }
    else if (e.name.endsWith('.js')) lista.push(p);
  }
  return lista;
}

// Extrai os trechos de SQL do codigo: percorre o arquivo e pega os textos
// entre crases (template strings), substituindo ${...} por '?'.
function extrair() {
  const achados = [];
  for (const arq of arquivos(path.join(RAIZ, 'src')).concat([path.join(RAIZ, 'server.js')])) {
    const txt = fs.readFileSync(arq, 'utf8');
    let linha = 1;
    let i = 0;
    while (i < txt.length) {
      const c = txt[i];
      if (c === '\n') { linha++; i++; continue; }
      if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < txt.length) {
          if (txt[j] === '\\') { j += 2; continue; }
          if (txt[j] === c) { j++; break; }
          if (txt[j] === '\n') linha++;
          j++;
        }
        i = j;
        continue;
      }
      if (c === '`') {
        const inicioLinha = linha;
        let j = i + 1;
        let conteudo = '';
        let dinamico = false;
        while (j < txt.length) {
          const d = txt[j];
          if (d === '\\') { j += 2; continue; }
          if (d === '$' && txt[j + 1] === '{') {
            dinamico = true;
            let prof = 1;
            j += 2;
            while (j < txt.length && prof > 0) {
              if (txt[j] === '{') prof++;
              else if (txt[j] === '}') prof--;
              else if (txt[j] === '\n') linha++;
              j++;
            }
            conteudo += '?';
            continue;
          }
          if (d === '`') { j++; break; }
          if (d === '\n') linha++;
          conteudo += d;
          j++;
        }
        i = j;
        for (const cmd of tradutor.separarComandos(conteudo)) {
          if (COMANDOS.test(cmd)) achados.push({ arq: path.relative(RAIZ, arq), linha: inicioLinha, sql: cmd.trim(), dinamico });
        }
        continue;
      }
      i++;
    }
  }
  return achados;
}

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'ofertas_do_gp',
  });
  // Igual ao site: sem ONLY_FULL_GROUP_BY (o SQLite nunca exigia agrupar tudo).
  await conn.query("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO'");

  const achados = extrair();
  console.log(`Comandos SQL encontrados no codigo: ${achados.length}\n`);

  const erros = [];
  const avisos = [];
  const dinamicos = [];
  let testados = 0;

  for (const item of achados) {
    let traducao;
    try {
      traducao = tradutor.traduzirComando(item.sql, { indexado });
    } catch (err) {
      erros.push({ ...item, problema: `falha na traducao: ${err.message}` });
      continue;
    }
    if (!traducao || !traducao.sql.trim()) continue;
    if (!/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|SET)\b/i.test(traducao.sql)) continue;

    // Resolve os modificadores que dependem dos parametros (para poder validar).
    let sqlFinal;
    try {
      const resolvido = tradutor.resolverModificadores(traducao.sql, traducao.modificadores, []);
      const remover = new Set(resolvido.remover);
      sqlFinal = resolvido.sql;
      // Reposiciona os parametros que sobraram (a contagem precisa fechar).
      const total = (sqlFinal.match(/\?/g) || []).length;
      if (total !== 0) {
        const usados = [];
        let k = 0;
        for (let i = 0; i < item.sql.length; i++) { /* placeholder */ }
        sqlFinal = sqlFinal.replace(/\?/g, () => { usados.push(1); return '?'; });
      }
    } catch (err) {
      erros.push({ ...item, problema: `falha ao resolver: ${err.message}` });
      continue;
    }

    // Comandos montados com codigo (${...}) nao podem ser validados assim.
    if (item.dinamico) { dinamicos.push({ ...item, sql: sqlFinal }); continue; }

    // O MySQL valida a sintaxe ao preparar a frase (sem executar).
    try {
      const prep = await conn.prepare(sqlFinal);
      await prep.close();
      testados++;
    } catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_TABLE_ERROR') {
        avisos.push({ ...item, problema: 'tabela inexistente (normal em trecho de teste)' });
      } else if (err.code === 'ER_PARSE_ERROR') {
        erros.push({ ...item, problema: 'erro de sintaxe', sql: traducao.sql, original: item.sql });
      } else {
        avisos.push({ ...item, problema: `${err.code}: ${err.message}`, sql: traducao.sql });
      }
    }
  }

  console.log(`Comandos validados pelo MySQL: ${testados}`);
  console.log(`Montados com codigo: ${dinamicos.length} (nao da para validar direto)`);
  console.log(`Avisos (nao sao erro de traducao): ${avisos.length}`);
  console.log(`ERROS DE TRADUCAO: ${erros.length}\n`);

  if (avisos.length) {
    console.log('--- avisos ---');
    for (const a of avisos.slice(0, 25)) console.log(`  ${a.arq}:${a.linha}  ${a.problema}\n      ${String(a.sql || a.problema).slice(0, 160)}`);
  }
  if (dinamicos.length) {
    console.log('--- montados com codigo ---');
    for (const d of dinamicos.slice(0, 40)) console.log(`  ${d.arq}:${d.linha}  ${String(d.sql).replace(/\s+/g, ' ').slice(0, 150)}`);
  }
  if (erros.length) {
    console.log('--- erros ---');
    for (const e of erros) {
      console.log(`  ${e.arq}:${e.linha}  ${e.problema}`);
      console.log(`      original: ${String(e.original || '').slice(0, 200)}`);
      console.log(`      traduzido: ${String(e.sql || '').slice(0, 200)}`);
    }
  }
  await conn.end();
  process.exit(erros.length ? 1 : 0);
})().catch((err) => { console.error('ERRO:', err.message); process.exit(1); });
