// Regras principais, num banco temporário (nunca o do site). Rode com: npm test
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const PASTA = fs.mkdtempSync(path.join(os.tmpdir(), 'ofertou-teste-'));
process.env.DATA_DIR = PASTA;
process.env.DISABLE_MINER = '1';
process.env.DISABLE_AGENDA = '1';

const db = require('../src/db');
assert.ok(db.DB_PATH.startsWith(PASTA), 'os testes só rodam no banco temporário');
const settings = require('../src/settings');
const offers = require('../src/offers');
const cupons = require('../src/cupons');
const busca = require('../src/busca-ofertas');
const dois = require('../src/admin2fa');
const { getStore } = require('../src/stores');

const amazon = getStore('amazon'), shopee = getStore('shopee'), kabum = getStore('kabum');
let n = 0;
const oferta = (store, produto, de, por, extra = {}) => offers.saveDeal(store, {
  store_product_id: `T${++n}`, produto, preco_anterior: de, preco_atual: por,
  imagem: 'https://exemplo.test/f.jpg', original_url: `https://www.exemplo.test/p/${n}`, ...extra,
}, { settings: { ...settings.getAll(), min_discount_pct: 5 } });
const nomes = r => r.itens.map(o => o.produto);

test.after(() => { try { db.db.close(); } catch { /* */ } try { fs.rmSync(PASTA, { recursive: true, force: true }); } catch { /* */ } });

test('login em duas etapas: padrão TOTP (RFC 6238)', () => {
  assert.equal(dois.codigoDe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1), '287082');
  assert.equal(dois.codigoDe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 37037036), '081804');
});

test('login em duas etapas: ativar, código novo, repetido e recuperação', async () => {
  assert.equal(dois.ativo(), false);
  assert.equal(dois.conferir('qualquer'), true, 'desligado não atrapalha');
  const { segredo, qr } = await dois.iniciar();
  assert.match(qr, /<svg/);
  assert.equal(dois.ativo(), false, 'só vale depois de confirmar');
  assert.throws(() => dois.confirmar('000000'));
  const agora = Date.now();
  const recuperacao = dois.confirmar(dois.codigoDe(segredo, dois.contadorAgora(agora)));
  assert.equal(recuperacao.length, 8);
  assert.equal(dois.ativo(), true);
  const depois = agora + 60000, codigo = dois.codigoDe(segredo, dois.contadorAgora(depois));
  assert.equal(dois.conferir('123', depois), false);
  assert.equal(dois.conferir(codigo, depois), true);
  assert.equal(dois.conferir(codigo, depois), false, 'o mesmo código não entra duas vezes');
  assert.equal(dois.conferir(recuperacao[0]), true);
  assert.equal(dois.conferir(recuperacao[0]), false, 'recuperação é de uso único');
  assert.equal(dois.estado().codigos_restantes, 7);
  dois.desligar();
  assert.equal(dois.ativo(), false);
});

test('cupom: compra mínima, limite e preço sem cupom', () => {
  const d = { preco_atual: 630.8, preco_anterior: 1030 };
  assert.equal(cupons.aplicar(d, { codigo: 'ML1', tipo: 'pct', valor: 5, minimo: 200, limite: 40 }).preco_atual, 599.26);
  assert.equal(cupons.aplicar(d, { codigo: 'ML1', tipo: 'pct', valor: 50, limite: 40 }).preco_atual, 590.8);
  assert.equal(cupons.aplicar(d, { codigo: 'ML1', tipo: 'pct', valor: 5, minimo: 700 }).cupom_codigo, undefined);
  const sem = cupons.aplicar({ preco_atual: 100, preco_anterior: 0 }, { codigo: 'LEVOU5', tipo: 'pct', valor: 10 });
  assert.deepEqual([sem.preco_atual, sem.preco_anterior, sem.preco_sem_cupom], [90, 100, 100]);
});

