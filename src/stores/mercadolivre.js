// Mercado Livre — duas fontes:
//  1) API oficial (se o App ID e a Chave secreta do Mercado Livre Developers estiverem no painel):
//     produtos do catálogo com a palavra + mais vendidos da categoria, só os anúncios com preço riscado pelo próprio ML;
//  2) leitura da busca pública (o ML costuma bloquear com "verificação de conta" quando detecta robô).
const cheerio = require('cheerio');
const { http, parseBRL } = require('../util');

const API = 'https://api.mercadolibre.com';
let tokenCache = { token: null, expiresAt: 0, clientId: null };

async function getToken(s) {
  if (tokenCache.token && tokenCache.clientId === s.ml_client_id && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: s.ml_client_id,
    client_secret: s.ml_client_secret,
  });
  const res = await http.post(`${API}/oauth/token`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    validateStatus: () => true,
  });
  if (res.status !== 200 || !res.data.access_token) {
    throw new Error(`token recusado (${res.status}: ${res.data?.message || res.data?.error || 'sem detalhes'})`);
  }
  tokenCache = {
    token: res.data.access_token,
    clientId: s.ml_client_id,
    expiresAt: Date.now() + (Number(res.data.expires_in || 21600) - 300) * 1000,
  };
  return tokenCache.token;
}

// Erro de rede ou demora (timeout) volta como resposta com status 0, em vez de derrubar a busca do termo inteiro.
// "Muitos pedidos" (429) e erro do servidor (5xx) esperam um pouco e tentam de novo: antes o 429 virava "nenhum
// resultado" e o termo inteiro se perdia.
const espera = ms => new Promise(r => setTimeout(r, ms));
const ok = r => r.status === 200 || r.status === 206; // 206 = resposta parcial válida da API
async function apiGet(path, token, params) {
  for (let tentativa = 1; ; tentativa++) {
    let r;
    try { r = await apiGetUmaVez(path, token, params); } catch (err) { r = { status: 0, data: {}, erro: err.message }; }
    const repetir = r.status === 0 || r.status === 429 || r.status >= 500;
    if (!repetir || tentativa >= 4) return r;
    await espera(r.status === 429 ? 1500 * tentativa * tentativa : 800 * tentativa); // 1,5 s, 6 s, 13,5 s
  }
}
async function apiGetUmaVez(path, token, params) {
  const res = await http.get(`${API}${path}`, {
    params,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    validateStatus: () => true,
  });
  return res;
}

// Roda as tarefas com poucas requisições simultâneas e uma pausa curta entre os grupos (a API limita a frequência).
async function inBatches(list, size, fn, pausa = 250) {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(...await Promise.all(list.slice(i, i + size).map(fn)));
    if (i + size < list.length) await espera(pausa);
  }
  return out;
}

// A busca comum (/sites/MLB/search) é recusada para aplicativos (403). Caminho usado:
// termo → mais vendidos das categorias do termo (highlights: de 20, a maioria vira oferta) + produtos do catálogo
// com a palavra (products/search: a maioria não tem vendedor ativo) → anúncios de cada produto.
// Entra só o anúncio mais barato que tenha preço anterior (riscado) informado pelo próprio Mercado Livre.
const POR_TERMO = 80;
async function searchApi(query, s) {
  const token = await getToken(s);
  const produtos = [];
  const somar = ids => { for (const id of ids) if (!produtos.includes(id)) produtos.push(id); };

  // 1º) Mais vendidos das categorias do termo e da categoria "mãe" de cada uma (outros 20 mais vendidos)
  const disc = await apiGet('/sites/MLB/domain_discovery/search', token, { q: query, limit: 3 });
  const categorias = ok(disc) ? [...new Set((disc.data || []).map(d => d.category_id).filter(Boolean))] : [];
  for (const cat of categorias) {
    somar(await destaques(cat, token));
    const mae = await cached(`mae:${cat}`, async () => {
      const c = await apiGet(`/categories/${cat}`, token);
      if (!ok(c)) throw new Error(`categoria ${c.status}`);
      const caminho = c.data.path_from_root || [];
      return caminho.length >= 3 ? caminho[caminho.length - 2].id : null; // não sobe até a raiz (genérica demais)
    }).catch(() => null);
    if (mae) somar(await destaques(mae, token));
  }

  // 2º) Produtos do catálogo com a palavra (completa a lista)
  const porPalavra = await cached(`q:${query}`, async () => {
    const r = await apiGet('/products/search', token, { status: 'active', site_id: 'MLB', q: query, limit: 50 });
    if (!ok(r)) throw new Error(`busca ${r.status}`); // falha não fica guardada: tenta de novo no próximo termo/rodada
    return (r.data.results || []).map(p => p.id).filter(Boolean);
  }).catch(() => []);
  somar(porPalavra);
  if (!produtos.length) throw new Error(`a API não devolveu produtos (${disc.status})`);

  const deals = await inBatches(produtos.slice(0, POR_TERMO), 4, productId => cached(`prod:${productId}`, () => dealFor(productId, token)).catch(() => null));
  return deals.filter(Boolean);
}
async function destaques(cat, token) {
  return cached(`cat:${cat}`, async () => {
    const h = await apiGet(`/highlights/MLB/category/${cat}`, token);
    if (h.status === 404) return [];
    if (!ok(h)) throw new Error(`destaques ${h.status}`);
    return (h.data.content || []).filter(c => c.type === 'PRODUCT').map(c => c.id);
  }).catch(() => []);
}

