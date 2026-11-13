// Shopee: a API de afiliados devolve "System Error" [10000] com frequência; o minerador insiste antes de perder a lista.
const test = require('node:test');
const assert = require('node:assert/strict');
const { http } = require('../src/util');
const shopee = require('../src/stores/shopee');

shopee._paraTestes({ espera: 0 });
const S = { shopee_app_id: '1', shopee_app_secret: 'x' };
const ERRO = { data: { errors: [{ message: 'error [10000]: System Error' }] } };
const no = (id, rate) => ({ itemId: id, productName: `Produto ${id}`, priceMin: '50', priceDiscountRate: rate, imageUrl: 'https://down-br.img.susercontent.com/x',
  productLink: `https://shopee.com.br/x-i.1.${id}`, offerLink: `https://s.shopee.com.br/${id}`, commissionRate: '0.1', sellerCommissionRate: '0', sales: 100, ratingStar: '4.8' });

function simular(respostas) {
  const original = http.post;
  let n = 0;
  http.post = async () => respostas[Math.min(n++, respostas.length - 1)](n);
  return { pedidos: () => n, voltar: () => { http.post = original; } };
}

test('System Error passageiro: tenta de novo (até 6 vezes) e não perde a lista', async () => {
  const ok = { data: { data: { productOfferV2: { nodes: [no(1, 30), no(2, 0)], pageInfo: { hasNextPage: false } } } } };
  const sim = simular([() => ERRO, () => ERRO, () => ERRO, () => ERRO, () => ok]);
  try {
    const r = await shopee.search('chinelo', S);
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.deals.map(d => d.store_product_id), ['1'], 'produto sem desconto informado não é oferta');
    assert.equal(r.deals[0].preco_anterior, 71.43);
  } finally { sim.voltar(); }
});

test('erro que não passa: desiste depois de 6 tentativas e avisa', async () => {
  const sim = simular([() => ERRO]);
  try {
    const r = await shopee.search('chinelo', S);
    assert.equal(r.status, 'error');
    assert.match(r.message, /System Error/);
    assert.equal(sim.pedidos(), 6);
  } finally { sim.voltar(); }
});