test('cupom: preços confirmados nas páginas das lojas', () => {
  const kabum2 = require('../src/stores/kabum');
  const base = { title: 'Produto', available: true, images: [], product_link: 'x' };
  const selo = d => ({ title: 'CUPOM X', name: 'X', description: d });
  // KaBuM, produto 105104: "R$ 139,49 à vista no PIX c/ cupom" (10% sobre 154,99)
  const [pct] = kabum2.parse([{ id: 1, attributes: { ...base, price: 182.34, old_price: 0, price_with_discount: 154.99, stamps: selo('Use o cupom KORUJAO e ganhe 10% OFF neste item') } }]);
  assert.deepEqual([pct.preco_atual, pct.cupom_codigo, pct.cupom_texto], [139.49, 'KORUJAO', '10% OFF']);
  // KaBuM, produto 644868: "R$ 415,00 à vista no PIX c/ cupom" = (521,11 - 60) x 0,9
  const agora = Date.now() / 1000;
  const [val] = kabum2.parse([{ id: 2, attributes: { ...base, price: 606.67, old_price: 0, price_with_discount: 546, offer: { price: 521.11, price_with_discount: 469, starts_at: agora - 100, ends_at: agora + 100, quantity_available: 5 }, stamps: selo('Use o cupom TOMA60 e ganhe R$ 60 OFF neste item') } }]);
  assert.deepEqual([val.preco_atual, val.preco_sem_cupom, val.cupom_texto], [415, 469, 'R$ 60 OFF']);
  // Mercado Livre, colchão: "R$ 1.128 com Cupom, ou R$ 1.178 em 10x": não desconta de novo
  const incl = cupons.jaIncluso({ preco_atual: 1128, preco_anterior: 1929 }, { codigo: 'ML1', tipo: 'valor', valor: 50, texto: 'R$ 50 OFF' });
  assert.deepEqual([incl.preco_atual, incl.preco_sem_cupom, incl.preco_anterior], [1128, 1178, 1929]);
});

test('cupom do Mercado Livre: rótulo colado no preço já inclui; à parte, ainda não', () => {
  const cml = require('../src/cupons-ml');
  assert.equal(cml.salvarCupons([{ id: '99', titulo: 'R$ 50 OFF', subtitulo: 'Em produtos de Loja X', tipo: 'valor', valor: 50, minimo: 100, limite: 50, ativo: true }]), 1);
  const item = (id, preco, rotulo) => ({ produto: `MLB${id}`, link: `https://www.mercadolivre.com.br/p/MLB${id}`, nome: `Produto cupom ${id}`, preco, preco_anterior: 2000, rotulo });
  assert.equal(cml.importarProdutos('99', [item(1000001, 1128, 'com Cupom'), item(1000002, 1000, 'R$ 50 OFF com Cupom'), item(1000003, 50, 'R$ 50 OFF com Cupom')]).gravados, 2);
  const preco = id => db.get('SELECT preco_atual p, preco_sem_cupom s FROM offers WHERE store_product_id = ?', `MLB${id}`);
  assert.deepEqual({ ...preco(1000001) }, { p: 1128, s: 1178 }, 'já inclui');
  assert.deepEqual({ ...preco(1000002) }, { p: 950, s: 1000 }, 'à parte');
  assert.equal(preco(1000003), undefined, 'abaixo da compra mínima');
});

test('cupom esgotado do Mercado Livre sai da lista e as ofertas voltam ao preço sem cupom', () => {
  const cml = require('../src/cupons-ml');
  cml.salvarCupons([{ id: '555', titulo: 'R$ 50 OFF', tipo: 'valor', valor: 50, minimo: 100, limite: 50, ativo: true }, { id: '556', titulo: 'R$ 10 OFF', tipo: 'valor', valor: 10, ativo: true }]);
  const item = (id, preco, ant) => ({ produto: `MLB${id}`, link: `https://www.mercadolivre.com.br/p/MLB${id}`, nome: `Produto esgotado ${id}`, preco, preco_anterior: ant, rotulo: 'R$ 50 OFF com Cupom' });
  assert.equal(cml.importarProdutos('555', [item(2000001, 1000, 2000), item(2000002, 1000, 1010)]).gravados, 2);
  const le = id => db.get(`SELECT preco_atual p, preco_sem_cupom s, cupom_codigo c, desconto_pct d, last_seen_at < datetime('now', '-2 days') velha FROM offers WHERE store_product_id = ?`, `MLB${id}`);
  assert.equal(le(2000001).p, 950);
  assert.deepEqual(cml.removerEsgotados(['555', 'abc', '']), { cupons: 1, ofertas: 2 });
  assert.deepEqual({ ...le(2000001) }, { p: 1000, s: null, c: null, d: 50, velha: 0 }, 'volta ao preço sem cupom');
  assert.equal(le(2000002).velha, 1, 'sem desconto suficiente, sai do ar');
  assert.deepEqual(cml.listar().filter(c => ['555', '556'].includes(c.campanha)).map(c => c.campanha), ['556'], 'o outro cupom continua');
});

