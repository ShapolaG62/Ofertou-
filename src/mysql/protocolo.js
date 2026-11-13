'use strict';
// Protocolo entre o processo principal e a thread que fala com o MySQL.
// A comunicacao usa uma area de memoria compartilhada (SharedArrayBuffer):
// o processo principal escreve o pedido, a thread responde e avisa por Atomics.

const TAMANHO = 12 * 1024 * 1024; // 12 MB de memoria compartilhada
const CTRL = 16;                   // bytes reservados no inicio para o controle
const PEDIDO = 0;                  // ctrl[0]: 1 = ha pedido para a thread
const RESPOSTA = 1;                // ctrl[1]: 1 = ha resposta para o processo
const TAMANHO_P = 2;               // ctrl[2]: tamanho do payload em bytes
const ESTADO = 3;                  // ctrl[3]: 0 = conectando, 1 = pronto, 2 = erro

module.exports = { TAMANHO, CTRL, PEDIDO, RESPOSTA, TAMANHO_P, ESTADO };
