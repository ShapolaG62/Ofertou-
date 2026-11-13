'use strict';
// ============================================================================
// Migracao dos dados do SQLite para o MySQL.
// ----------------------------------------------------------------------------
// O esquema (as tabelas) e criado pelo proprio site, em src/db.js e nos
// modulos que sobem junto com ele. Este script so copia os dados que ja
// existiam no arquivo data/ofertas.db para o MySQL.
//
//   node scripts/migrar-para-mysql.js            copia os dados
//   node scripts/migrar-para-mysql.js --recriar  apaga o banco MySQL antes
// ============================================================================

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const mysql = require('mysql2/promise');

const RAIZ = path.join(__dirname, '..');
const ARQUIVO_SQLITE = path.join(RAIZ, 'data', 'ofertas.db');
const RECRIAR = process.argv.includes('--recriar');

const CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'ofertas_do_gp',
};

// Os mesmos modulos que o servidor carrega (a ordem importa: cada um cria
// suas tabelas e ajusta as colunas antes de o proximo ser carregado).
const MODULOS = [
  'equipe', 'cargos', 'admin-painel', 'avisos', 'cartoes', 'chat', 'consentimento',
  'cosmeticos', 'ganhos', 'loja-perfil', 'moderacao-chat', 'notificacoes',
  'pedidos-loja', 'perfis', 'planos', 'registro-acesso', 'sac',
  'routes/public', 'routes/admin', 'routes/conta', 'routes/postagens',
  'routes/cliente', 'routes/assinatura', 'routes/app', 'routes/perfil',
  'routes/ganhos', 'routes/chat', 'routes/sac', 'routes/trabalho', 'routes/loja',
];

const LOT = 400;

function log(msg) { console.log(msg); }

(async () => {
  if (!fs.existsSync(ARQUIVO_SQLITE)) {
    console.error('Nao achei o banco antigo em data/ofertas.db');
    process.exit(1);
  }

  // 1. Cria o esquema no MySQL (o mesmo do site).
  log('1/4  criando o esquema no MySQL...');
  const mysql0 = await mysql.createConnection({ ...CONFIG, multipleStatements: true });
  if (RECRIAR) {
    log('     apagando o banco anterior...');
    await mysql0.query(`DROP DATABASE IF EXISTS \`${CONFIG.database}\``);
    await mysql0.query(`CREATE DATABASE \`${CONFIG.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
  } else {
    await mysql0.query(
      `CREATE DATABASE IF NOT EXISTS \`${CONFIG.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`,
    );
  }
  await mysql0.end();

  // O require do banco e dos modulos cria as tabelas (com o esquema atual do site).
  require(path.join(RAIZ, 'src', 'db'));
  for (const mod of MODULOS) require(path.join(RAIZ, 'src', mod));
  log('     esquema pronto.');

  // 2. Copia os dados.
  log('2/4  copiando os dados...');
  const origem = new DatabaseSync(ARQUIVO_SQLITE, { readOnly: true });
  const destino = await mysql.createConnection(CONFIG);
  await destino.query("SET SESSION time_zone = '+00:00'");
  await destino.query('SET SESSION foreign_key_checks = 0');

  const tabelas = origem
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();

  let total = 0;
  for (const t of tabelas) {
    const nome = t.name;
    const linhas = origem.prepare(`SELECT * FROM "${nome}"`).all();
    if (!linhas.length) { log(`     ${nome}: vazia`); continue; }
    const colunas = Object.keys(linhas[0]);
    const listaColunas = colunas.map(c => `\`${c}\``).join(', ');
    const marcadores = colunas.map(() => '?').join(', ');

    // A tabela precisa aceitar todas as colunas do arquivo antigo.
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

    for (let i = 0; i < linhas.length; i += LOT) {
      const lote = linhas.slice(i, i + LOT);
      const valores = [];
      const tuplas = [];
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
      const sql = `INSERT IGNORE INTO \`${nome}\` (${usadas.map(c => `\`${c}\``).join(', ')}) VALUES ${tuplas.join(', ')}`;
      await destino.query(sql, valores.flat());
    }
    total += linhas.length;
    log(`     ${nome}: ${linhas.length} linha(s)${faltando.length ? ` (+${faltando.length} coluna(s) nova(s))` : ''}`);
  }

  // 3. Ajusta os contadores das chaves automaticas.
  log('3/4  ajustando os contadores das chaves...');
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

  // 4. Confere.
  log('4/4  conferindo...');
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

  log(`\nPronto: ${total} linha(s) copiada(s) (${conferidas} conferida(s)).`);
  process.exit(0);
})().catch((err) => {
  console.error('\nERRO:', err.message);
  if (err.sql) console.error(err.sql.slice(0, 500));
  process.exit(1);
});