test('extensão: reconhece cupom esgotado sem confundir com o nome de um produto', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../extensao-comissao/cupons.js'), 'utf8');
  const trecho = src.slice(src.indexOf('const RE_ESGOTADO'), src.indexOf('function cupomDe'));
  const esgotado = new Function(`${trecho}; return esgotado;`)();
  assert.equal(esgotado({ status: { id: 'SOLD_OUT' } }), true);
  assert.equal(esgotado({ status: { id: 'INACTIVE' }, action: { label: 'Esgotado' } }), true);
  assert.equal(esgotado({ status: { id: 'INACTIVE' } }, { innerText: 'R$ 10 OFF\nCupom esgotado' }), true);
  assert.equal(esgotado({ status: { id: 'ACTIVE' }, title: { text: '5% OFF' } }), false);
  assert.equal(esgotado({ status: { id: 'INACTIVE' }, items: [{ alt_text: 'Tênis esgotado edição limitada' }] }), false, 'ainda dá para aplicar');
});

test('oferta perde o cupom quando a leitura nova vem sem ele', () => {
  const deal = cupons.aplicar({ store_product_id: 'CUP1', produto: 'Monitor com cupom teste', preco_atual: 100, preco_anterior: 200, original_url: 'https://www.exemplo.test/c' }, { codigo: 'ESQUENTA', tipo: 'pct', valor: 10 });
  const s = { ...settings.getAll(), min_discount_pct: 5 };
  const id = offers.saveDeal(kabum, deal, { settings: s });
  assert.equal(db.get('SELECT cupom_codigo c FROM offers WHERE id = ?', id).c, 'ESQUENTA');
  offers.saveDeal(kabum, { store_product_id: 'CUP1', produto: 'Monitor com cupom teste', preco_atual: 100, preco_anterior: 200, original_url: 'https://www.exemplo.test/c' }, { settings: s });
  assert.equal(db.get('SELECT cupom_codigo c FROM offers WHERE id = ?', id).c, null);
});

test('busca, repetidos e descontos suspeitos', () => {
  oferta(amazon, 'Geladeira Brastemp Frost Free 400L', 4000, 3000);
  oferta(shopee, 'Geladeira Mini de Brinquedo Infantil', 200, 80);
  oferta(amazon, 'Prateleira para geladeira', 100, 60);
  oferta(amazon, 'Lençol de algodão macio', 100, 70);
  oferta(amazon, 'Monitor LG UltraWide 29 polegadas', 1500, 1200);
  oferta(amazon, 'Smart TV 55 Samsung 4K', 3000, 2400);
  oferta(amazon, 'Smart TV 150 polegadas projeção', 9000, 8000);
  oferta(amazon, 'Fone de ouvido Bluetooth', 200, 120);
  oferta(amazon, 'Cafeteira Expresso Repetida XPTO', 800, 500);
  oferta(shopee, 'Cafeteira Expresso Repetida XPTO', 800, 450);
  oferta(shopee, 'Relógio Masculino Barato Demais', 219.8, 10.99); // 95%
  oferta(shopee, 'Tênis Réplica Primeira Linha', 300, 150);
  oferta(amazon, 'Modelo de Telefone Falso para Exibição', 200, 100);
  busca.montar();

  const b = q => busca.buscar({ q, por: 24 }, { comissao: false });
  assert.equal(nomes(b('geladeira'))[0], 'Geladeira Brastemp Frost Free 400L', 'o produto vem antes do brinquedo e da peça');
  const lg = nomes(b('lg'));
  assert.ok(lg.includes('Monitor LG UltraWide 29 polegadas'));
  assert.ok(!lg.includes('Lençol de algodão macio'), 'lg não casa com algodão');
  assert.ok(nomes(b('tv 55')).includes('Smart TV 55 Samsung 4K'));
  assert.equal(b('tv 15').aproximado, true, 'número inteiro: 15 não casa com 150');
  assert.ok(nomes(b('televisao')).includes('Smart TV 55 Samsung 4K'), 'sinônimo');
  assert.ok(nomes(b('fones')).includes('Fone de ouvido Bluetooth'), 'plural');

  const parecido = b('geladeira xyzabc');
  assert.equal(parecido.aproximado, true);
  assert.ok(parecido.total > 0);
  assert.equal(b('xyzabc').total, 0);

  const cafe = b('cafeteira expresso').itens;
  assert.equal(cafe.length, 2, 'cada anúncio aparece, mesmo com o nome igual');
  const barata = cafe.find(o => o.preco_atual === 450), cara = cafe.find(o => o.preco_atual === 500);
  assert.equal(barata.iguais, 2, 'o mais barato tem o selo');
  assert.equal(cara.iguais, undefined, 'o outro não');

  const motivos = Object.fromEntries(busca.suspeitas(50).itens.map(o => [o.produto, o.motivo]));
  assert.match(motivos['Relógio Masculino Barato Demais'], /95%/);
  assert.equal(motivos['Tênis Réplica Primeira Linha'], 'Parece réplica');
  assert.equal(motivos['Modelo de Telefone Falso para Exibição'], 'Produto de exibição');
  const r = busca.buscar({ por: 1 }, { comissao: false }).resumo;
  assert.ok(r.maior_desconto < 95, 'suspeita não é o "maior desconto"');
  assert.notEqual(r.destaque?.produto, 'Relógio Masculino Barato Demais');
  assert.notEqual(busca.buscar({ por: 1, ordem: 'desconto' }, { comissao: false }).itens[0].produto, 'Relógio Masculino Barato Demais');
});