// ── Varredura das categorias (além dos termos de busca) ──
// Cada categoria do Mercado Livre, em qualquer nível, tem os próprios 20 mais vendidos, e a maioria deles tem preço
// riscado. A cada rodada, percorre um lote da árvore de categorias (as filhas de cada uma entram na fila) e continua de
// onde parou na rodada seguinte; terminada a árvore, recomeça. Assim o site cobre milhares de categorias, não só as
// que os termos de busca alcançam. Lote: Painel → Mineração ("Mercado Livre: categorias varridas por rodada").
const VARREDURA = 'ml_varredura'; // { fila: [ids], ciclo, feitas } (chave interna)
async function varredura(s, { parar = () => false } = {}) {
  const settings = require('../settings');
  const lote = Math.min(Math.max(parseInt(s.ml_categorias_por_rodada ?? '200', 10) || 0, 0), 1000);
  if (!lote || !s.ml_client_id || !s.ml_client_secret) return { deals: [], message: '' };
  const token = await getToken(s);
  let st = {};
  try { st = JSON.parse(settings.get(VARREDURA) || '{}') || {}; } catch { st = {}; }
  let fila = Array.isArray(st.fila) ? st.fila : [];
  if (!fila.length) { // começo de um ciclo: as categorias principais
    const r = await apiGet('/sites/MLB/categories', token);
    if (!ok(r)) throw new Error(`categorias ${r.status}`);
    fila = (r.data || []).map(c => c.id);
    st = { ciclo: (st.ciclo || 0) + 1, feitas: 0 };
  }
  const guardar = () => settings.set(VARREDURA, JSON.stringify({ ...st, fila }));
  const deals = [];
  let feitas = 0;
  while (feitas < lote && fila.length && !parar()) {
    const cat = fila.shift();
    feitas++;
    const c = await cached(`arvore:${cat}`, async () => {
      const r = await apiGet(`/categories/${cat}`, token);
      if (r.status === 404) return [];
      if (!ok(r)) throw new Error(`categoria ${r.status}`);
      return (r.data.children_categories || []).map(f => f.id);
    }).catch(() => null);
    if (c === null) { fila.push(cat); continue; } // falhou agora: volta para o fim da fila
    fila.push(...c);
    const ids = await destaques(cat, token);
    const achados = await inBatches(ids, 4, id => cached(`prod:${id}`, () => dealFor(id, token)).catch(() => null));
    deals.push(...achados.filter(Boolean));
    if (feitas % 10 === 0) { st.feitas = (st.feitas || 0) + 10; guardar(); }
  }
  st.feitas = (st.feitas || 0) + (feitas % 10);
  guardar();
  return { deals, message: `${feitas} categorias varridas (ciclo ${st.ciclo}, ${st.feitas} feitas, ${fila.length} na fila)` };
}

// Vários termos caem na mesma categoria ("fone bluetooth", "fone tws"...): guarda as respostas por 30 min.
// Só guarda o que deu certo (se a função lança erro, nada fica guardado e a próxima vez tenta de novo).
const CACHE_MS = 30 * 60 * 1000;
const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 5000) for (const [k, v] of cache) if (Date.now() - v.at >= CACHE_MS) cache.delete(k);
  return value;
}

