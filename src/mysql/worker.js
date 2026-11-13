'use strict';
// ============================================================================
// Thread que mantem a conexao com o MySQL.
// ----------------------------------------------------------------------------
// O projeto usa o banco de forma sincrona (o node:sqlite e sincrono), entao a
// consulta e feita aqui, numa thread separada, e o processo principal espera o
// resultado. A resposta volta pela memoria compartilhada.
// ============================================================================

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mysql = require('mysql2/promise');
const { CTRL, PEDIDO, RESPOSTA, TAMANHO_P, ESTADO } = require('./protocolo');

const sab = workerData.sab;
const ctrl = new Int32Array(sab, 0, 4);
const area = Buffer.from(sab, CTRL);

let conn = null;
let fecha = null;

function lerPayload() {
  const len = Atomics.load(ctrl, TAMANHO_P);
  return Buffer.from(sab, CTRL, len).toString('utf8');
}

// Escreve a resposta. Se nao couber na memoria compartilhada, gravar num
// arquivo temporario e passar o caminho (respostas muito grandes).
function responder(resposta) {
  const json = JSON.stringify(resposta);
  const buf = Buffer.from(json, 'utf8');
  if (buf.length + CTRL <= sab.byteLength) {
    buf.copy(area, 0);
    Atomics.store(ctrl, TAMANHO_P, buf.length);
    return;
  }
  const arquivo = path.join(os.tmpdir(), `ofertou-mysql-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(arquivo, json);
  const ponteiro = Buffer.from(JSON.stringify({ ok: true, arquivo }), 'utf8');
  ponteiro.copy(area, 0);
  Atomics.store(ctrl, TAMANHO_P, ponteiro.length);
}

function avisar(estado) {
  Atomics.store(ctrl, ESTADO, estado);
  Atomics.notify(ctrl, ESTADO);
}

async function conectar() {
  const cfg = workerData.config;
  conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    charset: 'utf8mb4',
    dateStrings: true,          // as datas voltam como texto 'YYYY-MM-DD HH:MM:SS'
    supportBigNumbers: true,
    bigNumberStrings: false,
    multipleStatements: false,
    timezone: 'Z',
  });
  // Igual ao SQLite: datas em UTC, concatenacao longa e sem exigencia de
  // agrupar todas as colunas (comportamento antigo do MySQL).
  await conn.query("SET SESSION time_zone = '+00:00'");
  await conn.query("SET SESSION group_concat_max_len = 1048576");
  await conn.query("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO'");
}

async function executar(pedido) {
  if (pedido.tipo === 'ping') {
    await conn.ping();
    return { ok: true, linhas: [] };
  }
  if (pedido.tipo === 'exec') {
    const r = await conn.query(pedido.sql);
    return { ok: true, linhas: [], afetadas: r.affectedRows || 0, insertId: Number(r.insertId || 0) };
  }
  const [linhas, campos] = await conn.execute(pedido.sql, pedido.params || []);
  return {
    ok: true,
    linhas,
    campos: campos ? campos.map(c => c.name) : [],
    afetadas: linhas.affectedRows ?? 0,
    insertId: Number(linhas.insertId || 0),
  };
}

async function laco() {
  while (true) {
    // Espera um pedido novo.
    while (Atomics.load(ctrl, PEDIDO) === 0) {
      Atomics.wait(ctrl, PEDIDO, 0, 500);
    }
    Atomics.store(ctrl, PEDIDO, 0);
    let pedido = null;
    try { pedido = JSON.parse(lerPayload()); } catch { /* payload invalido */ }
    let resposta;
    try {
      resposta = await executar(pedido || { tipo: 'ping' });
    } catch (err) {
      resposta = { ok: false, erro: err.message, codigo: err.code || '', sql: err.sql || '' };
    }
    try {
      responder(resposta);
    } catch (err) {
      const msg = Buffer.from(JSON.stringify({ ok: false, erro: `falha ao responder: ${err.message}` }), 'utf8');
      msg.copy(area, 0);
      Atomics.store(ctrl, TAMANHO_P, msg.length);
    }
    Atomics.store(ctrl, RESPOSTA, 1);
    Atomics.notify(ctrl, RESPOSTA);
  }
}

(async () => {
  try {
    await conectar();
    avisar(1);
    await laco();
  } catch (err) {
    const msg = Buffer.from(JSON.stringify({ ok: false, erro: `falha ao conectar no MySQL: ${err.message}` }), 'utf8');
    msg.copy(area, 0);
    Atomics.store(ctrl, TAMANHO_P, msg.length);
    Atomics.store(ctrl, RESPOSTA, 1);
    Atomics.notify(ctrl, RESPOSTA);
    avisar(2);
    fecha = err;
    setTimeout(() => process.exit(1), 50);
  }
})();
