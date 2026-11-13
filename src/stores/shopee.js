// Shopee — somente pela API oficial do programa Shopee Afiliados (affiliate.shopee.com.br > Open API).
// A Shopee bloqueia a leitura do site por robôs, então sem App ID + Senha da API não há coleta automática.
const crypto = require('crypto');
const { http, round2, sleep } = require('../util');

const ENDPOINT = 'https://open-api.affiliate.shopee.com.br/graphql';

// Cada termo pede 3 listas (relevância págs. 1 e 2 + mais vendidos), até 150 produtos: termos amplos
// como "infantil" ou "vestido" têm milhares de anúncios e só a 1ª página deixava muita oferta de fora.
const LISTAS = [{ sortType: 1, page: 1 }, { sortType: 1, page: 2 }, { sortType: 2, page: 1 }];

const CAMPOS = 'itemId productName priceMin priceMax priceDiscountRate imageUrl productLink offerLink commissionRate sellerCommissionRate sales ratingStar';

// A Shopee informa o preço atual e o percentual de desconto anunciado; o preço "de" é derivado deles.
function ofertaDe(n) {
  const price = Number(n.priceMin);
  const rate = Number(n.priceDiscountRate);
  if (!price || !rate || rate <= 0 || rate >= 100) return null;
  return {
    store_product_id: String(n.itemId),
    produto: n.productName,
    preco_atual: price,
    preco_anterior: round2(price / (1 - rate / 100)),
    imagem: n.imageUrl,
    original_url: n.productLink,
    affiliate_url: n.offerLink || null,
    // Comissão: commissionRate = total; sellerCommissionRate = a extra ("Comissão Xtra") paga pelo vendedor
    comissao_pct: n.commissionRate != null ? Number(n.commissionRate) * 100 : null,
    comissao_extra_pct: n.sellerCommissionRate != null ? Number(n.sellerCommissionRate) * 100 : null,
    // Prova social: quantos já venderam e a nota (0 a 5)
    vendidos: n.sales != null ? Number(n.sales) : null,
    avaliacao: Number(n.ratingStar) || null,
  };
}