// Anúncio mais barato do produto que tenha preço anterior (riscado) informado pelo Mercado Livre.
// "Sem vendedor ativo" (404) é resposta de verdade (guarda null); falha de limite/rede lança erro (não guarda).
async function dealFor(productId, token) {
  const items = await apiGet(`/products/${productId}/items`, token);
  if (items.status === 404) return null;
  if (!ok(items)) throw new Error(`anúncios ${items.status}`);
  const best = (items.data.results || [])
    .filter(i => i.price > 0 && i.original_price > i.price && i.currency_id === 'BRL' && i.condition !== 'used')
    .sort((a, b) => a.price - b.price)[0];
  if (!best) return null;
  const prod = await apiGet(`/products/${productId}`, token);
  if (!ok(prod)) throw new Error(`produto ${prod.status}`);
  if (!prod.data.name) return null;
  const num = String(best.item_id).replace(/^MLB/i, '');
  return {
    store_product_id: best.item_id,
    produto: prod.data.name,
    preco_atual: best.price,
    preco_anterior: best.original_price,
    imagem: (prod.data.pictures?.[0]?.url || '').replace(/^http:/, 'https:') || null,
    original_url: `https://produto.mercadolivre.com.br/MLB-${num}`,
  };
}

function idFromUrl(url) {
  const m = String(url).match(/(MLB)-?(\d{6,})/i);
  return m ? `MLB${m[2]}` : null;
}

// Código do anúncio no link do card da busca. Os links podem ser:
//  • produto.mercadolivre.com.br/MLB-3505290114-nome-_JM (anúncio comum);
//  • www.mercadolivre.com.br/nome/up/MLBU…?pdp_filters=item_id:MLB… (o anúncio está no pdp_filters; MLBU não é anúncio);
//  • www.mercadolivre.com.br/nome/p/MLB…?…wid=MLB… (catálogo: o anúncio está no wid);
//  • click1.mercadolivre.com.br/… (patrocinado: o destino vai dentro do link, com o pdp_filters).
function idDoCard(link) {
  let texto = String(link);
  try { texto = decodeURIComponent(texto); } catch { /* link com % solto: usa como veio */ }
  const doFiltro = texto.match(/item_id:(MLB)(\d{6,})/i) || texto.match(/[?&]wid=(MLB)(\d{6,})/i);
  if (doFiltro) return `MLB${doFiltro[2]}`;
  if (/\/p\/MLB\d/i.test(texto)) return null; // catálogo sem o anúncio no link: o código é do produto, não do anúncio
  const m = texto.match(/(?:^|[/=])MLB-?(\d{6,})/i);
  return m ? `MLB${m[1]}` : null;
}

