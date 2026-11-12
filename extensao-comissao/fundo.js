// Ofertou! — parte da extensão que lê páginas de outros endereços, com a sessão do seu Chrome:
//  • as listas de produtos dos cupons, para o minerador de cupons;
//  • o saldo e as vendas de afiliado do Mercado Livre e da Magalu, para Painel → Ganhos.
// Só lê. Se o portal pedir login ou verificação, para e avisa: quem resolve é você, no próprio portal.
const TEMPO_MAXIMO = 25000;
const DIAS_DE_VENDAS = 180; // o Mercado Livre não aceita períodos bem maiores
const espera = ms => new Promise(r => setTimeout(r, ms));
const RE_BARRADO = /account-verification|negative_traffic|captcha|\/login|\/lgz\//i;

async function buscar(url) {
  const parar = new AbortController();
  const relogio = setTimeout(() => parar.abort(), TEMPO_MAXIMO);
  try {
    const r = await fetch(url, { credentials: 'include', signal: parar.signal });
    if ([401, 403, 429].includes(r.status) || RE_BARRADO.test(r.url)) throw new Error('Entre no portal neste Chrome (ele pediu login ou verificação) e tente de novo.');
    if (!r.ok) throw new Error(`O portal respondeu com o erro ${r.status}.`);
    return await r.text();
  } finally { clearTimeout(relogio); }
}
const buscarJson = async url => JSON.parse(await buscar(url));

// Dados prontos que o Mercado Livre manda na própria página
function estadoDaPagina(html) {
  const marca = html.indexOf('__NORDIC_RENDERING_CTX__');
  if (marca < 0) return null;
  const ini = html.indexOf('{', marca);
  let d = 0, str = false, esc = false;
  for (let i = ini; i >= 0 && i < html.length; i++) {
    const c = html[i];
    if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
    if (c === '"') str = true;
    else if (c === '{') d++;
    else if (c === '}' && !--d) { try { return JSON.parse(html.slice(ini, i + 1)); } catch { return null; } }
  }
  return null;
}
// "205" + "6" = 205,60 (o Mercado Livre manda a parte inteira e os centavos separados)
const valorMl = v => (v?.amount_integer === '' || v?.amount_integer === undefined ? 0 : Number(`${v.amount_integer || 0}.${v.amount_decimal || 0}`) || 0);

function saldoMl(pp) {
  const b = pp?.pendingBalance?.payment_balance;
  if (!b || pp.balanceDegraded) return null;
  const pago = /PAID|PAGO|TRANSFER|COMPLETE|DONE/i;
  const recebido = (pp.receivedPayments?.items || []).filter(x => pago.test(String(x.status || ''))).reduce((t, x) => t + (Number(x.total_earning) || 0), 0);
  const d = pp.pendingBalance.payment_date || {};
  return {
    disponivel: valorMl(b.approved_amount),
    a_liberar: Math.max(valorMl(b.pending_amount), valorMl(b.review_amount)) + valorMl(b.shipping_process_amount),
    recebido: pp.paymentsDegraded ? null : Math.round(recebido * 100) / 100,
    minimo: Number(`${d.minimum_amount_integer || 0}.${d.minimum_amount_decimal || 0}`) || null,
    proximo_pagamento: d.payment_day || null,
  };
}

const dataMl = d => `${new Date(d.getTime() - 3 * 3600000).toISOString().slice(0, 10)}T00:00:00.000-03:00`;
async function vendasMl() {
  const fim = new Date(Date.now() + 86400000), ini = new Date(Date.now() - DIAS_DE_VENDAS * 86400000);
  const q = new URLSearchParams({ metric_tab: 'general', type: 'GENERAL' });
  const base = `https://www.mercadolivre.com.br/affiliate-program/api/dashboard/sales/general?${q}&filter_time_range=${dataMl(ini)}--${dataMl(fim)}`;
  const lista = [];
  for (let pagina = 1; pagina <= 200; pagina++) {
    const j = await buscarJson(`${base}&page=${pagina}`);
    const itens = j.item_list || [];
    for (const v of itens) {
      lista.push({
        externo: `${v.id}-${(String(v.link || '').match(/MLB-?\d+/i) || [v.productName || ''])[0]}`.slice(0, 120),
        data_venda: v.date, pedido: String(v.id || ''), produto: v.productName || '', valor_venda: v.saleValue,
        comissao: v.commissionValue, status: v.status,
      });
    }
    if (!itens.length || lista.length >= (Number(j.total_results) || 0)) break;
    await espera(300);
  }
  return lista;
}