const ehLink = q => /^(https?:\/\/)?([a-z0-9-]+\.)*(shopee\.com\.br|shp\.ee)\//i.test(String(q).trim());
// Formatos: nome-i.<loja>.<produto>, /product/<loja>/<produto> e /opaanlp/<loja>/<produto> (destino dos links curtos)
const idDoLink = url => (String(url).match(/i\.(\d+)\.(\d+)/) || String(url).match(/\/(\d{3,})\/(\d{3,})(?:[/?#]|$)/) || [])[2] || null;

// Busca pontual com o link do produto: a busca por palavras da Shopee não entende links, então consulta pelo código.
async function porLink(url, s) {
  let id = idDoLink(url);
  if (!id) { // link curto (shp.ee / s.shopee.com.br): lê só o endereço para onde ele redireciona
    const r = await http.get(/^https?:/i.test(url) ? url : `https://${url}`, { maxRedirects: 0, validateStatus: () => true }).catch(() => null);
    id = idDoLink(r?.headers?.location || '');
  }
  if (!id) return { status: 'error', message: 'não achei o código do produto nesse link', deals: [] };
  const d = await gql(`{ productOfferV2(itemId: ${id}, limit: 1) { nodes { ${CAMPOS} } } }`, s);
  const n = d.productOfferV2?.nodes?.[0];
  if (!n) return { status: 'ok', deals: [], message: 'a API de afiliados não tem esse produto' };
  const oferta = ofertaDe(n);
  if (!oferta) return { status: 'ok', deals: [], message: 'a Shopee não informa desconto nesse produto (cupom não conta)' };
  return { status: 'ok', deals: [oferta], message: `via link do produto (${n.priceDiscountRate}% de desconto)` };
}

async function search(query, s) {
  if (ehLink(query)) return porLink(String(query).trim(), s);
  const vistos = new Set();
  const deals = [];
  let erro = null, semPagina2 = false;
  for (const l of LISTAS) {
    if (l.page === 2 && semPagina2) continue; // poucos resultados: a 2ª página viria vazia
    let d;
    try {
      d = await gql(`{ productOfferV2(keyword: ${JSON.stringify(query)}, sortType: ${l.sortType}, page: ${l.page}, limit: 50) {
        nodes { ${CAMPOS} }
        pageInfo { hasNextPage }
      } }`, s);
    } catch (err) {
      erro = err.message;
      if (!deals.length && l === LISTAS[0]) return { status: 'error', message: erro, deals: [] };
      continue;
    }
    const nodes = d.productOfferV2?.nodes || [];
    for (const n of nodes) {
      const oferta = vistos.has(String(n.itemId)) ? null : ofertaDe(n);
      if (!oferta) continue;
      vistos.add(oferta.store_product_id);
      deals.push(oferta);
    }
    if (l.page === 1 && !d.productOfferV2?.pageInfo?.hasNextPage) semPagina2 = true;
    await sleep(ESPERA_BASE / 2); // um respiro entre as listas: pedidos em sequência rápida dão mais "System Error"
  }
  return { status: 'ok', deals, message: erro ? `via API de afiliados (aviso: ${erro})` : 'via API de afiliados' };
}

// Chamada assinada à API GraphQL do Shopee Afiliados. O "System Error" [10000] é passageiro, mas frequente: em
// 2026-11-13 metade dos pedidos dava esse erro, e com 3 tentativas seguidas (1,5 s e 3 s) 3 de 8 termos se perdiam
// (a rodada terminava com "erro" e ~25 produtos por termo). Com 6 tentativas e espera crescente (2, 4, 8, 16, 30 s),
// 7 de 8 passaram. Os testes zeram a espera.
let ESPERA_BASE = 2000;
const TENTATIVAS = 6;
async function gql(query, s, tentativa = 0) {
  try { return await gqlUmaVez(query, s); } catch (err) {
    if (tentativa >= TENTATIVAS - 1 || !/\[10000\]|System Error/i.test(err.message)) throw err;
    await sleep(Math.min(30000, ESPERA_BASE * 2 ** tentativa));
    return gql(query, s, tentativa + 1);
  }
}

async function gqlUmaVez(query, s) {
  const payload = JSON.stringify({ query });
  const ts = Math.floor(Date.now() / 1000);
  const signature = crypto.createHash('sha256').update(`${s.shopee_app_id}${ts}${payload}${s.shopee_app_secret}`).digest('hex');
  const res = await http.post(ENDPOINT, payload, {
    headers: { 'Content-Type': 'application/json', Authorization: `SHA256 Credential=${s.shopee_app_id}, Timestamp=${ts}, Signature=${signature}` },
    validateStatus: () => true,
  });
  const data = res.data || {};
  if (data.errors?.length) throw new Error(`API Shopee: ${data.errors[0].message}`);
  return data.data || {};
}

// Link de comissão de um produto já minerado, com as chaves de afiliado informadas (usado pelos clientes).
async function gerarLink(url, s) {
  const d = await gql(`mutation { generateShortLink(input: { originUrl: ${JSON.stringify(url)}, subIds: [] }) { shortLink } }`, s);
  const link = d.generateShortLink?.shortLink;
  if (!link) throw new Error('a API da Shopee não devolveu o link');
  return link;
}

module.exports = {
  _paraTestes: ({ espera } = {}) => { if (espera !== undefined) ESPERA_BASE = espera; },
  porLink,
  gerarLink,
  gql,
  id: 'shopee',
  name: 'Shopee',
  method: 'API oficial Shopee Afiliados (relevância + mais vendidos, até 150 por termo)',
  automatic: true,
  isReady: s => (s.shopee_app_id && s.shopee_app_secret)
    ? { ready: true }
    : { ready: false, reason: 'Informe o App ID e a Senha da API do Shopee Afiliados no painel.' },
  search,
  // Sem link da API: usa o ID de afiliado no mesmo formato dos links de afiliado da Shopee (utm_source=an_<ID>).
  affiliateLink(offer, s = {}) {
    const id = String(s.shopee_afiliado_id || '').trim();
    const url = String(offer.original_url || '');
    if (!/^\d{5,20}$/.test(id) || !/^https:\/\/([a-z0-9-]+\.)*shopee\.com\.br\//i.test(url)) return url;
    const u = new URL(url);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'].forEach(k => u.searchParams.delete(k));
    u.searchParams.set('utm_source', `an_${id}`);
    u.searchParams.set('utm_medium', 'affiliates');
    u.searchParams.set('utm_campaign', 'ofertou');
    return u.href;
  },
  matchesUrl: url => /shopee\.com\.br|shp\.ee/i.test(url),
  productIdFromUrl: url => {
    const m = String(url).match(/i\.(\d+)\.(\d+)/) || String(url).match(/product\/(\d+)\/(\d+)/);
    return m ? `${m[1]}.${m[2]}` : null;
  },
};
