// Ofertas relâmpago: acha o que acabou de entrar em promoção, põe na primeira página e na frente da fila e posta na hora.
// Uma oferta vira relâmpago de dois jeitos:
//  • a própria loja marca (tipo 'loja'): KaBuM!, Amazon e Mercado Livre (pela extensão do Chrome);
//  • o preço de um produto já conhecido despenca para o menor valor em 30 dias (tipo 'queda'). Vale para toda leitura, de qualquer loja.
// O radar é uma rotina leve à parte da mineração: consulta poucas páginas de cada loja, com pausa e sem insistir em bloqueio.
const db = require('./db');
const settings = require('./settings');

for (const [col, tipo] of [['relampago_fim', 'TEXT'], ['relampago_tipo', 'TEXT'], ['relampago_desde', 'TEXT'], ['relampago_fim_real', 'INTEGER NOT NULL DEFAULT 0']]) {
  if (!db.all('PRAGMA table_info(offers)').some(c => c.name === col)) db.db.exec(`ALTER TABLE offers ADD COLUMN ${col} ${tipo}`);
}
if (!db.all('PRAGMA table_info(post_queue)').some(c => c.name === 'prioridade')) db.db.exec('ALTER TABLE post_queue ADD COLUMN prioridade INTEGER NOT NULL DEFAULT 0');
db.db.exec(`
  CREATE INDEX IF NOT EXISTS idx_offers_relampago ON offers (relampago_fim);
  CREATE TABLE IF NOT EXISTS relampago_postados (
    dono TEXT NOT NULL, offer_id INTEGER NOT NULL, desde TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (dono, offer_id, desde)
  );
`);

const HORAS_SEM_FIM = 6;          // quando a loja não informa a hora do fim
const QUEDA_MINIMA = 0.15;        // o preço caiu pelo menos 15% de uma leitura para a outra
const DESCONTO_MINIMO = 20;
const PRECO_MINIMO = 20;
const DIAS_PRODUTO_NOVO = 1;      // produto visto pela primeira vez agora não tem comparação
const MINUTOS_MINIMOS = 10;       // não posta oferta prestes a acabar
const POR_HORA = 10;              // limite de postagens por dono, para não encher os grupos nem arriscar o número
const ESPACO_MIN = 3;             // minutos entre postagens relâmpago
const FILA_MAXIMA = 20;

const sql = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const agora = () => sql(Date.now());
const log = m => console.log(`[RELAMPAGO] ${m}`);

function marcar(id, tipo, fimMs, real, antes) {
  const fim = sql(fimMs);
  const continua = antes?.relampago_fim && antes.relampago_fim > agora();
  db.run(`UPDATE offers SET relampago_fim = ?, relampago_tipo = ?, relampago_fim_real = ?, relampago_desde = ${continua ? 'COALESCE(relampago_desde, datetime(\'now\'))' : "datetime('now')"}, updated_at = datetime('now') WHERE id = ?`,
    fim, tipo, real ? 1 : 0, id);
}
function limpar(id) {
  db.run(`UPDATE offers SET relampago_fim = NULL, relampago_tipo = NULL, relampago_desde = NULL, relampago_fim_real = 0, updated_at = datetime('now') WHERE id = ?`, id);
  db.run(`UPDATE post_queue SET status = 'expirado', resultado = 'A oferta relâmpago terminou antes de ser postada.' WHERE offer_id = ? AND status = 'pendente' AND prioridade = 1`, id);
}

// Queda de verdade: produto já conhecido, preço bem menor que na última leitura e o menor dos últimos 30 dias
function caiuAgora(id, antes, atual, desconto) {
  if (!(Number(antes.preco_atual) > 0) || atual > antes.preco_atual * (1 - QUEDA_MINIMA)) return false;
  if (desconto < DESCONTO_MINIMO || atual < PRECO_MINIMO) return false;
  if (!antes.created_at || antes.created_at > sql(Date.now() - DIAS_PRODUTO_NOVO * 86400000)) return false;
  const min = db.get(`SELECT MIN(price) m FROM price_history WHERE offer_id = ? AND checked_at >= datetime('now', '-30 days')`, id).m;
  return min != null && atual < min;
}

