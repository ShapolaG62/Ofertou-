// Nota de viral das ofertas para os grupos, num banco temporário (nunca o do site).
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const PASTA = fs.mkdtempSync(path.join(os.tmpdir(), 'ofertou-nota-'));
process.env.DATA_DIR = PASTA;
process.env.DISABLE_MINER = '1';
process.env.DISABLE_AGENDA = '1';

const db = require('../src/db');
assert.ok(db.DB_PATH.startsWith(PASTA), 'os testes só rodam no banco temporário');
require('../src/envio-grupos');
require('../src/repostar-grupos');
const settings = require('../src/settings');
const offers = require('../src/offers');
const { getStore } = require('../src/stores');
const { notaGrupo, contexto } = require('../src/nota-grupos');

test.after(() => { try { db.db.close(); } catch { /* */ } try { fs.rmSync(PASTA, { recursive: true, force: true }); } catch { /* */ } });

const SEM = { aprendido: null, alta: [] };
const nota = (o, ctx = SEM) => notaGrupo({ store_id: 'mercadolivre', preco_anterior: o.preco_atual * 2, desconto_pct: 50, ...o }, ctx).nota;

test('produto de impulso, de marca e muito vendido passa; caro, de nicho ou sem venda fica de fora', () => {
  const viral = nota({ produto: 'Fone de Ouvido JBL Tune 520BT Bluetooth', preco_atual: 69.9, _v: 12000, _a: 4.8, imagem: 'https://http2.mlstatic.com/x.webp' });
  const nicho = nota({ produto: 'Processador AMD Ryzen 5 5500 3.6GHz', preco_atual: 589, preco_anterior: 700, desconto_pct: 16 });
  const semVenda = nota({ produto: 'Camisa Social Masculina Slim', preco_atual: 66, preco_anterior: 80, desconto_pct: 18, _v: 2, _a: 3.6 });
  assert.ok(viral >= 80, `viral: ${viral}`);
  assert.ok(nicho < 40, `nicho: ${nicho}`);
  assert.ok(semVenda < 30, `sem venda: ${semVenda}`);
});

test('marca de referência ou imitação não conta como marca', () => {
  const base = { preco_atual: 50, store_id: 'shopee' };
  const original = notaGrupo({ ...base, produto: 'Caixa de Som Echo Dot 5ª Geração Alexa', preco_anterior: 100, desconto_pct: 50 }, SEM);
  const imitacao = notaGrupo({ ...base, produto: 'Alaxe Echo Dot 5ª Geração Caixa de Som', preco_anterior: 100, desconto_pct: 50 }, SEM);
  const capinha = notaGrupo({ ...base, produto: 'Kit para iPhone Carregador por Indução', preco_anterior: 100, desconto_pct: 50 }, SEM);
  assert.ok(original.motivos.some(m => /marca famosa/.test(m)));
  assert.ok(!imitacao.motivos.some(m => /marca famosa|procurado/.test(m)) && imitacao.motivos.some(m => /imitação/.test(m)));
  assert.ok(!capinha.motivos.some(m => /marca famosa|procurado/.test(m)));
  assert.ok(original.nota - imitacao.nota >= 20);
});

test('o que outros grupos estão postando agora sobe', () => {
  for (let i = 0; i < 2; i++) db.run(`INSERT INTO repostar_registro (cliente_id, produto, situacao) VALUES (NULL, ?, 'postada')`, 'SSD Kingston NV3 1TB M.2 2280 PCIe 4.0');
  const ctx = contexto();
  const o = { produto: 'SSD Kingston NV3 1TB NVMe M.2', preco_atual: 399 };
  assert.ok(nota(o, ctx) - nota(o) >= 20);
  assert.ok(notaGrupo({ ...o, preco_anterior: 600, desconto_pct: 33, store_id: 'amazon' }, ctx).motivos.some(m => /outros grupos/.test(m)));
});

test('aprende com os cliques dos seus grupos: tema e loja que não dão clique descem', () => {
  const inserir = (categoria, store_id, n, cliques) => {
    for (let i = 0; i < n; i++) {
      db.run(`INSERT INTO envio_grupo (token, offer_id, categoria, store_id, grupo_id, situacao, cliques) VALUES (?, 1, ?, ?, 'g', 'enviado', ?)`,
        `t${categoria}${store_id}${i}`, categoria, store_id, i < cliques ? 1 : 0);
    }
  };
  inserir('informatica', 'kabum', 500, 0);
  inserir('moda', 'shopee', 150, 6);
  const ctx = contexto();
  assert.ok(ctx.aprendido, 'com cliques suficientes, há aprendizado');
  const pc = { produto: 'Monitor Gamer 24 Polegadas', preco_atual: 599, categoria: 'informatica' };
  const roupa = { produto: 'Kit 3 Bermudas Masculinas', preco_atual: 79, categoria: 'moda' };
  assert.ok(nota({ ...pc, store_id: 'kabum' }, ctx) < nota({ ...pc, store_id: 'kabum' }), 'KaBuM!/informática sem clique desce');
  assert.ok(nota({ ...roupa, store_id: 'shopee' }, ctx) > nota({ ...roupa, store_id: 'shopee' }), 'moda com clique sobe');
});

test('vendidos e nota da loja são gravados na oferta (Shopee e busca do Mercado Livre)', () => {
  const id = offers.saveDeal(getStore('shopee'), { store_product_id: '999', produto: 'Chinelo Nuvem Feminino', preco_atual: 19.9, preco_anterior: 39.9,
    imagem: 'https://down-br.img.susercontent.com/x', original_url: 'https://shopee.com.br/x-i.1.999', vendidos: 11184, avaliacao: 4.7 }, { settings: settings.getAll() });
  let o = db.get('SELECT vendidos, avaliacao FROM offers WHERE id = ?', id);
  assert.deepEqual({ ...o }, { vendidos: 11184, avaliacao: 4.7 });
  // Leitura sem os números (outra fonte): mantém os últimos conhecidos
  offers.saveDeal(getStore('shopee'), { store_product_id: '999', produto: 'Chinelo Nuvem Feminino', preco_atual: 18.9, preco_anterior: 39.9,
    original_url: 'https://shopee.com.br/x-i.1.999' }, { settings: settings.getAll() });
  o = db.get('SELECT vendidos, avaliacao, preco_atual FROM offers WHERE id = ?', id);
  assert.deepEqual({ ...o }, { vendidos: 11184, avaliacao: 4.7, preco_atual: 18.9 });

  const texto = '0:{"optimizedResponse":{"results":[{"polycard":{"metadata":{"id":"MLB3505290114","signal":{"sales":10000,"reviews_rating":4.9}},'
    + '"pictures":{"pictures":[{"id":"624087-MLB69000247214_042023"}]},"components":[{"type":"title","title":{"text":"Chinelo Babuche Nellie"}},'
    + '{"type":"price","price":{"price_labels":[{"values":[{"key":"previous_price","price":{"value":99.99,"previous":true}}]}],"current_price":{"value":68.99}}}]}}]}}\n';
  const [d] = getStore('mercadolivre').parseHtml(`_n.ctx.s["nr"].q(${JSON.stringify(texto)})`);
  assert.equal(d.vendidos, 10000);
  assert.equal(d.avaliacao, 4.9);
});
