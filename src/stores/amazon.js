// Amazon Brasil — lê a página pública de resultados de busca.
// Só aceita produtos que mostram o preço anterior riscado pela própria Amazon.
const cheerio = require('cheerio');
const { http, parseBRL } = require('../util');

const BASE = 'https://www.amazon.com.br';

function parse(html) {
  const $ = cheerio.load(html);
  const deals = [];
  $('[data-component-type="s-search-result"][data-asin]').each((_, el) => {
    const card = $(el);
    const asin = card.attr('data-asin');
    if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) return;

    // Em moda, a Amazon separa a marca ("Olympikus") e o nome do produto em dois títulos.
    const parts = card.find('h2').map((__, h) => ($(h).attr('aria-label') || $(h).text() || '')
      .replace(/^an[úu]ncio patrocinado\s*[–-]\s*/i, '').replace(/\s+/g, ' ').trim()).get().filter(Boolean);
    let title = parts.reduce((a, b) => (b.length > a.length ? b : a), '');
    const brand = parts.find(p => p !== title && p.length <= 40);
    if (brand && !title.toLowerCase().includes(brand.toLowerCase())) title = `${brand} ${title}`;
    const current = parseBRL(card.find('.a-price:not(.a-text-price) .a-offscreen').first().text());
    const previous = parseBRL(card.find('.a-price.a-text-price .a-offscreen').first().text());
    const img = card.find('img.s-image').attr('src');

    if (!title || !current || !previous) return;
    deals.push({
      store_product_id: asin,
      produto: title,
      preco_atual: current,
      preco_anterior: previous,
      imagem: img || null,
      original_url: `${BASE}/dp/${asin}`,
    });
  });
  return deals;
}

async function search(query) {
  const url = `${BASE}/s?k=${encodeURIComponent(query)}`;
  const res = await http.get(url, { validateStatus: () => true });
  const html = String(res.data || '');
  const challenged = /validateCaptcha|captcha|bm-verify|_sec\/verify/i.test(html.slice(0, 20000));
  if (res.status === 503 || (challenged && !html.includes('s-search-result'))) {
    return { status: 'blocked', message: 'A Amazon pediu verificação anti-robô para este IP. Reduza a frequência da mineração ou use a API oficial de associados.', deals: [] };
  }
  if (res.status >= 400) return { status: 'error', message: `HTTP ${res.status}`, deals: [] };
  return { status: 'ok', deals: parse(html) };
}

// Página de ofertas (/gp/goldbox): os produtos vêm em JSON na própria página. Só a oferta do tipo LIGHTNING_DEAL é relâmpago.
function jsonEm(txt, inicio) {
  let d = 0, str = false, esc = false;
  for (let i = inicio; i < txt.length; i++) {
    const c = txt[i];
    if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
    if (c === '"') str = true;
    else if (c === '{') d++;
    else if (c === '}' && !--d) { try { return JSON.parse(txt.slice(inicio, i + 1)); } catch { return null; } }
  }
  return null;
}
function parseOfertas(html) {
  const marca = String(html).indexOf('"productSearchResponse":');
  if (marca < 0) return [];
  const dados = jsonEm(html, html.indexOf('{', marca));
  const deals = [];
  for (const p of dados?.products || []) {
    const atual = Number(p.price?.priceToPay?.price), anterior = Number(p.price?.basisPrice?.price);
    const asin = String(p.asin || '');
    if (!/^[A-Z0-9]{10}$/.test(asin) || !p.title || !(atual > 0) || !(anterior > atual) || p.dealDetails?.state !== 'AVAILABLE') continue;
    const img = p.image?.hiRes || p.image?.lowRes;
    const fim = Number(p.dealDetails?.endTime || p.dealDetails?.dealEndTime) || 0;
    deals.push({
      ...(p.dealDetails?.type === 'LIGHTNING_DEAL' ? { relampago: { fim: fim > 1e12 ? fim : fim ? fim * 1000 : 0 } } : {}),
      store_product_id: asin, produto: String(p.title).trim(), preco_atual: atual, preco_anterior: anterior,
      imagem: img?.baseUrl && img.extension ? `${img.baseUrl}.${img.extension}` : null,
      original_url: `${BASE}/dp/${asin}`,
    });
  }
  return deals;
}
async function radar() {
  const res = await http.get(`${BASE}/gp/goldbox`, { validateStatus: () => true, timeout: 25000 });
  const html = String(res.data || '');
  if (res.status === 503 || /validateCaptcha|bm-verify|_sec\/verify/i.test(html.slice(0, 20000))) {
    return { status: 'blocked', message: 'A Amazon pediu verificação anti-robô para este IP.', deals: [] };
  }
  if (res.status >= 400) return { status: 'error', message: `HTTP ${res.status}`, deals: [] };
  return { status: 'ok', deals: parseOfertas(html) };
}

