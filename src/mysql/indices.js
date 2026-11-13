'use strict';
// ============================================================================
// Descobre quais colunas entram em indice.
// ----------------------------------------------------------------------------
// No MySQL uma coluna TEXT (LONGTEXT) nao pode fazer parte de um indice.
// Como o esquema do projeto vem de varias tabelas criadas em arquivos
// diferentes, lemos o proprio codigo-fonte e anotamos as colunas indexadas
// para que virem VARCHAR(191) na hora de criar a tabela.
// ============================================================================

const fs = require('fs');
const path = require('path');

const mapa = new Map(); // tabela -> Set(coluna)

const RE_INDEX = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`\w]+\s+ON\s+[`\w]+\s*\(([^)]*)\)/gi;

function anotar(sql) {
  RE_INDEX.lastIndex = 0;
  let m;
  while ((m = RE_INDEX.exec(sql))) {
    const tabela = /ON\s+([`\w]+)/i.exec(m[0]);
    if (!tabela) continue;
    const nome = tabela[1].replace(/[`]/g, '').toLowerCase();
    if (!mapa.has(nome)) mapa.set(nome, new Set());
    for (const col of m[1].split(',')) {
      const limpo = col.trim().replace(/[`"]/g, '').split(/\s+/)[0];
      if (limpo) mapa.get(nome).add(limpo.toLowerCase());
    }
  }
}

// Varre os arquivos do projeto procurando as definicoes de indice.
function varrer(raiz) {
  const ignorados = new Set(['node_modules', 'data', 'public', 'mobile', 'video', '.git']);
  const pilha = [raiz];
  while (pilha.length) {
    const dir = pilha.pop();
    let entradas = [];
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entradas) {
      if (e.name.startsWith('.') && e.name !== '.env') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!ignorados.has(e.name)) pilha.push(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      try { anotar(fs.readFileSync(p, 'utf8')); } catch { /* arquivo ilegivel */ }
    }
  }
  return mapa;
}

varrer(path.join(__dirname, '..', '..'));

// A coluna entra em algum indice?
function indexado(tabela, coluna) {
  const cols = mapa.get(String(tabela || '').toLowerCase());
  if (!cols) return false;
  return cols.has(String(coluna || '').toLowerCase());
}

module.exports = { indexado, mapa, varrer };
