'use strict';
// ============================================================================
// Merge dos dados do banco antigo (SQLite do .zip) para o MySQL atual.
// ----------------------------------------------------------------------------
// NÃO APAGA NADA do MySQL: usa INSERT IGNORE para inserir só o que não existe
// (chave primária já presente = mantém o registro atual).
//
// Uso:
//   node scripts/merge-antigo-mysql.js <caminho-do-ofertas.db-antigo>
// ============================================================================

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const mysql = require('mysql2/promise');

const ARQUIVO_SQLITE = process.argv[2];
if (!ARQUIVO_SQLITE || !fs.existsSync(ARQUIVO_SQLITE)) {
  console.error('Uso: node scripts/merge-antigo-mysql.js <caminho-do-ofertas.db-antigo>');
  process.exit(1);
}

const RAIZ = path.join(__dirname, '..');
const CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'ofertas_do_gp',
};

const LOT = 400;

function log(msg) { console.log(msg); }

(async () => {
  // Garante que o esquema esteja criado no MySQL (cria só o que faltar).
  require(path.join(RAIZ, 'src', 'db'));

  const origem = new DatabaseSync(ARQUIVO_SQLITE, { readOnly: true });
  const destino = await mysql.createConnection(CONFIG);
  await destino.query("SET SESSION time_zone = '+00:00'");
  await destino.query('SET SESSION foreign_key_checks = 0');

  const tabelas = origem
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();

  let totalCopiadas = 0;
  let totalJExistiam = 0;

  for (const t of tabelas) {
    const nome = t.name;
    const linhas = origem.prepare(`SELECT * FROM "${nome}"`).all();
    if (!linhas.length) { log(`     ${nome}: vazia`); continue; }
    const colunas = Object.keys(linhas[0]);

    // Garante que a tabela exista no MySQL com todas as colunas do antigo.
    const [existentes] = await destino.query(
      'SELECT COLUMN_NAME AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?',
      [nome],
    );
    const tem = new Set(existentes.map(r => r.c));
    const faltando = colunas.filter(c => !tem.has(c));
    for (const col of faltando) {
      await destino.query(`ALTER TABLE \`${nome}\` ADD COLUMN \`${col}\` LONGTEXT NULL`);
    }
    const usadas = faltando.length ? colunas : colunas.filter(c => tem.has(c));
    const listaColunas = usadas.map(c => `\`${c}\``).join(', ');

    let copiadas = 0;
    for (let i = 0; i < linhas.length; i += LOT) {
      const lote = linhas.slice(i, i + LOT);
      const tuplas = [];
      const valores = [];
      for (const linha of lote) {
        const vals = usadas.map(c => {
          const v = linha[c];
          if (v === undefined || v === null) return null;
          if (typeof v === 'boolean') return v ? 1 : 0;
          if (Buffer.isBuffer(v)) return v;
          return v;
        });
        valores.push(vals);
        tuplas.push(`(${usadas.map(() => '?').join(', ')})`);
      }
      const sql = `INSERT IGNORE INTO \`${nome}\` (${listaColunas}) VALUES ${tuplas.join(', ')}`;
      const [resultado] = await destino.query(sql, valores.flat());
      copiadas += resultado.affectedRows || 0;
    }

    totalCopiadas += copiadas;
    totalJExistiam += linhas.length - copiadas;
    log(`     ${nome}: ${copiadas} nova(s) inserida(s), ${linhas.length - copiadas} ja existia(m) (${linhas.length} total no antigo)`);
  }

  // Ajusta os contadores das chaves automáticas.
  await destino.query('SET SESSION foreign_key_checks = 1');
  for (const t of tabelas) {
    const colunas = origem.prepare(`PRAGMA table_info("${t.name}")`).all();
    const pk = colunas.find(c => c.pk);
    if (!pk) continue;
    const auto = pk.name;
    const [max] = await destino.query(`SELECT MAX(\`${auto}\`) AS m FROM \`${t.name}\``);
    const valor = Number(max.m || 0) + 1;
    if (valor > 1) await destino.query(`ALTER TABLE \`${t.name}\` AUTO_INCREMENT = ${valor}`);
  }

  // Conferência final.
  log('\nConferência:');
  let conferidas = 0;
  for (const t of tabelas) {
    const a = origem.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get().n;
    const [linhas] = await destino.query(`SELECT COUNT(*) AS n FROM \`${t.name}\``);
    const b = Number(linhas[0].n);
    if (b !== Number(a)) console.log(`     ATENCAO: ${t.name} tem ${a} no antigo e ${b} no MySQL`);
    conferidas += b;
  }

  await destino.end();
  origem.close();

  log(`\nMerge concluído: ${totalCopiadas} linha(s) copiada(s) do antigo, ${totalJExistiam} ja existia(m) no MySQL.`);
  log(`Total agora no MySQL: ${conferidas} linha(s).`);
  process.exit(0);
})().catch((err) => {
  console.error('\nERRO:', err.message);
  if (err.sql) console.error(err.sql.slice(0, 500));
  process.exit(1);
});
