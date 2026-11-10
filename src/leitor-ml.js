// Leitura de anúncios do Mercado Livre pela extensão do Chrome do administrador.
// A API do Mercado Livre não deixa o site ler anúncios comuns (403 com a chave do aplicativo) e a página pública pede
// verificação de conta quando quem abre é o servidor. No Chrome do administrador, com a extensão, a página abre
// normalmente. Então o site põe o anúncio numa fila; a extensão (a cada minuto, enquanto o Chrome está aberto) lê a
// página e devolve nome, foto e preços. Quem pediu (a repostagem) espera alguns minutos pela resposta.
const crypto = require('crypto');
const db = require('./db');
const settings = require('./settings');

db.db.exec(`
  CREATE TABLE IF NOT EXISTS ml_leituras (
    item TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    pedido_em TEXT NOT NULL DEFAULT (datetime('now')),
    entregue_em TEXT,
    lido_em TEXT,
    dados TEXT,
    erro TEXT,
    tentativas INTEGER NOT NULL DEFAULT 0
  );
`);

const VALIDADE_MIN = 30;         // leitura que serve para quem pedir de novo
const REENTREGA_S = 150;         // entregue à extensão e sem resposta: entrega de novo depois disso
const ATIVA_MIN = 4;             // a extensão perguntou pela fila nesse tempo: está ligada
const CHAVE = 'extensao_leitor_chave';
const ID = /^MLB\d{6,}$/;
const espera = ms => new Promise(r => setTimeout(r, ms));
let ultimoContato = 0;
let pausas = true; // os testes desligam as esperas

// Chave que a extensão usa para falar com o site (entregue só ao Painel do administrador)
function chave() {
  let c = settings.get(CHAVE);
  if (!c) { c = crypto.randomBytes(24).toString('hex'); settings.set(CHAVE, c); }
  return c;
}
function chaveConfere(recebida) {
  const esperada = settings.get(CHAVE);
  const a = Buffer.from(String(recebida || '')), b = Buffer.from(String(esperada || ''));
  return Boolean(esperada) && a.length === b.length && crypto.timingSafeEqual(a, b);
}

const ativa = () => Date.now() - ultimoContato < ATIVA_MIN * 60000;
const estado = () => ({ ativa: ativa(), ultimo: ultimoContato ? new Date(ultimoContato).toISOString() : null });

function lida(item) {
  const r = db.get(`SELECT dados FROM ml_leituras WHERE item = ? AND lido_em >= datetime('now', ?)`, item, `-${VALIDADE_MIN} minutes`);
  if (!r) return null;
  try { return JSON.parse(r.dados); } catch { return null; }
}

function pedir(item, url) {
  if (!ID.test(String(item)) || !/^https:\/\/([a-z0-9-]+\.)*mercadoli(vre|bre)\.com(\.br)?\//i.test(String(url))) return false;
  if (lida(item)) return true;
  db.run(`INSERT INTO ml_leituras (item, url) VALUES (?, ?)
          ON CONFLICT (item) DO UPDATE SET url = excluded.url, pedido_em = datetime('now'), entregue_em = NULL, lido_em = NULL,
            dados = NULL, erro = NULL, tentativas = 0`, item, url);
  return true;
}

// Pede a leitura e espera a extensão. null = a extensão não está ligada ou não leu a tempo.
async function aguardar(item, url, ms = 180000) {
  const ja = lida(item);
  if (ja) return ja;
  if (!ativa() || !pedir(item, url)) return null;
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    await espera(pausas ? 3000 : 20);
    const d = lida(item);
    if (d) return d;
    const r = db.get('SELECT erro, tentativas FROM ml_leituras WHERE item = ?', item);
    if (r?.erro && r.tentativas >= 2) return null;
  }
  return null;
}

// Para a extensão: o que falta ler (até 8 por vez)
function pendentes() {
  ultimoContato = Date.now();
  const itens = db.all(`SELECT item, url FROM ml_leituras WHERE lido_em IS NULL AND tentativas < 3 AND pedido_em >= datetime('now', '-20 minutes')
    AND (entregue_em IS NULL OR entregue_em < datetime('now', ?)) ORDER BY pedido_em LIMIT 8`, `-${REENTREGA_S} seconds`);
  for (const i of itens) db.run(`UPDATE ml_leituras SET entregue_em = datetime('now'), tentativas = tentativas + 1 WHERE item = ?`, i.item);
  return itens;
}

const texto = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const valor = v => { const n = Math.round(Number(v) * 100) / 100; return Number.isFinite(n) && n > 0 && n < 1e7 ? n : null; };

// Da extensão: o que ela leu
function receber(lista) {
  ultimoContato = Date.now();
  let lidos = 0;
  for (const it of (Array.isArray(lista) ? lista : []).slice(0, 20)) {
    const item = String(it?.item || '').toUpperCase();
    if (!ID.test(item) || !db.get('SELECT 1 FROM ml_leituras WHERE item = ?', item)) continue;
    if (it.erro) { db.run('UPDATE ml_leituras SET erro = ? WHERE item = ?', texto(it.erro, 200), item); continue; }
    const dados = {
      produto: texto(it.produto, 200), preco: valor(it.preco), preco_anterior: valor(it.preco_anterior),
      imagem: /^https:\/\/([a-z0-9-]+\.)*mlstatic\.com\//i.test(String(it.imagem || '')) ? String(it.imagem).slice(0, 500) : null,
      disponivel: it.disponivel !== false,
    };
    if (dados.disponivel && (!dados.produto || !dados.preco)) {
      db.run('UPDATE ml_leituras SET erro = ? WHERE item = ?', 'a página não trouxe o nome ou o preço', item);
      continue;
    }
    db.run(`UPDATE ml_leituras SET dados = ?, lido_em = datetime('now'), erro = NULL WHERE item = ?`, JSON.stringify(dados), item);
    lidos++;
  }
  return { lidos };
}

function limpar() { db.run(`DELETE FROM ml_leituras WHERE pedido_em < datetime('now', '-2 days')`); }

const _paraTestes = ({ pausa, contato } = {}) => {
  if (pausa !== undefined) pausas = pausa;
  if (contato !== undefined) ultimoContato = contato;
};

module.exports = { chave, chaveConfere, estado, ativa, pedir, aguardar, pendentes, receber, lida, limpar, _paraTestes };
