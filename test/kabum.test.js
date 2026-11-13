// KaBuM!: até 3 páginas por termo, seguindo só enquanto a página vem cheia e com bastante desconto.
const test = require('node:test');
const assert = require('node:assert/strict');
const { http } = require('../src/util');
const kabum = require('../src/stores/kabum');

kabum._paraTestes({ pausa: 0 });
let seq = 0;
// Produto com desconto (preço antigo maior) ou sem
const produto = desconto => ({ id: ++seq, attributes: { title: `Produto ${seq}`, available: true, price: 100, price_with_discount: desconto ? 80 : 100,
  old_price: desconto ? 120 : 0, images: ['https://images.kabum.com.br/x.jpg'], product_link: `produto-${seq}` } });
const pagina = (comDesconto, semDesconto) => [...Array(comDesconto)].map(() => produto(true)).concat([...Array(semDesconto)].map(() => produto(false)));

function simular(paginas) {
  const original = http.get;
  const pedidas = [];
  http.get = async (url, { params }) => {
    pedidas.push(params.page_number);
    const p = paginas[params.page_number - 1];
    return typeof p === 'number' ? { status: p, data: {} } : { status: 200, data: { data: p || [] } };
  };
  return { pedidas, voltar: () => { http.get = original; } };
}

test('busca as páginas 2 e 3 quando a anterior veio cheia e com bastante desconto', async () => {
  const sim = simular([pagina(50, 10), pagina(40, 20), pagina(30, 30)]);
  try {
    const r = await kabum.search('monitor');
    assert.equal(r.status, 'ok');
    assert.equal(r.deals.length, 120);
    assert.deepEqual(sim.pedidas, [1, 2, 3]);
  } finally { sim.voltar(); }
});

test('para cedo: página com pouco desconto ou incompleta não puxa a seguinte', async () => {
  let sim = simular([pagina(32, 28), pagina(8, 52), pagina(5, 55)]);
  try {
    assert.equal((await kabum.search('fone bluetooth')).deals.length, 40);
    assert.deepEqual(sim.pedidas, [1, 2], 'a 2ª teve só 8: não vai à 3ª');
  } finally { sim.voltar(); }
  sim = simular([pagina(20, 5)]);
  try {
    await kabum.search('termo pequeno');
    assert.deepEqual(sim.pedidas, [1], 'menos de 60 itens: era a última página');
  } finally { sim.voltar(); }
});

test('bloqueio na página 2 não joga fora a 1ª nem marca a loja como bloqueada', async () => {
  let sim = simular([pagina(50, 10), 429]);
  try {
    const r = await kabum.search('monitor');
    assert.equal(r.status, 'ok');
    assert.equal(r.deals.length, 50);
  } finally { sim.voltar(); }
  sim = simular([429]);
  try { assert.equal((await kabum.search('monitor')).status, 'blocked', 'bloqueio logo na 1ª continua avisando'); } finally { sim.voltar(); }
});
