// Mineração dos anúncios comuns do Mercado Livre pela extensão do Chrome, num banco temporário (nunca o do site).
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const PASTA = fs.mkdtempSync(path.join(os.tmpdir(), 'ofertou-mlchrome-'));
process.env.DATA_DIR = PASTA;
process.env.DISABLE_MINER = '1';
process.env.DISABLE_AGENDA = '1';

const db = require('../src/db');
assert.ok(db.DB_PATH.startsWith(PASTA), 'os testes só rodam no banco temporário');
const settings = require('../src/settings');
const ml = require('../src/stores/mercadolivre');
const mlChrome = require('../src/mineracao-ml-chrome');

test.after(() => { try { db.db.close(); } catch { /* */ } try { fs.rmSync(PASTA, { recursive: true, force: true }); } catch { /* */ } });

// Página de busca no formato que o Mercado Livre manda hoje: blocos _n.ctx.s["nr"].q("…") com linhas "id:{…}",
// referências "@N", "u" para vazio, "$0" e "NaN" fora dos textos.
function card(id, titulo, atual, anterior, ref) {
  const preco = anterior
    ? `{"price_labels":[{"version":"1","text":"{previous_price}","values":[{"type":"price","key":"previous_price","price":{"value":${anterior},"currency":"BRL","previous":true}}]}],"current_price":{"value":${atual},"currency":"BRL"},"discount_pct":10}`
    : `{"current_price":{"value":${atual},"currency":"BRL"},"extra":u}`;
  return `{"id":"POLYCARD","state":u,"polycard":{"unique_id":"x","metadata":{"id":"${id}","url":"produto.mercadolivre.com.br/MLB-${id.slice(3)}-nome-_JM","is_pad":"false"},`
    + `"pictures":{"pictures":[{"id":"624087-MLB69000247214_042023"}]},"components":[{"type":"title","id":"title","title":{"text":"${titulo}"}},`
    + `{"type":"price","id":"price_v2","price":${preco}},${ref}]}}`;
}
function paginaBusca() {
  const linha0 = `0:{"optimizedResponse":{"adult_info":@1,"results":[${[
    card('MLB3505290114', 'Chinelo Babuche Nellie Boaonda Feminina Sandália Macia', 68.99, 99.99, '@2'),
    card('MLB5389993099', 'Babuche Masculino Plataforma Eva', 49.99, 83.32, '@2'),
    card('MLB7329314774', 'Kit Sandália Babuche Sem Desconto', 69.9, null, '@2'),
  ].join(',')}],"pagina":NaN,"promessa":$0}}`;
  const texto = `${linha0}\n1:{"is_zrp_adult":false}\n2:{"type":"seller","id":"seller","seller":{"text":"por Loja"}}\n`;
  return `<html><script>_n.ctx.s["nr"].q(${JSON.stringify(texto)});</script></html>`;
}

test('lê as ofertas embutidas na página de busca do Mercado Livre (anúncios comuns, fora do catálogo)', () => {
  const deals = ml.parseHtml(paginaBusca());
  assert.equal(deals.length, 2, 'o anúncio sem preço riscado fica de fora');
  assert.deepEqual(deals[0], {
    store_product_id: 'MLB3505290114',
    produto: 'Chinelo Babuche Nellie Boaonda Feminina Sandália Macia',
    preco_atual: 68.99,
    preco_anterior: 99.99,
    imagem: 'https://http2.mlstatic.com/D_Q_NP_2X_624087-MLB69000247214_042023-E.webp',
    original_url: 'https://produto.mercadolivre.com.br/MLB-3505290114',
  });
});

test('código do anúncio no link dos cards (comum, /up/, catálogo e patrocinado)', () => {
  assert.equal(ml.idDoCard('https://produto.mercadolivre.com.br/MLB-3505290114-chinelo-babuche-_JM#origin=share'), 'MLB3505290114');
  assert.equal(ml.idDoCard('https://www.mercadolivre.com.br/babuche/up/MLBU5526291498?pdp_filters=item_id%3AMLB5389993099'), 'MLB5389993099');
  assert.equal(ml.idDoCard('https://www.mercadolivre.com.br/fone/p/MLB44923446?pdp_filters=x&wid=MLB6696013250'), 'MLB6696013250');
  assert.equal(ml.idDoCard('https://www.mercadolivre.com.br/fone/p/MLB44923446'), null, 'código de catálogo não é anúncio');
  assert.equal(ml.idDoCard('https://click1.mercadolivre.com.br/mclics/clicks/external/MLB/count?a=1&pdp_filters=item_id:MLB7329314774'), 'MLB7329314774');
});