// Chamado a cada oferta gravada (src/offers.js), antes de atualizar o histórico de preços
function aoGravar({ id, antes = null, deal, atual, desconto, fonte }) {
  if (fonte !== 'auto') return;
  if (deal.relampago) {
    const fim = Number(deal.relampago.fim) || 0;
    if (fim && fim <= Date.now()) return;
    marcar(id, 'loja', fim || Date.now() + HORAS_SEM_FIM * 3600000, Boolean(fim), antes);
    return;
  }
  if (!antes) return;
  if (antes.relampago_fim) {
    if (atual > antes.preco_atual * 1.02) limpar(id); // o preço voltou a subir: acabou
    return;
  }
  if (caiuAgora(id, antes, atual, desconto)) marcar(id, 'queda', Date.now() + HORAS_SEM_FIM * 3600000, false, antes);
}

// Terminou: a oferta marcada pela loja sai do ar até a próxima leitura trazer o preço certo. Na queda não há como saber
// se acabou, então só deixa de ser destaque e o preço continua o da última leitura.
function encerrar(id) {
  limpar(id);
  db.run(`UPDATE offers SET last_seen_at = datetime('now', '-30 days') WHERE id = ? AND fonte = 'auto'`, id);
}
function varrer() {
  let saiu = 0;
  for (const o of db.all(`SELECT id, relampago_tipo FROM offers WHERE relampago_fim IS NOT NULL AND relampago_fim <= ?`, agora())) {
    if (o.relampago_tipo === 'loja') { encerrar(o.id); saiu++; } else limpar(o.id);
  }
  if (saiu) require('./busca-ofertas').atualizar().catch(() => {}); // sai do site agora, sem esperar a próxima montagem
  return saiu;
}

const estaAtiva = id => Boolean(db.get('SELECT 1 FROM offers WHERE id = ? AND relampago_fim > ?', id, agora()));

// ── Texto da postagem ─────────────────────────────────────────────────────────
function terminaEm(fim) {
  const d = new Date(`${String(fim).replace(' ', 'T')}Z`);
  const br = new Date(d.getTime() - 3 * 3600000);
  const hoje = new Date(Date.now() - 3 * 3600000);
  const hora = br.toISOString().slice(11, 16);
  return br.toISOString().slice(0, 10) === hoje.toISOString().slice(0, 10) ? `hoje às ${hora}` : `dia ${br.toISOString().slice(8, 10)}/${br.toISOString().slice(5, 7)} às ${hora}`;
}
function textoDaPostagem(o, s) {
  const social = require('./social'), cupons = require('./cupons');
  let t = social.textoPadrao(o, s);
  if (o.cupom_codigo) {
    const nome = cupons.ehMl(o.cupom_codigo) ? (o.cupom_texto || 'cupom') : o.cupom_codigo;
    if (!t.includes(nome)) t = `${t}\n\n🏷️ *Cupom:* ${cupons.paraPost(o.cupom_codigo, o.cupom_texto)}`;
  }
  // O topo "OFERTA RELÂMPAGO" vem do modelo da mensagem (vale em todos os envios); aqui só se o modelo não trouxe
  if (/OFERTA REL[ÂA]MPAGO/i.test(t)) return t;
  const topo = o.relampago_tipo === 'loja'
    ? `⚡🔥 *OFERTA RELÂMPAGO* 🔥⚡${o.relampago_fim_real ? `\n⏰ Termina ${terminaEm(o.relampago_fim)}` : ''}`
    : '⚡🔥 *OFERTA RELÂMPAGO* 🔥⚡\n🚨 O preço caiu agora';
  return `${topo}\n\n${t}`;
}

// ── Postar na hora ────────────────────────────────────────────────────────────
function dentroDoHorario(s) {
  const hhmm = v => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const d = new Date(Date.now() - 3 * 3600000);
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  const ini = hhmm(s.agenda_inicio) ?? 8 * 60, fim = hhmm(s.agenda_fim) ?? 22 * 60;
  return ini <= fim ? min >= ini && min < fim : min >= ini || min < fim;
}