// Um produto pela página dele (/dp/ASIN): usado pela repostagem quando a mensagem não traz os preços.
// { deal } | { disponivel: false } (sem estoque ou sem preço riscado) | null (não deu para ler)
const entidadesHtml = s => String(s || '').replace(/&#34;|&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
async function lerProduto(asin) {
  if (!/^[A-Z0-9]{10}$/.test(String(asin))) return null;
  const res = await http.get(`${BASE}/dp/${asin}`, { validateStatus: () => true, timeout: 25000 });
  const html = String(res.data || '');
  if (res.status === 404) return { disponivel: false };
  if (res.status >= 400 || /validateCaptcha|bm-verify|_sec\/verify/i.test(html.slice(0, 20000))) return null;
  const titulo = entidadesHtml((/id="productTitle"[^>]*>([^<]+)</.exec(html) || [])[1]);
  const ini = html.indexOf('corePriceDisplay_desktop_feature_div');
  const bloco = ini >= 0 ? html.slice(ini, ini + 8000) : '';
  // Preço a pagar: o texto escondido às vezes vem vazio; então junta a parte inteira e os centavos mostrados
  const pagar = bloco.slice(Math.max(0, bloco.indexOf('priceToPay')));
  const partes = /a-price-whole">([\d.]+)[\s\S]{0,120}?a-price-fraction">(\d{2})/.exec(pagar);
  const atual = partes ? parseBRL(`${partes[1]},${partes[2]}`) : parseBRL((/a-offscreen">\s*(R\$[^<]+)/.exec(pagar) || [])[1] || '');
  const anterior = parseBRL((/De:\s*<\/span>[\s\S]{0,300}?a-offscreen">([^<]+)/.exec(bloco) || /a-text-price"[^>]*data-a-strike="true"[\s\S]{0,200}?a-offscreen">([^<]+)/.exec(bloco) || [])[1] || '');
  const semEstoque = /id="outOfStock"|Atualmente indisponível/i.test(html);
  if (!titulo) return null;
  if (semEstoque || !atual || !(anterior > atual)) return { disponivel: false };
  const img = (/"hiRes":"(https:[^"]+)"/.exec(html) || /id="landingImage"[^>]*src="(https:[^"]+)"/.exec(html) || [])[1] || null;
  return { deal: { store_product_id: asin, produto: titulo, preco_atual: atual, preco_anterior: anterior, imagem: img, original_url: `${BASE}/dp/${asin}` } };
}

module.exports = {
  lerProduto,
  radar,
  parseOfertas,
  id: 'amazon',
  name: 'Amazon',
  method: 'Leitura da busca pública',
  automatic: true,
  isReady: () => ({ ready: true }),
  search,
  affiliateLink(offer, s) {
    const tag = (s.amazon_tag || '').trim();
    const base = `${BASE}/dp/${offer.store_product_id}`;
    return tag ? `${base}?tag=${encodeURIComponent(tag)}` : base;
  },
  matchesUrl: url => /amazon\.com\.br/i.test(url),
  productIdFromUrl: url => (url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i) || [])[1] || null,
};
