'use strict';
// ============================================================================
// Ponte sincrona com o MySQL.
// ----------------------------------------------------------------------------
// O projeto inteiro usa o banco de forma sincrona (igual ao node:sqlite).
// Para manter esse contrato sem reescrever os ~60 arquivos que usam o banco,
// a consulta roda numa thread separada e o processo principal espera a
// resposta pela memoria compartilhada.
// ============================================================================

const { Worker } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TAMANHO, CTRL, PEDIDO, RESPOSTA, TAMANHO_P, ESTADO } = require('./protocolo');

const ESPERA_MAXIMA = 120000; // 2 minutos: uma consulta travada nao segura o site para sempre

class PonteMySQL {
  constructor(config) {
    this.config = config;
    this.sab = new SharedArrayBuffer(TAMANHO);
    this.ctrl = new Int32Array(this.sab, 0, 4);
    this.area = Buffer.from(this.sab, CTRL);
    this.worker = null;
    this.erro = null;
  }

  // Sobe a thread e espera ela conectar no banco.
  iniciar() {
    this.worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { sab: this.sab, config: this.config },
    });
    this.worker.on('error', (err) => { this.erro = err; });
    this.worker.on('exit', (codigo) => {
      if (codigo !== 0 && !this.erro) this.erro = new Error(`a thread do MySQL encerrou (codigo ${codigo})`);
    });
    const limite = Date.now() + 30000;
    while (Date.now() < limite) {
      const estado = Atomics.load(this.ctrl, ESTADO);
      if (estado === 1) return;
      if (estado === 2) throw new Error(`nao foi possivel conectar no MySQL (${this.config.host}:${this.config.port}/${this.config.database})`);
      Atomics.wait(this.ctrl, ESTADO, estado, 100);
    }
    throw new Error(`tempo esgotado ao conectar no MySQL (${this.config.host}:${this.config.port}/${this.config.database})`);
  }

  // Manda um pedido e espera a resposta (bloqueia a thread principal).
  enviar(pedido) {
    if (this.erro) throw this.erro;
    const dados = Buffer.from(JSON.stringify(pedido), 'utf8');
    if (dados.length + CTRL > this.sab.byteLength) throw new Error('a consulta e grande demais para o banco');
    dados.copy(this.area, 0);
    Atomics.store(this.ctrl, TAMANHO_P, dados.length);
    Atomics.store(this.ctrl, PEDIDO, 1);
    Atomics.notify(this.ctrl, PEDIDO);

    const limite = Date.now() + ESPERA_MAXIMA;
    while (Atomics.load(this.ctrl, RESPOSTA) === 0) {
      const r = Atomics.wait(this.ctrl, RESPOSTA, 0, 1000);
      if (r === 'timed-out' && Date.now() > limite) {
        throw new Error('O MySQL nao respondeu a tempo.');
      }
    }
    Atomics.store(this.ctrl, RESPOSTA, 0);

    const len = Atomics.load(this.ctrl, TAMANHO_P);
    let bruto = Buffer.from(this.sab, CTRL, len).toString('utf8');
    let resposta = JSON.parse(bruto);
    if (resposta.arquivo) {
      // Resposta grande demais para a memoria compartilhada: veio num arquivo.
      bruto = fs.readFileSync(resposta.arquivo, 'utf8');
      try { fs.unlinkSync(resposta.arquivo); } catch { /* ja apagou */ }
      resposta = JSON.parse(bruto);
    }
    if (resposta.ok) return resposta;
    const erro = new Error(resposta.erro || 'erro no MySQL');
    erro.codigo = resposta.codigo || '';
    erro.sql = resposta.sql || '';
    throw erro;
  }

  fechar() {
    try { this.worker?.terminate(); } catch { /* ja encerrada */ }
    this.worker = null;
  }
}

module.exports = { PonteMySQL };