async function despacharDono(cid, suspeitas) {
  const agenda = require('./agenda'), social = require('./social'), whatsapp = require('./whatsapp');
  const clientes = require('./clientes');
  const s = cid ? clientes.config(cid) : settings.getAll();
  if (s.agenda_ativa !== '1' || s.agenda_relampago === '0' || !dentroDoHorario(s)) return { motivo: 'desligado' };
  const redes = agenda.redesAgenda(s).filter(id => !social.REDES[id].pronta(s));
  if (!redes.length) return { motivo: 'sem-rede' };
  const dono = cid ? `c:${cid}` : 'site';
  const ativa = require('./offers').activeClause();
  const limite = sql(Date.now() + MINUTOS_MINIMOS * 60000);
  const lista = db.all(`SELECT o.id, o.produto, o.store_id, o.categoria, o.desconto_pct, o.preco_atual, o.relampago_tipo, o.relampago_fim, o.relampago_desde
      FROM offers o WHERE o.relampago_fim > ? AND o.fonte = 'auto' AND ${ativa.sql}
        AND NOT EXISTS (SELECT 1 FROM relampago_postados p WHERE p.dono = ? AND p.offer_id = o.id AND p.desde = o.relampago_desde)
      ORDER BY CASE o.relampago_tipo WHEN 'loja' THEN 0 ELSE 1 END, o.desconto_pct DESC LIMIT 200`, limite, ...ativa.params, dono);
  const passa = agenda.filtroDoDono(s);
  const repeticao = agenda.regraDeRepeticao(cid, { relampago: true });
  const pagas = cid ? new Set(clientes.lojasComAfiliado(s)) : null;
  const soWhatsapp = redes.length === 1 && redes[0] === 'whatsapp';
  let espaco = FILA_MAXIMA - db.get(`SELECT COUNT(*) n FROM post_queue WHERE status = 'pendente' AND prioridade = 1 AND cliente_id IS ?`, cid).n;
  for (const o of lista) {
    if (espaco <= 0) break;
    if (suspeitas.has(o.id) || o.desconto_pct < 15 || o.desconto_pct > 80 || !passa(o)) continue;
    if (pagas?.size && !pagas.has(o.store_id)) continue;
    if (repeticao.porOferta(o) || repeticao.porProduto(o)) continue;
    if (soWhatsapp && !whatsapp.gruposDaOferta(s, o.categoria, o.store_id).length) continue;
    agenda.enfileirar([{ offer_id: o.id, prioridade: 1 }], 'radar relâmpago', cid);
    db.run('INSERT OR IGNORE INTO relampago_postados (dono, offer_id, desde) VALUES (?, ?, ?)', dono, o.id, o.relampago_desde);
    espaco--;
  }
  // Uma por vez, com intervalo e limite por hora; as outras esperam na frente da fila
  const recentes = db.get(`SELECT COUNT(*) n, MAX(posted_at) u FROM post_queue WHERE prioridade = 1 AND status = 'postado' AND cliente_id IS ? AND posted_at >= datetime('now', '-1 hour')`, cid);
  if (recentes.n >= POR_HORA) return { motivo: 'limite' };
  if (recentes.u && recentes.u > sql(Date.now() - ESPACO_MIN * 60000)) return { motivo: 'intervalo' };
  if (!db.get(`SELECT 1 FROM post_queue WHERE status = 'pendente' AND prioridade = 1 AND cliente_id IS ?`, cid)) return { motivo: 'nada' };
  return agenda.executar('relâmpago', cid, 1, { soRelampago: true });
}

async function despachar() {
  if (!db.get('SELECT 1 FROM offers WHERE relampago_fim > ? LIMIT 1', agora())
    && !db.get(`SELECT 1 FROM post_queue WHERE status = 'pendente' AND prioridade = 1 LIMIT 1`)) return;
  let suspeitas = new Set();
  try { suspeitas = new Set(require('./busca-ofertas').ativas().filter(o => o._susp).map(o => o.id)); } catch { /* lista ainda montando */ }
  const donos = [null, ...db.all(`SELECT id FROM clientes WHERE status = 'ativo' AND validade >= datetime('now')`).map(c => c.id)];
  for (const cid of donos) {
    try { await despacharDono(cid, suspeitas); } catch (err) { log(`postar (${cid || 'site'}): ${err.message}`); }
  }
}

// ── Radar ─────────────────────────────────────────────────────────────────────
// Produtos mais procurados: a lista gira, poucos termos por vez em cada loja
const TERMOS = ['iphone', 'samsung galaxy', 'xiaomi', 'motorola', 'notebook', 'monitor', 'ssd', 'placa de video', 'processador', 'smart tv', 'fone bluetooth',
  'caixa de som', 'playstation', 'xbox', 'nintendo switch', 'cadeira gamer', 'air fryer', 'geladeira', 'fogao', 'micro-ondas', 'maquina de lavar', 'robo aspirador',
  'cafeteira', 'ar condicionado', 'ventilador', 'tenis', 'smartwatch', 'perfume', 'whey', 'creatina', 'furadeira', 'parafusadeira', 'pneu', 'fralda', 'racao'];