// ── Dados da busca embutidos na página ──
// A busca do Mercado Livre chega sem os cards no HTML: o navegador monta os produtos a partir de blocos
// _n.ctx.s["nr"].q("0:{…}") com um JSON quase comum: "@65" aponta para a linha "65:{…}", "u" é vazio (undefined),
// e aparecem "$0", "NaN"... Aqui cada linha vira JSON (fora dos textos: @N → referência, outras palavras → null).
const RE_BLOCO_NORDIC = /_n\.ctx\.s\["nr"\]\.q\(("(?:[^"\\]|\\.)*")\)/g;
function linhaNordic(v) {
  let o = '', str = false, esc = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (str) { o += c; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
    if (c === '"') { str = true; o += c; continue; }
    if (/[A-Za-z$@]/.test(c)) {
      let t = c;
      while (/[A-Za-z0-9$@_.]/.test(v[i + 1] || '')) t += v[++i];
      o += /^@\d+$/.test(t) ? `{"$ref":${t.slice(1)}}` : t === 'true' || t === 'false' || t === 'null' ? t : 'null';
      continue;
    }
    o += c;
  }
  return JSON.parse(o);
}
function dadosNordic(html) {
  let texto = '';
  for (const m of String(html).matchAll(RE_BLOCO_NORDIC)) { try { texto += `${JSON.parse(m[1])}\n`; } catch { /* bloco cortado */ } }
  if (!texto) return null;
  const tab = {};
  let n = 0;
  for (const l of texto.split('\n')) {
    if (!l.trim()) continue;
    const m = /^(\d+):/.exec(l);
    try { tab[m ? m[1] : `x${n++}`] = linhaNordic(m ? l.slice(m[0].length) : l); } catch { /* linha que não deu para ler */ }
  }
  // Segue as referências só quando precisa (a página repete muitos pedaços por referência)
  const r = (x, d = 0) => (x && typeof x === 'object' && x.$ref !== undefined && d < 50 ? r(tab[x.$ref], d + 1) : x);
  return { raiz: r(tab['0']), r };
}
function dealsNordic(html) {
  const d = dadosNordic(html);
  if (!d) return [];
  const { r } = d;
  const lista = r(r(r(d.raiz)?.optimizedResponse)?.results);
  if (!Array.isArray(lista)) return [];
  const valor = p => Number(r(p)?.value) || 0;
  const deals = [];
  const vistos = new Set();
  for (const item of lista) {
    const pc = r(r(item)?.polycard);
    const md = r(pc?.metadata);
    const id = String(md?.id || '');
    if (!/^MLB\d{6,}$/.test(id) || vistos.has(id)) continue;
    const comps = (r(pc.components) || []).map(c => r(c));
    const comp = tipo => r(comps.find(c => c?.type === tipo)?.[tipo]);
    const produto = String(comp('title')?.text || '').trim();
    const preco = comp('price');
    const atual = valor(preco?.current_price);
    let anterior = valor(preco?.previous_price);
    if (!anterior) {
      for (const rotulo of r(preco?.price_labels) || []) {
        for (const v of r(r(rotulo)?.values) || []) {
          const p = r(r(v)?.price);
          if (r(v)?.key === 'previous_price' || p?.previous === true) anterior = Number(p?.value) || anterior;
        }
      }
    }
    if (!produto || !(atual > 0) || !(anterior > atual)) continue;
    const foto = r(r(r(pc.pictures)?.pictures)?.[0])?.id;
    const sinal = r(md.signal) || {};
    const vendidos = Number(sinal.sales ?? r(md.tracks)?.sold_quantity);
    vistos.add(id);
    deals.push({
      store_product_id: id,
      produto,
      preco_atual: atual,
      preco_anterior: anterior,
      imagem: /^[\w-]+$/.test(String(foto || '')) ? `https://http2.mlstatic.com/D_Q_NP_2X_${foto}-E.webp` : null,
      original_url: `https://produto.mercadolivre.com.br/MLB-${id.slice(3)}`,
      // Prova social da busca: "+10mil vendidos" e a nota das avaliações
      ...(vendidos >= 0 ? { vendidos } : {}),
      ...(Number(sinal.reviews_rating) > 0 ? { avaliacao: Number(sinal.reviews_rating) } : {}),
    });
  }
  return deals;
}

// Página de busca do Mercado Livre → ofertas (só as que têm preço riscado). Primeiro os dados embutidos na página
// (é assim que ela chega hoje); se não houver, os cards já montados no HTML.
function parseHtml(html) {
  const embutidos = dealsNordic(html);
  if (embutidos.length) return embutidos;
  return parseCards(html);
}

function parseCards(html) {
  const $ = cheerio.load(html);
  const deals = [];
  $('.poly-card, .ui-search-layout__item').each((_, el) => {
    const card = $(el);
    const titleEl = card.find('.poly-component__title, .poly-component__title-wrapper a, .ui-search-item__title').first();
    const title = titleEl.text().trim();
    const link = card.find('a.poly-component__title, .poly-component__title-wrapper a, a.ui-search-link, a[href*="MLB"]').first().attr('href');

    const prev = card.find('s.andes-money-amount--previous, .andes-money-amount--previous').first();
    const curr = card.find('.poly-price__current .andes-money-amount').first();
    const toNumber = node => {
      const frac = node.find('.andes-money-amount__fraction').first().text();
      const cents = node.find('.andes-money-amount__cents').first().text();
      return parseBRL(cents ? `${frac},${cents}` : frac);
    };
    const current = toNumber(curr);
    const previous = toNumber(prev);
    const img = card.find('img').attr('data-src') || card.find('img').attr('src');
    const id = link && idDoCard(link);

    if (!title || !link || !id || !current || !previous) return;
    deals.push({
      store_product_id: id,
      produto: title,
      preco_atual: current,
      preco_anterior: previous,
      imagem: img && /^https:\/\//.test(img) ? img : null,
      // Link direto do anúncio: abre a página certa até para anúncio patrocinado (click1…) e produto com vários vendedores (/up/)
      original_url: `https://produto.mercadolivre.com.br/MLB-${id.slice(3)}`,
    });
  });
  return deals;
}

function isBlocked(res) {
  const html = String(res.data || '');
  const finalUrl = res.request?.res?.responseUrl || '';
  return /suspicious-traffic|account-verification/i.test(finalUrl + html.slice(0, 5000));
}