async function mercadoLivre() {
  const html = await buscar('https://www.mercadolivre.com.br/afiliados/payments');
  const pp = estadoDaPagina(html)?.appProps?.pageProps;
  if (!pp) throw new Error('A página Receita não abriu. Entre no Mercado Livre neste Chrome e tente de novo.');
  return { saldo: saldoMl(pp), vendas: await vendasMl() };
}

const MAGALU = 'https://rochelle.magazinevoce.com.br/v1';
async function magalu() {
  const soma = await buscarJson(`${MAGALU}/checkout/commission/summary`);
  const vendas = [];
  let url = `${MAGALU}/showcase/orders`;
  for (let pagina = 0; url && pagina < 50; pagina++) {
    const j = await buscarJson(url);
    // Só o que o Painel precisa: o nome de quem comprou não sai daqui
    for (const o of j.objects || []) {
      vendas.push({
        externo: String(o.id), data_venda: o.created_at, pedido: String(o.ml_order_id || o.id),
        produto: (o.products || []).map(p => p.title).filter(Boolean).join(' + ').slice(0, 200),
        valor_venda: o.total, comissao: o.commission, status: o.billed ? 'confirmada' : 'pendente',
      });
    }
    url = j.meta?.next ? new URL(j.meta.next, `${MAGALU}/`).href : null;
    if (url && new URL(url).hostname !== 'rochelle.magazinevoce.com.br') url = null;
    if (url) await espera(300);
  }
  return { saldo: { disponivel: Number(soma.total_commission) || 0, a_liberar: 0, recebido: null }, vendas };
}

async function lerGanhos() {
  const out = {};
  for (const [id, fn] of [['mercadolivre', mercadoLivre], ['magalu', magalu]]) {
    try { out[id] = await fn(); } catch (err) { out[id] = { erro: String(err?.message || err).slice(0, 200) }; }
  }
  return out;
}

chrome.runtime.onMessage.addListener((m, sender, responder) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (m?.tipo === 'ler-ganhos') {
    lerGanhos().then(responder);
    return true; // a resposta vem depois
  }
  if (m?.tipo !== 'ler-lista') return false;
  let url;
  try { url = new URL(m.url); } catch { responder({ erro: 'endereço inválido' }); return false; }
  if (url.protocol !== 'https:' || url.hostname !== 'lista.mercadolivre.com.br') { responder({ erro: 'endereço fora da lista do Mercado Livre' }); return false; }
  const parar = new AbortController();
  const relogio = setTimeout(() => parar.abort(), TEMPO_MAXIMO);
  fetch(url.href, { credentials: 'include', signal: parar.signal })
    .then(async r => responder({ status: r.status, url: r.url, html: r.ok ? await r.text() : '' }))
    .catch(err => responder({ erro: String(err?.message || err) })) // inclui redirecionamento sem fim: esse cupom é pulado
    .finally(() => clearTimeout(relogio));
  return true;
});

// ── Leitor do Mercado Livre para o site (repostagem de ofertas de outros grupos) ──
// O Mercado Livre não deixa o servidor do site ler anúncios; aqui, no seu Chrome, a página abre normalmente.
// A cada minuto pergunta ao site se há anúncios para ler, lê a página de cada um (com pausa entre eles) e devolve
// nome, foto e preços. Só lê; se o Mercado Livre pedir login ou verificação, para e tenta no minuto seguinte.
const ALARME_LEITOR = 'ofertou-leitor-ml';
const entidades = s => String(s || '').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const numeroBr = s => { const n = Number(String(s).replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : null; };

function anuncioDaPagina(html) {
  const meta = p => entidades((new RegExp(`<meta property="${p}" content="([^"]*)"`).exec(html) || [])[1] || '');
  const titulo = meta('og:title');
  // og:title: "Nome do produto - R$ 47,53" (o preço atual da página)
  const precoTitulo = /\s-\s*R\$\s*([\d.]+(?:,\d{1,2})?)\s*$/.exec(titulo);
  const produto = titulo.replace(/\s-\s*R\$\s*[\d.,]+\s*$/, '').trim();
  const preco = precoTitulo ? numeroBr(precoTitulo[1]) : Number((/"price":\s*([\d.]+)/.exec(html) || [])[1]) || null;
  // Preço riscado: "Antes: 1.340 reais com 50 centavos"
  const antes = /andes-money-amount--previous[^>]*aria-label="Antes:\s*([\d.]+)\s*reais(?:\s*com\s*(\d{1,2})\s*centavos?)?/i.exec(html);
  let anterior = antes ? numeroBr(antes[1]) + (antes[2] ? Number(antes[2]) / 100 : 0) : null;
  if (!anterior) anterior = Number((/"original_price":\s*([\d.]+)/.exec(html) || [])[1]) || null;
  const esgotado = /"availability":"[^"]*OutOfStock/i.test(html) || /Anúncio pausado|Este anúncio foi finalizado|Estoque esgotado/i.test(html);
  return { produto, preco, preco_anterior: anterior, imagem: meta('og:image') || null, disponivel: !esgotado };
}