test('termo novo na busca: entra na lista, minera na hora e avisa', async () => {
  const termos = require('../src/termos-busca');
  const { STORES } = require('../src/stores');
  const espera = async q => { for (let i = 0; i < 100; i++) { const s = termos.situacao(q); if (s.status !== 'minerando') return s; await new Promise(r => setTimeout(r, 20)); } throw new Error('não terminou'); };
  const lista = () => settings.getSearchTerms().map(t => t.query);

  // Uma ou várias palavras: termos diferentes; ordem, plural, acento e "de" não importam
  assert.equal(termos.chaveDe('Tênis de Nike'), termos.chaveDe('nike tenis'));
  assert.notEqual(termos.chaveDe('tenis'), termos.chaveDe('tenis nike'));
  assert.equal(termos.chaveDe('fones bluetooth'), termos.chaveDe('bluetooth fone'));
  for (const ruim of ['ab', 'https://x.test/p', '#perfil', '12345', 'a'.repeat(61), '<script>']) assert.equal(termos.valido(ruim), false, ruim);

  const originais = STORES.map(s => [s, s.search, s.isReady, s.automatic]);
  const buscas = [];
  for (const s of STORES) { s.automatic = s.id === 'amazon'; s.isReady = () => ({ ready: true }); s.search = async q => { buscas.push(q); return { status: 'ok', deals: /naoexiste/.test(q) ? [] : [{ store_product_id: `AUTO${q}`, produto: `Patinete Azul ${q}`, preco_atual: 100, preco_anterior: 200, original_url: 'https://www.exemplo.test/a' }] }; }; }
  try {
    settings.set('search_terms', 'tenis | moda');
    assert.deepEqual(termos.pedir('tênis', '1.1.1.1'), { status: 'cadastrado' }, 'já está na lista: não minera');
    assert.equal(buscas.length, 0);

    const r = termos.pedir('Tenis Nike', '1.1.1.1');
    assert.equal(r.status, 'minerando', 'duas palavras é outro termo');
    assert.ok(lista().includes('Tenis Nike'), 'entra na lista na hora');
    assert.equal(termos.pedir('nike tênis', '1.1.1.1').status, 'minerando', 'a mesma busca não dispara duas vezes');
    const fim = await espera('Tenis Nike');
    assert.deepEqual([fim.status, fim.gravadas], ['pronto', 1]);
    assert.equal(buscas.filter(q => q === 'Tenis Nike').length, 1);
    assert.deepEqual(termos.pedir('Tenis Nike', '1.1.1.1'), { status: 'cadastrado' }, 'depois de recarregar não pede para recarregar de novo');
    assert.ok(busca.buscar({ q: 'patinete azul', por: 5 }, { comissao: false }).total >= 1, 'a oferta já está na lista do site');

    termos.pedir('naoexiste nada', '1.1.1.1');
    assert.equal((await espera('naoexiste nada')).status, 'sem_ofertas');
    assert.ok(!lista().includes('naoexiste nada'), 'nenhuma loja tem: sai da lista');
    assert.ok(lista().includes('tenis | moda') || lista().includes('tenis'), 'os outros termos continuam');

    for (let i = 0; i < 10; i++) termos.pedir(`limite ${'abcdefghij'[i]}x`, '9.9.9.9');
    assert.equal(termos.pedir('limite novo', '9.9.9.9').status, 'limite', 'cada IP tem limite por hora');
    await new Promise(r => setTimeout(r, 300));
  } finally { for (const [s, a, b, c] of originais) { s.search = a; s.isReady = b; s.automatic = c; } }
});