async function searchHtml(query) {
  const slug = query.trim().toLowerCase().replace(/\s+/g, '-');
  const res = await http.get(`https://lista.mercadolivre.com.br/${encodeURIComponent(slug)}`, { validateStatus: () => true });
  if (isBlocked(res)) {
    return { status: 'blocked', message: 'O Mercado Livre exigiu verificação anti-robô para este IP. Configure a API oficial no painel.', deals: [] };
  }
  if (res.status >= 400) return { status: 'error', message: `HTTP ${res.status}`, deals: [] };
  return { status: 'ok', deals: parseHtml(String(res.data)) };
}

async function search(query, s) {
  if (s.ml_client_id && s.ml_client_secret) {
    // Com a API configurada, uma falha dela fica só neste termo (a mineração segue para os próximos). Não tenta a
    // busca pública: o ML a bloqueia para servidores, e o bloqueio fazia a loja inteira parar.
    try {
      return { status: 'ok', deals: await searchApi(query, s), message: 'via API oficial' };
    } catch (err) {
      return { status: 'error', deals: [], message: `API oficial falhou neste termo: ${err.message}` };
    }
  }
  return searchHtml(query);
}

// Oferta de um produto do catálogo (código MLB do link /p/…) pela API oficial: usada na importação da comissão extra
async function ofertaDoProduto(productId, s) {
  if (!s.ml_client_id || !s.ml_client_secret) return null;
  return dealFor(productId, await getToken(s));
}

// Preço de um anúncio agora, pela API oficial, logo antes de postar. null = não deu para conferir.
async function anuncioAgora(itemId, s) {
  if (!s.ml_client_id || !s.ml_client_secret || !/^MLB\d+$/.test(String(itemId))) return null;
  const r = await apiGet(`/items/${itemId}`, await getToken(s));
  if (r.status === 404) return { disponivel: false };
  if (!ok(r)) return null;
  if (r.data.status !== 'active' || r.data.available_quantity === 0) return { disponivel: false };
  return { preco: Number(r.data.price), anterior: Number(r.data.original_price) || null };
}

// Nome, preços e foto de um anúncio (link MLB-…), pela API oficial. null = não deu para consultar.
async function dadosDoAnuncio(itemId, s) {
  if (!s.ml_client_id || !s.ml_client_secret || !/^MLB\d+$/.test(String(itemId))) return null;
  const r = await apiGet(`/items/${itemId}`, await getToken(s));
  if (r.status === 404) return { disponivel: false };
  if (!ok(r)) return null;
  const d = r.data;
  if (d.status !== 'active' || d.available_quantity === 0) return { disponivel: false };
  if (!(Number(d.original_price) > Number(d.price))) return { disponivel: false }; // sem preço riscado: sem desconto
  const foto = d.pictures?.[0]?.secure_url || d.pictures?.[0]?.url || d.thumbnail || '';
  return {
    store_product_id: d.id, produto: d.title, preco_atual: Number(d.price), preco_anterior: Number(d.original_price),
    imagem: foto.replace(/^http:/, 'https:') || null,
    original_url: `https://produto.mercadolivre.com.br/MLB-${String(d.id).replace(/^MLB/i, '')}`,
  };
}

module.exports = {
  parseHtml,
  dealsNordic,
  idDoCard,
  ofertaDoProduto,
  dadosDoAnuncio,
  anuncioAgora,
  varredura,
  id: 'mercadolivre',
  name: 'Mercado Livre',
  method: 'API oficial (catálogo por palavra + mais vendidos com desconto) ou leitura da busca pública',
  automatic: true,
  isReady: () => ({ ready: true }),
  search,
  affiliateLink(offer, s) {
    const url = new URL(offer.original_url);
    // Links /up/ (produto com vários vendedores) precisam do pdp_filters para abrir o mesmo anúncio da oferta.
    const filtro = url.searchParams.get('pdp_filters');
    url.search = '';
    if (filtro) url.searchParams.set('pdp_filters', filtro);
    if (s.ml_matt_word) url.searchParams.set('matt_word', s.ml_matt_word.trim());
    if (s.ml_matt_tool) url.searchParams.set('matt_tool', s.ml_matt_tool.trim());
    return url.toString();
  },
  matchesUrl: url => /mercadoli(vre|bre)\.com/i.test(url),
  productIdFromUrl: idFromUrl,
};
