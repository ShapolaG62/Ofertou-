'use strict';
// ============================================================================
// Le o arquivo .env (opcional) e coloca as variaveis no processo.
// ----------------------------------------------------------------------------
// As variaveis que ja existirem no ambiente tem prioridade (na VPS e mais
// facil usar o ecosystem.config.js do que um arquivo .env).
// ============================================================================

const fs = require('fs');
const path = require('path');

const ARQUIVO = process.env.ENV_FILE || path.join(__dirname, '..', '.env');

try {
  const texto = fs.readFileSync(ARQUIVO, 'utf8');
  for (const linha of texto.split(/\r?\n/)) {
    if (!linha.trim() || linha.trim().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(linha);
    if (!m) continue;
    const chave = m[1];
    let valor = m[2].trim();
    if (valor.length > 1 && ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'")))) {
      valor = valor.slice(1, -1);
    }
    if (process.env[chave] === undefined) process.env[chave] = valor;
  }
} catch { /* sem .env: usa as variaveis do sistema */ }

module.exports = true;