test('páginas de categoria e marca', () => {
  const seo = require('../src/paginas/ofertas-seo');
  const p = seo.pagina(['eletrodomesticos'], 'https://exemplo.test');
  assert.match(p.html, /<link rel="canonical" href="https:\/\/exemplo.test\/ofertas\/eletrodomesticos">/);
  // As ofertas estão na grade do HTML (cartões com nome e link), não só nos dados estruturados: o Google vê sem JavaScript
  const grade = p.html.slice(p.html.indexOf('id="grid"'), p.html.indexOf('id="pagination"'));
  assert.match(grade, /class="card"[\s\S]*Geladeira Brastemp/, 'os cartões entram no HTML no lugar dos esqueletos');
  assert.doesNotMatch(p.html, /<div class="skeleton">/, 'não sobra esqueleto de carregamento');
  assert.equal(seo.pagina(['nao-existe'], 'https://exemplo.test'), null);
  assert.equal(seo.pagina(['marca', 'nao-existe'], 'https://exemplo.test'), null);
});

test('páginas de categoria: paginação que o Google segue', () => {
  for (let i = 0; i < 30; i++) oferta(amazon, `Geladeira Consul ${300 + i * 7} litros frost free cor ${i}`, 3000 + i, 2200 + i);
  busca.montar();
  const seo = require('../src/paginas/ofertas-seo');
  seo._limparCache();
  const p1 = seo.pagina(['eletrodomesticos'], 'https://exemplo.test', 1);
  const total = busca.buscar({ cat: 'eletrodomesticos', por: seo.POR }, { comissao: false }).paginas;
  assert.ok(total >= 2, `mais de uma página (${total})`);
  assert.match(p1.html, /<a class="page-btn" href="\/ofertas\/eletrodomesticos\?pagina=2" rel="next"/, 'link de verdade para a próxima');
  assert.match(p1.html, /<link rel="canonical" href="https:\/\/exemplo.test\/ofertas\/eletrodomesticos">/);
  const p2 = seo.pagina(['eletrodomesticos'], 'https://exemplo.test', 2);
  assert.match(p2.html, /<link rel="canonical" href="https:\/\/exemplo.test\/ofertas\/eletrodomesticos\?pagina=2">/, 'cada página com o próprio canonical');
  assert.match(p2.html, /<title>[^<]*\(página 2\)/);
  assert.match(p2.html, /href="\/ofertas\/eletrodomesticos" rel="prev"/, 'a anterior da 2 é a página sem ?pagina');
  const ids = html => new Set([...html.matchAll(/class="card" href="[^"]*" [^>]*data-id="(\d+)"/g)].map(m => m[1]));
  const a = ids(p1.html), b = ids(p2.html);
  assert.ok(a.size && b.size && [...b].every(id => !a.has(id)), 'a página 2 tem outras ofertas');
  assert.equal(seo.pagina(['eletrodomesticos'], 'https://exemplo.test', total + 1), null, 'depois da última não existe');
});

test('origem do clique', () => {
  const { origemDoClique: o } = require('../src/admin-painel');
  const req = (ref, query = {}) => ({ query, get: () => ref });
  assert.equal(o(req('', { via: 'post' }), 'site.test'), 'postagem');
  assert.equal(o(req(''), 'site.test'), 'direto');
  assert.equal(o(req('https://site.test/?q=tv'), 'site.test'), 'busca_site');
  assert.equal(o(req('https://site.test/ofertas/games'), 'site.test'), 'pagina_categoria');
  assert.equal(o(req('https://site.test/'), 'site.test'), 'site');
  assert.equal(o(req('https://www.google.com.br/'), 'site.test'), 'buscador');
  assert.equal(o(req('https://l.instagram.com/'), 'site.test'), 'rede_social');
  assert.equal(o(req('https://blog.exemplo.test/'), 'site.test'), 'outro_site');
});

test('backup: banco, fotos, pasta externa, restauração e limpeza', async () => {
  const backup = require('../src/backup');
  const externa = fs.mkdtempSync(path.join(os.tmpdir(), 'ofertou-externa-'));
  fs.writeFileSync(path.join(db.UPLOADS_DIR, 'foto-teste.txt'), 'foto');
  settings.set('backup_pasta_externa', externa);
  const r = await backup.fazer();
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.externo, true);
  const noExterno = fs.readdirSync(externa);
  assert.ok(noExterno.some(x => /^ofertas-.*\.db\.gz$/.test(x)));
  assert.ok(noExterno.some(x => /^fotos-.*\.tar\.gz$/.test(x)), 'as fotos também vão');
  assert.ok(require('zlib').gunzipSync(fs.readFileSync(backup.caminho(r.nome))).length > 1000);
  assert.equal(backup.caminho('../ofertas.db'), null);
  assert.equal(backup.estado().atrasado, false);

  const dir = path.dirname(backup.caminho(r.nome));
  for (let d = 1; d <= 40; d++) fs.writeFileSync(path.join(dir, `ofertas-${new Date(Date.now() - d * 86400000).toISOString().slice(0, 10)}.db.gz`), '');
  backup.limpar();
  const sobram = fs.readdirSync(dir).filter(x => x.startsWith('ofertas-')).length;
  assert.ok(sobram >= 8 && sobram <= 11, `sobraram ${sobram}`);

  // Disparo automático: antes da hora nada; depois, faz uma vez só por dia
  fs.rmSync(backup.caminho(r.nome));
  assert.equal(backup.conferir(3), null, 'antes das 4 h não faz');
  const auto = await backup.conferir(5);
  assert.equal(auto.ok, true, 'depois da hora faz');
  assert.equal(backup.conferir(5), null, 'já feito hoje: não repete');

  settings.set('backup_pasta_externa', path.join(externa, 'nao-existe'));
  const r2 = await backup.fazer();
  assert.equal(r2.ok, true, 'pasta externa com problema não derruba o backup local');
  assert.equal(r2.externo, false);
  settings.set('backup_pasta_externa', '');
  fs.rmSync(externa, { recursive: true, force: true });
});

test('agendamento: posta pela nota, sem suspeitas e sem repetir', async () => {
  const agenda = require('../src/agenda');
  const social = require('../src/social');
  busca.montar();
  const escolhidas = agenda.melhoresOfertas(50, new Set());
  const nomesEscolhidos = escolhidas.map(id => db.get('SELECT produto FROM offers WHERE id = ?', id).produto);
  assert.ok(nomesEscolhidos.length > 0);
  assert.ok(!nomesEscolhidos.includes('Relógio Masculino Barato Demais'));
  assert.ok(!nomesEscolhidos.includes('Tênis Réplica Primeira Linha'));

  settings.set('agenda_redes', JSON.stringify(['telegram']));
  settings.set('telegram_bot_token', 'teste');
  settings.set('telegram_chat_id', '-1');
  const original = social.publicar;
  const publicadas = [];
  social.publicar = async (id, redes, texto) => { publicadas.push({ id, texto }); return [{ rede: redes[0], ok: true }]; };
  try {
    const r = await agenda.executar('teste', null, 1);
    assert.equal(r.erro, undefined, r.erro);
    assert.equal(r.feitos.length, 1);
    assert.equal(publicadas.length, 1);
    assert.match(publicadas[0].texto, /R\$/);
  } finally { social.publicar = original; }
});

test('erros do servidor são agrupados', () => {
  const erros = require('../src/erros-site');
  erros.registrar(new Error('falhou o pedido 123'), 'GET /api/x');
  erros.registrar(new Error('falhou o pedido 456'), 'GET /api/x');
  const l = erros.recentes();
  assert.equal(l.length, 1);
  assert.equal(l[0].vezes, 2);
});