test('cards já montados no HTML continuam funcionando e o link sai sempre direto para o anúncio', () => {
  const html = `<ol class="ui-search-layout"><li class="ui-search-layout__item"><div class="poly-card">
    <h3 class="poly-component__title-wrapper"><a class="poly-component__title" href="https://click1.mercadolivre.com.br/mclics/clicks/external/MLB/count?pdp_filters=item_id%3AMLB5389993099">Babuche Masculino</a></h3>
    <s class="andes-money-amount andes-money-amount--previous"><span class="andes-money-amount__fraction">83</span><span class="andes-money-amount__cents">32</span></s>
    <div class="poly-price__current"><span class="andes-money-amount"><span class="andes-money-amount__fraction">49</span><span class="andes-money-amount__cents">99</span></span></div>
    <img src="https://http2.mlstatic.com/D_Q_NP_2X_1.webp"></div></li></ol>`;
  const [d] = ml.parseHtml(html);
  assert.equal(d.store_product_id, 'MLB5389993099');
  assert.equal(d.original_url, 'https://produto.mercadolivre.com.br/MLB-5389993099');
  assert.equal(d.preco_atual, 49.99);
  assert.equal(d.preco_anterior, 83.32);
});

test('a extensão recebe os termos em rodízio, com os pedidos agora na frente', () => {
  settings.set('search_terms', 'sandalia | moda\nchinelo | moda\nfone bluetooth\nair fryer');
  settings.set('ml_chrome_termos_por_minuto', '3');
  const a = mlChrome.proximos();
  assert.deepEqual(a.map(b => b.query), ['sandalia', 'chinelo', 'fone bluetooth']);
  assert.equal(a[0].url, 'https://lista.mercadolivre.com.br/sandalia');
  assert.equal(mlChrome.urlDaBusca('chinelo babuche'), 'https://lista.mercadolivre.com.br/chinelo-babuche');
  mlChrome.priorizar('chinelo babuche');
  mlChrome.priorizar('https://produto.mercadolivre.com.br/MLB-1'); // link não é termo de busca
  const b = mlChrome.proximos();
  assert.deepEqual(b.map(x => x.query), ['chinelo babuche', 'air fryer', 'sandalia'], 'o pedido vem primeiro e o rodízio continua');
  settings.set('stores_enabled', JSON.stringify({ mercadolivre: false }));
  assert.deepEqual(mlChrome.proximos(), [], 'Mercado Livre desligado no painel: nada para buscar');
  settings.set('stores_enabled', JSON.stringify({ mercadolivre: true }));
});

test('a página que a extensão traz vira ofertas no site, com o link de afiliado', () => {
  settings.set('ml_matt_tool', '38524122');
  const r = mlChrome.receber({ query: 'sandalia', html: paginaBusca() });
  assert.deepEqual(r, { encontradas: 2, gravadas: 2 });
  const o = db.get(`SELECT * FROM offers WHERE store_id = 'mercadolivre' AND store_product_id = 'MLB3505290114'`);
  assert.equal(o.preco_atual, 68.99);
  assert.equal(o.categoria, 'moda', 'a categoria do termo vale para a oferta');
  assert.match(o.affiliate_url, /^https:\/\/produto\.mercadolivre\.com\.br\/MLB-3505290114\?.*matt_tool=38524122/);
  // De novo (próxima volta): atualiza, não duplica
  mlChrome.receber({ query: 'sandalia', html: paginaBusca() });
  assert.equal(db.get(`SELECT COUNT(*) n FROM offers WHERE store_product_id = 'MLB3505290114'`).n, 1);
  const e = mlChrome.estado();
  assert.equal(e.buscas, 2);
  assert.equal(e.gravadas, 4);
  assert.equal(e.erro, null);
});

test('verificação do Mercado Livre ou página sem produtos aparecem como problema no Painel', () => {
  mlChrome.receber({ query: 'sandalia', erro: 'Entre no portal neste Chrome (ele pediu login ou verificação) e tente de novo.' });
  assert.match(mlChrome.estado().erro, /verificação/);
  mlChrome.receber({ query: 'sandalia', html: '<html><body>Confirme que você não é um robô</body></html>' });
  assert.match(mlChrome.estado().erro, /sem produtos/);
  mlChrome.receber({ query: 'sandalia', html: paginaBusca() });
  assert.equal(mlChrome.estado().erro, null, 'a próxima busca boa limpa o aviso');
});