const RITMO = {
  kabum: { min: 5, termos: 2 },
  shopee: { min: 10, termos: 2 },
  magalu: { min: 15, termos: 1 },
  aliexpress: { min: 15, termos: 1, lista: true },
  amazon: { min: 20, termos: 0, lista: true },
  mercadolivre: { min: 20, termos: 1, exige: 'ml_client_id', semIsso: 'Sem a API do Mercado Livre: as ofertas vêm pela extensão do Chrome e pela mineração.' },
};
const situacao = new Map(); // loja → { proxima, status, mensagem, em, lidas, relampagos }
const espera = ms => new Promise(r => setTimeout(r, ms));

async function rodarLoja(store, ritmo, s) {
  const offers = require('./offers');
  const st = situacao.get(store.id) || { posicao: Math.floor(Math.random() * TERMOS.length) };
  let lidas = 0, relampagos = 0, status = 'ok', mensagem = '';
  const gravar = deals => {
    for (const deal of deals || []) {
      lidas++;
      try { if (offers.saveDeal(store, deal, { settings: s }) && deal.relampago) relampagos++; } catch (err) { mensagem = err.message; }
    }
  };
  const passos = [];
  if (ritmo.lista && typeof store.radar === 'function') passos.push(() => store.radar(s));
  for (let i = 0; i < ritmo.termos; i++) { const q = TERMOS[st.posicao++ % TERMOS.length]; passos.push(() => store.search(q, s)); }
  for (const [i, passo] of passos.entries()) {
    let r;
    try { r = await passo(); } catch (err) { r = { status: 'error', message: err.message, deals: [] }; }
    if (r.status === 'blocked') { status = 'blocked'; mensagem = r.message || 'A loja recusou a leitura.'; break; }
    if (r.status === 'error') { status = 'error'; mensagem = r.message || ''; }
    gravar(r.deals);
    if (i < passos.length - 1) await espera(2500);
  }
  if (lidas) require('./busca-ofertas').atualizar().catch(() => {}); // aparece no site sem esperar a próxima montagem
  // Bloqueio: não insiste, espera 2 horas
  situacao.set(store.id, { ...st, status, mensagem, em: Date.now(), lidas, relampagos, proxima: Date.now() + (status === 'blocked' ? 120 : ritmo.min) * 60000 });
}

let rodandoRadar = false;
async function radar() {
  if (rodandoRadar || settings.get('relampago_ativo') === '0') return;
  rodandoRadar = true;
  try {
    const { STORES } = require('./stores');
    const s = settings.getAll();
    const ligadas = settings.getEnabledStores();
    const devidas = STORES.filter(store => RITMO[store.id] && ligadas[store.id] !== false);
    await Promise.all(devidas.map(async store => {
      const ritmo = RITMO[store.id];
      const st = situacao.get(store.id);
      if (st?.proxima > Date.now()) return;
      if (!store.isReady(s).ready) return situacao.set(store.id, { ...st, status: 'off', mensagem: store.isReady(s).reason, proxima: Date.now() + 15 * 60000 });
      if (ritmo.exige && !s[ritmo.exige]) return situacao.set(store.id, { ...st, status: 'off', mensagem: ritmo.semIsso, proxima: Date.now() + 15 * 60000 });
      try { await rodarLoja(store, ritmo, s); } catch (err) { log(`${store.name}: ${err.message}`); }
    }));
  } finally { rodandoRadar = false; }
}

function estado() {
  const { STORES } = require('./stores');
  return {
    ativo: settings.get('relampago_ativo') !== '0',
    no_ar: db.get('SELECT COUNT(*) n FROM offers WHERE relampago_fim > ?', agora()).n,
    lojas: STORES.filter(l => RITMO[l.id]).map(l => {
      const st = situacao.get(l.id) || {};
      return { id: l.id, nome: l.name, minutos: RITMO[l.id].min, status: st.status || 'aguardando', mensagem: st.mensagem || '', em: st.em || null, lidas: st.lidas || 0, relampagos: st.relampagos || 0 };
    }),
  };
}

let timer = null;
function iniciar({ radar: comRadar = true, postar = true } = {}) {
  clearInterval(timer);
  const passo = () => {
    try { varrer(); } catch (err) { log(err.message); }
    try { require('./aviso-ml').verificar(); } catch (err) { log(err.message); }
    if (comRadar) radar().catch(err => log(err.message));
    if (postar) despachar().catch(err => log(err.message));
  };
  timer = setInterval(passo, 60 * 1000);
  timer.unref?.();
  setTimeout(passo, 30 * 1000).unref?.();
}

module.exports = { HORAS_SEM_FIM, POR_HORA, aoGravar, varrer, encerrar, estaAtiva, textoDaPostagem, terminaEm, dentroDoHorario, despacharDono, despachar, radar, estado, iniciar, limpar };