async function lerFilaDoSite() {
  const { leitorChave: chave, leitorSite: site } = await chrome.storage.local.get(['leitorChave', 'leitorSite']);
  if (!chave || !site) return;
  const cab = { 'X-Ofertou-Chave': chave };
  const r = await fetch(`${site}/api/extensao/ml-pendentes`, { headers: cab, cache: 'no-store' });
  if (!r.ok) return;
  const { itens = [] } = await r.json();
  const lidos = [];
  for (const it of itens.slice(0, 8)) {
    let url;
    try { url = new URL(it.url); } catch { continue; }
    if (url.protocol !== 'https:' || !/(^|\.)mercadolivre\.com\.br$/.test(url.hostname)) continue;
    try { lidos.push({ item: it.item, ...anuncioDaPagina(await buscar(url.href)) }); } catch (err) {
      lidos.push({ item: it.item, erro: String(err?.message || err).slice(0, 200) });
      if (/login|verificação/.test(String(err?.message))) break; // o Mercado Livre pediu verificação: para por agora
    }
    await espera(1500);
  }
  if (lidos.length) {
    await fetch(`${site}/api/extensao/ml-lidos`, { method: 'POST', headers: { ...cab, 'Content-Type': 'application/json' }, body: JSON.stringify({ itens: lidos }) });
  }
  await minerarBuscas(site, cab);
}

// ── Mineração dos anúncios comuns do Mercado Livre ──
// A API do Mercado Livre só deixa o site ler produtos do catálogo; os anúncios comuns de vendedores ficam de fora.
// A cada minuto o site manda alguns termos de busca; aqui, no seu Chrome, a busca abre normalmente e a página volta
// para o site, que lê os produtos com desconto e grava as ofertas. Se o Mercado Livre pedir verificação, para e avisa.
let minerando = false;
function soOsProdutos(html) {
  // Hoje a busca chega com os produtos em blocos de dados (_n.ctx.s["nr"].q("…")): manda só eles
  const blocos = html.match(/_n\.ctx\.s\["nr"\]\.q\("(?:[^"\\]|\\.)*"\)/g);
  if (blocos?.length) return blocos.join('\n').slice(0, 3 * 1024 * 1024);
  const ini = html.indexOf('ui-search-layout');
  const fim = html.lastIndexOf('poly-card');
  if (ini < 0 || fim < 0) return html.slice(0, 3 * 1024 * 1024);
  return html.slice(Math.max(0, html.lastIndexOf('<', ini)), fim + 40000).slice(0, 3 * 1024 * 1024);
}
async function minerarBuscas(site, cab) {
  if (minerando) return;
  minerando = true;
  try {
    const r = await fetch(`${site}/api/extensao/ml-buscas`, { headers: cab, cache: 'no-store' });
    if (!r.ok) return;
    const { buscas = [] } = await r.json();
    for (const b of buscas.slice(0, 10)) {
      let url;
      try { url = new URL(b.url); } catch { continue; }
      if (url.protocol !== 'https:' || url.hostname !== 'lista.mercadolivre.com.br') continue;
      let corpo;
      try { corpo = { query: b.query, html: soOsProdutos(await buscar(url.href)) }; } catch (err) { corpo = { query: b.query, erro: String(err?.message || err).slice(0, 200) }; }
      await fetch(`${site}/api/extensao/ml-busca`, { method: 'POST', headers: { ...cab, 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
      if (corpo.erro) break; // verificação ou erro do Mercado Livre: tenta de novo no próximo minuto
      await espera(5000);
    }
  } finally { minerando = false; }
}

const ligarLeitor = () => chrome.alarms.create(ALARME_LEITOR, { periodInMinutes: 1 });
chrome.runtime.onInstalled.addListener(ligarLeitor);
chrome.runtime.onStartup.addListener(ligarLeitor);
chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARME_LEITOR) lerFilaDoSite().catch(() => {}); });
// O Painel acabou de entregar a chave: lê a fila na hora, sem esperar o minuto
chrome.storage.onChanged.addListener(m => { if (m.leitorChave) { ligarLeitor(); lerFilaDoSite().catch(() => {}); } });