test('termo entregue que não volta em 3 minutos é entregue de novo (até 3 vezes); o que voltou não se repete', () => {
  settings.set('search_terms', 'mouse\nmouse gamer\nteclado\nheadset\nwebcam\nmicrofone');
  settings.set('ml_chrome_termos_por_minuto', '2');
  settings.set('ml_chrome_estado', '{}');
  settings.set('ml_chrome_entregues', '[]');
  settings.set('ml_chrome_prioridade', '[]');
  const voltar = min => settings.set('ml_chrome_entregues', JSON.stringify(JSON.parse(settings.get('ml_chrome_entregues')).map(e => ({ ...e, em: e.em - min * 60000 }))));
  assert.deepEqual(mlChrome.proximos().map(b => b.query), ['mouse', 'mouse gamer']);
  mlChrome.receber({ query: 'mouse', html: paginaBusca() });           // só "mouse" voltou
  assert.deepEqual(mlChrome.proximos().map(b => b.query), ['teclado', 'headset'], 'antes de 3 minutos, segue o rodízio');
  mlChrome.receber({ query: 'teclado', erro: 'Entre no portal neste Chrome (ele pediu login ou verificação) e tente de novo.' });
  voltar(4);
  assert.deepEqual(mlChrome.proximos().map(b => b.query), ['mouse gamer', 'teclado'], 'o que não voltou (ou voltou com erro) vem primeiro');
  for (let i = 0; i < 3; i++) { voltar(4); mlChrome.proximos(); }
  assert.ok(!JSON.parse(settings.get('ml_chrome_entregues')).some(e => e.q === 'mouse gamer' && e.vezes > 3), 'desiste depois de 3 vezes');
});

test('aprende termos novos em "Outras pessoas pesquisaram", só os bons e dentro dos limites', () => {
  settings.set('search_terms', 'chinelo | moda\nair fryer | cozinha\nfone bluetooth');
  settings.set('ml_chrome_aprender', '1');
  settings.set('ml_chrome_novos_por_dia', '30');
  settings.set('ml_chrome_termos_max', '1000');
  settings.set('ml_chrome_novos', '{}');
  // O que a busca de verdade trouxe (2026-11-13)
  const chinelo = [{ q: 'chinelo feminino', categoria: 'MLB23262' }, { q: 'chinelo masculino', categoria: 'MLB273770' },
    { q: 'chinelo nuvem', categoria: 'MLB273770' }, { q: 'chinelo nike', categoria: 'MLB273770' }, { q: 'chinelo havaianas feminina', categoria: 'MLB273770' }];
  const airFryer = [{ q: 'moldura de canto de teto', categoria: 'MLB418817' }, { q: 'air frayer', categoria: 'MLB456045' },
    { q: 'air frier', categoria: 'MLB456045' }, { q: 'revestimento banheiro', categoria: null }];
  const fone = [{ q: 'livros revistas comics', categoria: null }, { q: 'fone bluetooth com botão', categoria: 'MLB7457' }, { q: 'carros motos outros', categoria: null }];
  assert.deepEqual(mlChrome.aprender('chinelo', chinelo), ['chinelo feminino', 'chinelo masculino', 'chinelo nuvem', 'chinelo nike', 'chinelo havaianas feminina']);
  assert.deepEqual(mlChrome.aprender('air fryer', airFryer), [], 'sem relação com a busca ou erro de digitação de um termo que já existe');
  assert.deepEqual(mlChrome.aprender('fone bluetooth', fone), ['fone bluetooth com botão'], 'sem categoria é lixo');
  const termos = settings.getSearchTerms();
  assert.deepEqual(termos.find(t => t.query === 'chinelo nuvem'), { query: 'chinelo nuvem', cat: 'moda' }, 'herda a categoria do termo de origem');
  assert.deepEqual(mlChrome.aprender('chinelo', chinelo), [], 'não repete o que já entrou');
  const e = mlChrome.estado().novos;
  assert.equal(e.hoje, 6);
  assert.equal(e.ultimos[0].q, 'fone bluetooth com botão');
  // Limites: por dia e tamanho da lista
  settings.set('ml_chrome_novos_por_dia', '7');
  assert.equal(mlChrome.aprender('chinelo', [{ q: 'chinelo slide', categoria: 'MLB1' }, { q: 'chinelo infantil', categoria: 'MLB1' }]).length, 1);
  settings.set('ml_chrome_novos_por_dia', '30');
  settings.set('ml_chrome_termos_max', String(settings.getSearchTerms().length));
  assert.deepEqual(mlChrome.aprender('chinelo', [{ q: 'chinelo couro', categoria: 'MLB1' }]), [], 'lista cheia');
  settings.set('ml_chrome_termos_max', '1000');
  settings.set('ml_chrome_aprender', '0');
  assert.deepEqual(mlChrome.aprender('chinelo', [{ q: 'chinelo couro', categoria: 'MLB1' }]), [], 'desligado no painel');
  settings.set('ml_chrome_aprender', '1');
});

test('a página de busca que a extensão traz já ensina os termos relacionados', () => {
  settings.set('search_terms', 'sandalia | moda');
  settings.set('ml_chrome_novos', '{}');
  const texto = '0:{"optimizedResponse":{"results":[],"related_searches":@1}}\n'
    + '1:{"q":"sandalia","related_searches":[{"q":"sandalia papete","category_id":"MLB273770","keyword_source":"X"},{"q":"carros motos outros","category_id":"UNKNOWN_CATEGORY"}]}\n';
  mlChrome.receber({ query: 'sandalia', html: `_n.ctx.s["nr"].q(${JSON.stringify(texto)})` });
  assert.deepEqual(settings.getSearchTerms().map(t => t.query), ['sandalia', 'sandalia papete']);
});
