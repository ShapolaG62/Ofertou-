// Termos de marca e modelo aprendidos com as ofertas das lojas com afiliado, num banco temporário (nunca o do site).
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const PASTA = fs.mkdtempSync(path.join(os.tmpdir(), 'ofertou-marca-'));
process.env.DATA_DIR = PASTA;
process.env.DISABLE_MINER = '1';
process.env.DISABLE_AGENDA = '1';

const db = require('../src/db');
assert.ok(db.DB_PATH.startsWith(PASTA), 'os testes só rodam no banco temporário');
const settings = require('../src/settings');
const marca = require('../src/termos-marca');

test.after(() => { try { db.db.close(); } catch { /* */ } try { fs.rmSync(PASTA, { recursive: true, force: true }); } catch { /* */ } });

// Catálogo de mentira: 2.000 ofertas comuns (palavras genéricas aparecem em milhares) + os produtos de verdade do caso
let id = 0;
const o = (produto, store_id, categoria = 'beleza') => ({ id: ++id, produto, store_id, categoria });
function catalogo() {
  const l = [];
  for (let i = 0; i < 2000; i++) l.push(o(`Perfume Masculino Original ${['Amadeirado', 'Floral', 'Citrico'][i % 3]} 100ml modelo${i}`, ['shopee', 'amazon', 'mercadolivre'][i % 3]));
  // O perfume do caso (2026-11-13): "Afnan Supremacy" em lojas diferentes, com o nome em ordens diferentes
  l.push(o('Afnan Supremacy EDP 100ml Perfume Masculino Amadeirado', 'aliexpress'));
  l.push(o('Perfume Afnan Supremacy Collector\'s Edition 100ml', 'shopee'));
  l.push(o('⚡Frete Grátis Perfume Afnan Supremacy Collector\'s Edition', 'shopee'));
  // Já coberto por um termo da lista ("afnan 9pm night out")
  for (const loja of ['shopee', 'amazon', 'mercadolivre']) l.push(o('Afnan 9pm Night Out Extrait de Parfum', loja));
  // Só numa loja: não basta
  for (let i = 0; i < 4; i++) l.push(o('Lattafa Khamrah Eau de Parfum', 'amazon'));
  // Especificação técnica, não marca ("hdmi macho" em várias lojas)
  for (const loja of ['shopee', 'amazon', 'kabum']) l.push(o('Cabo HDMI Macho 2 metros 4K', loja, 'informatica'));
  // Marca de outra categoria, para intercalar
  for (const loja of ['kabum', 'amazon', 'mercadolivre']) l.push(o('JBL Partybox Encore Caixa de Som', loja, 'audio_tv'));
  for (const loja of ['magalu', 'mercadolivre', 'amazon']) l.push(o('Philips Walita Air Fryer 4L', loja, 'cozinha'));
  return l;
}

test('acha marca e modelo que aparecem em lojas diferentes; deixa de fora genérico, especificação e o que já está na lista', async () => {
  const c = (await marca.candidatos(catalogo(), new Set(['shopee', 'amazon', 'mercadolivre', 'aliexpress', 'kabum', 'magalu']))).map(x => x.q);
  assert.ok(c.includes('afnan supremacy'));
  assert.ok(c.includes('jbl partybox') && c.includes('philips walita'));
  assert.ok(!c.some(q => /perfume|masculino|original|100ml|hdmi|macho/.test(q)), 'palavra genérica não forma termo');
  assert.ok(!c.includes('lattafa khamrah'), 'em uma loja só não conta');
});

test('só aprende com lojas que têm afiliado configurado', async () => {
  const c = await marca.candidatos(catalogo(), new Set(['magalu']));
  assert.deepEqual(c.map(x => x.q), ['philips walita'], 'cada termo precisa de pelo menos uma loja com afiliado');
});

test('entra na lista uma vez por dia, uma categoria por vez, sem repetir o que a lista já cobre', async () => {
  settings.set('search_terms', 'perfume arabe | beleza\nafnan 9pm night out | beleza');
  settings.set('shopee_app_id', '1'); settings.set('shopee_app_secret', 'x');   // Shopee com afiliado
  settings.set('amazon_tag', 'minhatag-20');                                       // Amazon com afiliado
  settings.set('termos_marca_aprender', '1');
  settings.set('termos_marca_por_dia', '3');
  settings.set('termos_marca_estado', '{}');
  const novos = await marca.aprender({ ofertas: catalogo() });
  assert.deepEqual(novos, ['jbl partybox', 'philips walita', 'afnan supremacy'], 'primeiro o que está em mais lojas, uma categoria por vez');
  assert.ok(novos.includes('afnan supremacy'), 'o perfume do caso entra');
  assert.ok(!novos.includes('afnan 9pm'), 'já está dentro de "afnan 9pm night out"');
  const termos = settings.getSearchTerms();
  assert.deepEqual(termos.find(t => t.query === 'afnan supremacy'), { query: 'afnan supremacy', cat: 'beleza' }, 'com a categoria das ofertas');
  assert.deepEqual(await marca.aprender({ ofertas: catalogo() }), [], 'uma vez por dia');
  assert.equal(marca.estado().hoje, 3);
  settings.set('termos_marca_aprender', '0');
  assert.deepEqual(await marca.aprender({ ofertas: catalogo(), forcar: true }), [], 'desligado no painel');
});
