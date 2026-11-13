// Mineração do Mercado Livre pelo Chrome do administrador (extensão "Ofertou! Mercado Livre").
// Por que existe: a API oficial do Mercado Livre só deixa o site ler produtos do CATÁLOGO (anúncios de marca).
// Anúncio comum de vendedor (a maioria em moda, casa, calçados...) volta "acesso negado" (403) e a busca pública pede
// verificação anti-robô quando quem abre é o servidor. No Chrome do administrador a busca abre normalmente.
// Então, a cada minuto, a extensão pega aqui alguns termos de busca, abre a busca do Mercado Livre de cada um e devolve
// a página; o site lê os cards (preço, preço riscado, foto) e grava as ofertas como a mineração comum.
const settings = require('./settings');
const offers = require('./offers');

const ESTADO = 'ml_chrome_estado';         // { cursor, buscas, encontradas, gravadas, ultima, ultimo_termo, erro, erro_em } (interna)
const PRIORIDADE = 'ml_chrome_prioridade'; // termos pedidos agora (busca do site, busca pontual do painel): vão na frente
const POR_MINUTO_PADRAO = 4;
const MAX_HTML = 4 * 1024 * 1024;

const loja = () => require('./stores').getStore('mercadolivre');
const ler = (k, pad) => { try { return JSON.parse(settings.get(k) || 'null') ?? pad; } catch { return pad; } };
const agora = () => new Date().toISOString();

function urlDaBusca(query) {
  const slug = String(query).trim().toLowerCase().replace(/\s+/g, '-');
  return `https://lista.mercadolivre.com.br/${encodeURIComponent(slug)}`;
}

function ligada() {
  const n = Number(settings.get('ml_chrome_termos_por_minuto') ?? POR_MINUTO_PADRAO);
  return settings.getEnabledStores().mercadolivre !== false && n > 0;
}

// Termo pedido agora: a extensão busca no próximo minuto
function priorizar(query) {
  const q = String(query || '').trim().slice(0, 100);
  if (!q || /^https?:\/\//i.test(q)) return;
  const lista = ler(PRIORIDADE, []).filter(x => x !== q);
  settings.set(PRIORIDADE, JSON.stringify([q, ...lista].slice(0, 30)));
}

// Termos entregues à extensão que ainda não voltaram: { q, em (ms), vezes }. Termo que não volta em 3 minutos (o Chrome
// desligou a extensão no meio, a busca falhou, o computador dormiu) é entregue de novo, até 3 vezes no total.
const ENTREGUES = 'ml_chrome_entregues';
const VOLTA_MS = 3 * 60000, MAX_VEZES = 3;

// Para a extensão: os próximos termos (primeiro os que não voltaram, depois os pedidos agora, depois o rodízio)
function proximos() {
  if (!ligada()) return [];
  const n = Math.min(Math.max(parseInt(settings.get('ml_chrome_termos_por_minuto') ?? POR_MINUTO_PADRAO, 10) || 0, 0), 10);
  const agoraMs = Date.now();
  const entregues = ler(ENTREGUES, []).filter(e => e && e.q && e.vezes <= MAX_VEZES && agoraMs - e.em < 60 * 60000);
  const escolhidos = [];
  const vezes = new Map();
  for (const e of entregues) {
    if (escolhidos.length >= n) break;
    if (agoraMs - e.em >= VOLTA_MS && e.vezes < MAX_VEZES) { escolhidos.push(e.q); vezes.set(e.q, e.vezes + 1); }
  }
  const fila = ler(PRIORIDADE, []);
  const daFila = fila.filter(q => !escolhidos.includes(q)).slice(0, n - escolhidos.length);
  escolhidos.push(...daFila);
  if (daFila.length) settings.set(PRIORIDADE, JSON.stringify(fila.filter(q => !daFila.includes(q))));
  const termos = settings.getSearchTerms();
  if (escolhidos.length < n && termos.length) {
    const st = ler(ESTADO, {});
    let cursor = (Number(st.cursor) || 0) % termos.length;
    for (let i = 0; escolhidos.length < n && i < termos.length; i++) {
      const q = termos[cursor].query;
      cursor = (cursor + 1) % termos.length;
      if (!escolhidos.includes(q)) escolhidos.push(q);
    }
    settings.set(ESTADO, JSON.stringify({ ...st, cursor }));
  }
  // Anota o que saiu agora (os que não voltaram a tempo e já passaram do limite de vezes são esquecidos)
  const marcados = entregues.filter(e => !escolhidos.includes(e.q) && e.vezes < MAX_VEZES);
  for (const q of escolhidos) marcados.push({ q, em: agoraMs, vezes: vezes.get(q) || 1 });
  settings.set(ENTREGUES, JSON.stringify(marcados.slice(-200)));
  return escolhidos.map(query => ({ query, url: urlDaBusca(query) }));
}
// O termo voltou (com a página ou com erro): sai da lista de entregues
function devolvido(q) {
  const lista = ler(ENTREGUES, []);
  const resto = lista.filter(e => e?.q !== q);
  if (resto.length !== lista.length) settings.set(ENTREGUES, JSON.stringify(resto));
}

// Da extensão: a página de busca de um termo (ou o erro dela)
function receber({ query, html, erro } = {}) {
  const q = String(query || '').trim().slice(0, 100);
  const st = ler(ESTADO, {});
  if (!q) return { encontradas: 0, gravadas: 0 };
  if (erro || typeof html !== 'string' || !html) {
    settings.set(ESTADO, JSON.stringify({ ...st, erro: String(erro || 'a página veio vazia').slice(0, 200), erro_em: agora() }));
    return { encontradas: 0, gravadas: 0 };
  }
  devolvido(q); // voltou com a página (com erro, fica para ser entregue de novo daqui a 3 minutos)
  const store = loja();
  const s = settings.getAll();
  const cat = (settings.getSearchTerms().find(t => t.query === q) || {}).cat || null;
  const deals = store.parseHtml(html.slice(0, MAX_HTML));
  let gravadas = 0;
  for (const deal of deals) {
    try { if (offers.saveDeal(store, deal, { settings: s, catHint: cat })) gravadas++; } catch { /* oferta com problema: segue */ }
  }
  // Página aberta sem nenhum card: o Mercado Livre mudou a página ou pediu verificação
  const semCards = !deals.length && !/optimizedResponse|ui-search-layout|poly-card/.test(html);
  settings.set(ESTADO, JSON.stringify({
    ...st, buscas: (st.buscas || 0) + 1, encontradas: (st.encontradas || 0) + deals.length, gravadas: (st.gravadas || 0) + gravadas,
    ultima: agora(), ultimo_termo: q,
    ...(semCards ? { erro: 'a busca abriu, mas sem produtos (o Mercado Livre pode ter pedido verificação)', erro_em: agora() } : { erro: null, erro_em: null }),
  }));
  return { encontradas: deals.length, gravadas };
}

// Situação para o Painel → Mineração
function estado() {
  const st = ler(ESTADO, {});
  const termos = settings.getSearchTerms().length;
  return {
    ligada: ligada(),
    ativa: require('./leitor-ml').ativa(),
    termos, cursor: termos ? (Number(st.cursor) || 0) % termos : 0,
    buscas: st.buscas || 0, encontradas: st.encontradas || 0, gravadas: st.gravadas || 0,
    ultima: st.ultima || null, ultimo_termo: st.ultimo_termo || null, erro: st.erro || null, erro_em: st.erro_em || null,
  };
}

module.exports = { proximos, receber, priorizar, estado, urlDaBusca, MAX_HTML };
