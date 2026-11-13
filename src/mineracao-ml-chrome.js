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
  // Termos novos de "Outras pessoas pesquisaram" (uma falha aqui não atrapalha as ofertas)
  try { aprender(q, store.buscasRelacionadas ? store.buscasRelacionadas(html.slice(0, MAX_HTML)) : []); } catch { /* segue */ }
  // Página aberta sem nenhum card: o Mercado Livre mudou a página ou pediu verificação
  const semCards = !deals.length && !/optimizedResponse|ui-search-layout|poly-card/.test(html);
  settings.set(ESTADO, JSON.stringify({
    ...st, buscas: (st.buscas || 0) + 1, encontradas: (st.encontradas || 0) + deals.length, gravadas: (st.gravadas || 0) + gravadas,
    ultima: agora(), ultimo_termo: q,
    ...(semCards ? { erro: 'a busca abriu, mas sem produtos (o Mercado Livre pode ter pedido verificação)', erro_em: agora() } : { erro: null, erro_em: null }),
  }));
  return { encontradas: deals.length, gravadas };
}

// ── Termos novos aprendidos nas buscas ────────────────────────────────────────
// Cada busca do Mercado Livre traz "Outras pessoas pesquisaram" (ex.: "chinelo" → "chinelo nuvem", "chinelo nike").
// Entram na lista de termos só os bons: com categoria no ML (os sem categoria são lixo, tipo "carros motos outros"),
// com pelo menos uma palavra da busca que os trouxe (corta "moldura de canto de teto" na busca de air fryer),
// sem palavra proibida e sem ser quase igual a um termo que já existe ("air frayer" ≈ "air fryer").
// Limites do painel: quantos por dia e o tamanho máximo da lista (cada termo a mais deixa a volta mais longa).
const NOVOS = 'ml_chrome_novos'; // { dia, hoje, total, ultimos: [{ q, origem, em }] } (interna)
const semAcento = v => String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const palavrasDe = v => semAcento(v).split(' ').filter(p => p.length >= 3);
function distancia(a, b) { // Levenshtein: quantas letras mudam de um para o outro
  if (Math.abs(a.length - b.length) > 2) return 3;
  let ant = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(ant[j] + 1, cur[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    ant = cur;
  }
  return ant[b.length];
}
function aprender(origem, relacionadas) {
  if (settings.get('ml_chrome_aprender') === '0' || !relacionadas?.length) return [];
  const porDia = Math.min(Math.max(parseInt(settings.get('ml_chrome_novos_por_dia') ?? '30', 10) || 0, 0), 500);
  const maximo = Math.min(Math.max(parseInt(settings.get('ml_chrome_termos_max') ?? '1000', 10) || 0, 0), 5000);
  const hoje = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10); // dia em Brasília
  const st = ler(NOVOS, {});
  const feitosHoje = st.dia === hoje ? st.hoje || 0 : 0;
  const termos = settings.getSearchTerms();
  let vagas = Math.min(porDia - feitosHoje, maximo - termos.length);
  if (vagas <= 0) return [];
  const existentes = termos.map(t => semAcento(t.query));
  const daOrigem = new Set(palavrasDe(origem));
  const cat = (termos.find(t => t.query === origem) || {}).cat || null;
  const proibidas = require('./palavras-proibidas');
  const novos = [];
  for (const { q, categoria } of relacionadas) {
    if (vagas <= 0) break;
    const n = semAcento(q);
    if (!categoria || n.length < 3 || n.length > 60 || /^\d+$/.test(n)) continue;
    if (!palavrasDe(n).some(p => daOrigem.has(p))) continue;
    if (existentes.some(e => e === n || distancia(e, n) <= 2) || novos.some(x => distancia(semAcento(x), n) <= 2)) continue;
    if (proibidas.bloqueia(n)) continue;
    novos.push(q.trim().toLowerCase().slice(0, 60));
    vagas--;
  }
  if (!novos.length) return [];
  const atual = String(settings.get('search_terms') || '').replace(/\s+$/, '');
  settings.set('search_terms', `${atual}\n${novos.map(q => (cat ? `${q} | ${cat}` : q)).join('\n')}`);
  const em = new Date().toISOString();
  settings.set(NOVOS, JSON.stringify({
    dia: hoje, hoje: feitosHoje + novos.length, total: (st.total || 0) + novos.length,
    ultimos: [...novos.map(q => ({ q, origem, em })), ...(st.ultimos || [])].slice(0, 50),
  }));
  return novos;
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
    novos: (() => { const n = ler(NOVOS, {}); const hoje = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
      return { ligado: settings.get('ml_chrome_aprender') !== '0', hoje: n.dia === hoje ? n.hoje || 0 : 0, total: n.total || 0, ultimos: (n.ultimos || []).slice(0, 8) }; })(),
  };
}

module.exports = { proximos, receber, priorizar, estado, aprender, urlDaBusca, MAX_HTML };
