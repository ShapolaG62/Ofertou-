// Repostar ofertas de outros grupos, num banco temporário (nunca o do site) e com o WhatsApp simulado.
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const PASTA = fs.mkdtempSync(path.join(os.tmpdir(), 'ofertou-repostar-'));
process.env.DATA_DIR = PASTA;
process.env.DISABLE_MINER = '1';
process.env.DISABLE_AGENDA = '1';

const db = require('../src/db');
assert.ok(db.DB_PATH.startsWith(PASTA), 'os testes só rodam no banco temporário');
const settings = require('../src/settings');
const offers = require('../src/offers');
const social = require('../src/social');
const whatsapp = require('../src/whatsapp');
const proprio = require('../src/whatsapp-proprio');
const repostar = require('../src/repostar-grupos');
const { getStore } = require('../src/stores');

test.after(() => { try { db.db.close(); } catch { /* */ } try { fs.rmSync(PASTA, { recursive: true, force: true }); } catch { /* */ } });

// WhatsApp simulado: o número está conectado, participa de 2 grupos de outras pessoas e tem 2 grupos seus
const ORIGEM = '120363000000000101@g.us', ORIGEM2 = '120363000000000102@g.us', DESTINO = '120363000000000201@g.us', DESTINO2 = '120363000000000202@g.us';
const GRUPOS = [
  { id: ORIGEM, nome: 'Promoções da Ana', membros: 900, meu: false },
  { id: ORIGEM2, nome: 'Achadinhos', membros: 500, meu: false },
  { id: DESTINO, nome: 'Ofertou Tech', membros: 120, meu: true },
  { id: DESTINO2, nome: 'Ofertou Casa', membros: 80, meu: true },
];
proprio.carregarGrupos = async (_dono, { todos } = {}) => (todos ? GRUPOS : GRUPOS.filter(g => g.meu));
proprio.pronto = () => true;
proprio.baixarMidia = async () => ({ base64: Buffer.from('foto').toString('base64'), mimetype: 'image/jpeg' });
proprio.prepararImagem = async b => b;
whatsapp.fotoParaEnvio = async () => Buffer.from('foto-da-loja');
const enviados = [];
whatsapp.enviar = async (_s, destino, msg) => { enviados.push({ destino, ...msg }); return 'id'; };
social.ajustes.pausaEntreGrupos = false;
// Páginas das lojas simuladas (os testes não usam a internet): sem leitura, vale o texto da mensagem
for (const loja of ['amazon', 'kabum', 'magalu']) getStore(loja).lerProduto = async () => null;
repostar._paraTestes({ pausa: false });

const espera = ms => new Promise(r => setTimeout(r, ms));
async function ate(condicao) {
  for (let i = 0; i < 300; i++) { if (condicao()) return; await espera(10); }
  assert.fail('a condição não aconteceu a tempo');
}
const registro = () => db.all('SELECT * FROM repostar_registro WHERE cliente_id IS NULL ORDER BY id');
let n = 0;
const mensagem = (texto, chat = ORIGEM, extra = {}) => ({ wa_id: `M${++n}`, chat, de_mim: 0, texto, segundos: Math.floor(Date.now() / 1000), bruta: '{"x":1}', ...extra });

function configurar(extra = {}) {
  const valores = {
    site_url: '', amazon_tag: 'meutag-20', ml_matt_word: 'meu', ml_matt_tool: '123', magalu_store: '',
    repost_ativo: '1', repost_origens: JSON.stringify([{ id: ORIGEM, nome: 'Promoções da Ana' }, { id: ORIGEM2, nome: 'Achadinhos' }]),
    whatsapp_groups: JSON.stringify([{ id: DESTINO, nome: 'Ofertou Tech' }, { id: DESTINO2, nome: 'Ofertou Casa' }]),
    repost_destinos: JSON.stringify([{ id: DESTINO, nome: 'Ofertou Tech' }]), repost_por_tipo: '0', repost_por_hora: '10',
    repost_intervalo_min: '1', repost_desconto_min: '15', repost_lojas: '', repost_inicio: '00:00', repost_fim: '23:59', ...extra,
  };
  for (const [k, v] of Object.entries(valores)) settings.set(k, v);
  repostar._paraTestes({ zerar: true });
}

test('o link fica sem o código de afiliado de quem postou', () => {
  const ml = getStore('mercadolivre'), magalu = getStore('magalu'), shopee = getStore('shopee'), amazon = getStore('amazon');
  assert.equal(repostar.limparLink(ml, 'https://produto.mercadolivre.com.br/MLB-123-tenis-_JM?matt_word=outro&matt_tool=999#x'), 'https://produto.mercadolivre.com.br/MLB-123-tenis-_JM');
  assert.equal(repostar.limparLink(ml, 'https://www.mercadolivre.com.br/up/MLBU1?pdp_filters=item_id:MLB9&matt_word=outro'), 'https://www.mercadolivre.com.br/up/MLBU1?pdp_filters=item_id%3AMLB9');
  assert.equal(repostar.limparLink(magalu, 'https://www.magazinevoce.com.br/magazineoutrapessoa/fone-bluetooth/p/abc123/ea/fone/'), 'https://www.magazineluiza.com.br/fone-bluetooth/p/abc123/ea/fone/');
  assert.equal(repostar.limparLink(shopee, 'https://shopee.com.br/produto-i.11.22?utm_source=an_999&mmp_pid=x'), 'https://shopee.com.br/produto-i.11.22');
  assert.equal(repostar.limparLink(amazon, 'https://www.amazon.com.br/dp/B0ABCDEF12?tag=outro-20'), 'https://www.amazon.com.br/dp/B0ABCDEF12');
  assert.deepEqual(repostar.linksDa('Olha *https://amzn.to/abc* e (https://meli.la/x).'), ['https://amzn.to/abc', 'https://meli.la/x']);
});

test('oferta nova num grupo de origem: posta no destino com o meu link, sem o texto e o cupom de quem postou', async () => {
  configurar();
  const texto = '🔥 Fone Bluetooth Repostar Primeiro Modelo\nDe R$ 200,00\nPor R$ 120,00\nUse o cupom OUTRO10\nhttps://www.amazon.com.br/dp/B0REPOST01?tag=outro-20';
  assert.equal(repostar.receber(null, mensagem(texto)), true);
  await ate(() => registro().length === 1);
  const r = registro()[0];
  assert.equal(r.situacao, 'postada', r.motivo);
  assert.equal(r.origem, 'Promoções da Ana');
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].destino, DESTINO);
  assert.match(enviados[0].texto, /tag=meutag-20/);
  assert.doesNotMatch(enviados[0].texto, /outro-20|OUTRO10/);
  assert.ok(Buffer.isBuffer(enviados[0].imagem), 'sai com a foto da mensagem (a oferta criada não tem foto da loja)');
  const o = db.get('SELECT * FROM offers WHERE id = ?', r.offer_id);
  assert.equal(o.original_url, 'https://www.amazon.com.br/dp/B0REPOST01');
  assert.equal(o.fonte, 'manual');
});

test('a mesma oferta em outro grupo de origem não é postada de novo', async () => {
  const antes = enviados.length, regs = registro().length;
  repostar.receber(null, mensagem('Fone Bluetooth Repostar Primeiro Modelo\nDe R$ 200,00 Por R$ 120,00\nhttps://www.amazon.com.br/dp/B0REPOST01?tag=terceiro-20', ORIGEM2));
  await espera(80);
  assert.equal(enviados.length, antes);
  assert.equal(registro().length, regs, 'repetida vinda de outro grupo nem entra no registro');
});

test('grupo que não é de origem, mensagem minha ou sem link: nada acontece', async () => {
  configurar();
  assert.equal(repostar.receber(null, mensagem('De R$ 100,00 Por R$ 50,00 https://www.amazon.com.br/dp/B0REPOST02', '120363000000000999@g.us')), false);
  assert.equal(repostar.receber(null, mensagem('De R$ 100,00 Por R$ 50,00 https://www.amazon.com.br/dp/B0REPOST02', ORIGEM, { de_mim: 1 })), false);
  assert.equal(repostar.receber(null, mensagem('Bom dia, pessoal!')), false);
  assert.equal(repostar.receber(null, mensagem('De R$ 100,00 Por R$ 50,00 https://www.amazon.com.br/dp/B0REPOST02', ORIGEM, { segundos: Math.floor(Date.now() / 1000) - 900 })), false, 'mensagem antiga');
  settings.set('repost_ativo', '0');
  repostar._paraTestes({ zerar: true });
  assert.equal(repostar.receber(null, mensagem('De R$ 100,00 Por R$ 50,00 https://www.amazon.com.br/dp/B0REPOST02')), false, 'desligado');
});

test('filtros: loja sem o meu link de afiliado, desconto baixo e oferta já no site', async () => {
  configurar();
  const antes = enviados.length;
  // Magalu sem a minha vitrine: não posta (a venda não daria comissão)
  repostar.receber(null, mensagem('Panela Repostar Magalu Teste\nDe R$ 300,00 Por R$ 150,00\nhttps://www.magazinevoce.com.br/magazineoutra/panela/p/zz9988/ud/pnel/'));
  await ate(() => registro().some(r => r.store_id === 'magalu'));
  assert.match(registro().find(r => r.store_id === 'magalu').motivo, /link de afiliado da Magalu/);
  // Desconto de 10%: abaixo do mínimo de 15%
  repostar.receber(null, mensagem('Mouse Repostar Desconto Baixo\nDe R$ 100,00 Por R$ 90,00\nhttps://www.amazon.com.br/dp/B0REPOST03'));
  await ate(() => registro().some(r => /B0REPOST03/.test(r.chave)));
  assert.match(registro().find(r => /B0REPOST03/.test(r.chave)).motivo, /abaixo do mínimo/);
  // Oferta que o site já tem: usa os dados (e a foto) dela, mesmo sem preço na mensagem
  const id = offers.saveDeal(getStore('amazon'), { store_product_id: 'B0REPOST04', produto: 'Teclado Repostar Ja No Site', preco_atual: 100, preco_anterior: 250,
    imagem: 'https://exemplo.test/teclado.jpg', original_url: 'https://www.amazon.com.br/dp/B0REPOST04' }, { settings: { ...settings.getAll(), min_discount_pct: 5 } });
  repostar.receber(null, mensagem('Corre! https://www.amazon.com.br/dp/B0REPOST04?tag=outro-20'));
  await ate(() => registro().some(r => r.offer_id === id));
  assert.equal(registro().find(r => r.offer_id === id).situacao, 'postada');
  assert.equal(enviados.length, antes + 1);
  assert.equal(String(enviados.at(-1).imagem), 'foto-da-loja');
});

test('limite por hora', async () => {
  configurar({ repost_por_hora: '1' });
  db.run(`UPDATE repostar_registro SET created_at = datetime('now', '-2 hours') WHERE situacao = 'postada'`);
  repostar.receber(null, mensagem('Caixa de Som Repostar Limite Um\nDe R$ 200,00 Por R$ 100,00\nhttps://www.amazon.com.br/dp/B0REPOST05'));
  await ate(() => registro().some(r => /B0REPOST05/.test(r.chave)));
  repostar.receber(null, mensagem('Luminaria Repostar Limite Dois\nDe R$ 200,00 Por R$ 100,00\nhttps://www.amazon.com.br/dp/B0REPOST06'));
  await ate(() => registro().some(r => /B0REPOST06/.test(r.chave)));
  assert.equal(registro().find(r => /B0REPOST05/.test(r.chave)).situacao, 'postada');
  assert.match(registro().find(r => /B0REPOST06/.test(r.chave)).motivo, /Limite de 1 repostagens por hora/);
});

test('salvar: destino só nos Grupos de destino, com as origens de cada um, e ligar exige origem e destino', async () => {
  configurar({ repost_ativo: '0', repost_origens: '[]', repost_destinos: '[]' });
  await assert.rejects(repostar.salvar(null, { origens: [ORIGEM], destinos: [{ id: ORIGEM2, origens: [ORIGEM] }] }), /Grupos de destino/);
  await assert.rejects(repostar.salvar(null, { origens: [DESTINO], destinos: [{ id: DESTINO, origens: [DESTINO] }] }), /origem e destino/);
  await assert.rejects(repostar.salvar(null, { ativo: true, origens: [ORIGEM], destinos: [] }), /pelo menos um grupo/);
  await assert.rejects(repostar.salvar(null, { ativo: true, origens: [ORIGEM], destinos: [{ id: DESTINO, origens: [] }] }), /pelo menos um grupo/, 'destino sem origem marcada não conta');
  const p = await repostar.salvar(null, { ativo: true, origens: [ORIGEM, ORIGEM2], destinos: [{ id: DESTINO, origens: [ORIGEM, ORIGEM2, 'outro@g.us'] }, { id: DESTINO2, origens: [ORIGEM2] }], por_hora: 99, intervalo_min: 0, lojas: ['amazon', 'xyz'] });
  assert.equal(p.ajustes.ativo, true);
  assert.deepEqual(p.ajustes.origens.map(g => g.nome), ['Promoções da Ana', 'Achadinhos']);
  assert.deepEqual(p.ajustes.destinos.map(g => [g.id, g.origens]), [[DESTINO, [ORIGEM, ORIGEM2]], [DESTINO2, [ORIGEM2]]]);
  assert.deepEqual(p.grupos_destino.map(g => g.id), [DESTINO, DESTINO2]);
  // Tirar uma origem tira ela dos destinos
  const sem = await repostar.salvar(null, { origens: [ORIGEM] });
  assert.deepEqual(sem.ajustes.destinos.map(g => [g.id, g.origens]), [[DESTINO, [ORIGEM]]]);
  await repostar.salvar(null, { origens: [ORIGEM, ORIGEM2], destinos: [{ id: DESTINO, origens: [ORIGEM, ORIGEM2] }, { id: DESTINO2, origens: [ORIGEM2] }] });
  assert.equal(p.ajustes.por_hora, 30, 'limite máximo');
  assert.equal(p.ajustes.intervalo_min, 1, 'intervalo mínimo');
  assert.deepEqual(p.ajustes.lojas, ['amazon']);
  // Desligar sem mexer nos grupos não precisa do WhatsApp
  const carregar = proprio.carregarGrupos;
  proprio.carregarGrupos = async () => { throw new Error('desconectado'); };
  try {
    const d = await repostar.salvar(null, { ativo: false, origens: [ORIGEM2, ORIGEM], destinos: [{ id: DESTINO, origens: [ORIGEM] }] });
    assert.equal(d.ajustes.ativo, false);
  } finally { proprio.carregarGrupos = carregar; }
});

test('cada grupo de destino recebe só das origens marcadas nele', async () => {
  configurar({ repost_destinos: JSON.stringify([{ id: DESTINO, nome: 'Ofertou Tech', origens: [ORIGEM2] }, { id: DESTINO2, nome: 'Ofertou Casa', origens: [ORIGEM] }]) });
  const antes = enviados.length;
  repostar.receber(null, mensagem('Teclado Repostar Origem Certa\nDe R$ 200,00 Por R$ 100,00\nhttps://www.amazon.com.br/dp/B0REPOST08', ORIGEM));
  await ate(() => registro().some(r => /B0REPOST08/.test(r.chave)));
  assert.equal(registro().find(r => /B0REPOST08/.test(r.chave)).situacao, 'postada');
  assert.deepEqual(enviados.slice(antes).map(e => e.destino), [DESTINO2]);
  configurar({ repost_destinos: JSON.stringify([{ id: DESTINO, nome: 'Ofertou Tech', origens: [ORIGEM2] }]) });
  repostar.receber(null, mensagem('Mousepad Repostar Sem Destino\nDe R$ 200,00 Por R$ 100,00\nhttps://www.amazon.com.br/dp/B0REPOST09', ORIGEM));
  await ate(() => registro().some(r => /B0REPOST09/.test(r.chave)));
  assert.match(registro().find(r => /B0REPOST09/.test(r.chave)).motivo, /deste grupo de origem/);
});

test('link curto do Mercado Livre e página de perfil de afiliado: acha o produto e guarda o link no registro', async () => {
  configurar();
  const net = require('../src/net');
  const { resolverLink, safeGet } = net;
  net.resolverLink = async u => (/sec\/CURTO1/.test(u) ? 'https://produto.mercadolivre.com.br/MLB-4455667788-fone-teste-_JM?matt_word=outro'
    : /sec\/CURTO2/.test(u) ? 'https://www.mercadolivre.com.br/social/outrapessoa?matt_word=outro&ref=x' : u);
  net.safeGet = async () => ({ status: 200, data: '<html><a href="https://www.mercadolivre.com.br/caixa-de-som/p/MLB55667788">ver</a></html>' });
  try {
    repostar.receber(null, mensagem('Fone Repostar Link Curto ML\nDe R$ 200,00 Por R$ 100,00\nhttps://mercadolivre.com/sec/CURTO1'));
    await ate(() => registro().some(r => r.chave === 'mercadolivre:MLB4455667788'));
    const r1 = registro().find(r => r.chave === 'mercadolivre:MLB4455667788');
    assert.equal(r1.situacao, 'postada', r1.motivo);
    assert.equal(r1.link, 'https://produto.mercadolivre.com.br/MLB-4455667788-fone-teste-_JM');
    repostar.receber(null, mensagem('Caixa de Som Repostar Perfil ML\nDe R$ 300,00 Por R$ 150,00\nhttps://mercadolivre.com/sec/CURTO2', ORIGEM2));
    await ate(() => registro().some(r => r.chave === 'mercadolivre:MLB55667788'));
    assert.equal(registro().find(r => r.chave === 'mercadolivre:MLB55667788').link, 'https://www.mercadolivre.com.br/p/MLB55667788');
  } finally { net.resolverLink = resolverLink; net.safeGet = safeGet; }
});

test('mensagem sem conteúdo, atrasada ou com link de fora: aparece no registro e na contagem de cada origem', async () => {
  configurar();
  repostar.naoLida(null, ORIGEM, 'ILEGIVEL1');
  repostar.naoLida(null, ORIGEM, 'ILEGIVEL1');
  repostar.naoLida(null, '120363000000000999@g.us', 'ILEGIVEL2');
  assert.equal(registro().filter(r => /sem o conteúdo/.test(r.motivo || '')).length, 1);
  repostar.receber(null, mensagem('De R$ 100,00 Por R$ 50,00 https://www.amazon.com.br/dp/B0REPOST10', ORIGEM, { segundos: Math.floor(Date.now() / 1000) - 1200 }));
  assert.match(registro().at(-1).motivo, /atrasada/);
  repostar.receber(null, mensagem('Bom dia!', ORIGEM2));
  const p = repostar.painel(null);
  const ana = p.recebidas.find(g => g.id === ORIGEM), ach = p.recebidas.find(g => g.id === ORIGEM2);
  assert.equal(ana.total, 1);
  assert.equal(ana.ilegiveis, 2);
  assert.equal(ach.total, 1);
});

test('anúncio do Mercado Livre sem preço na mensagem: a extensão do Chrome lê e a oferta é repostada', async () => {
  configurar();
  const leitor = require('../src/leitor-ml');
  leitor._paraTestes({ pausa: false, contato: Date.now() });
  const antes = enviados.length;
  repostar.receber(null, mensagem('🔥 OFERTA\nTênis Corrida Leve Repostar Extensão\n👉 https://produto.mercadolivre.com.br/MLB-5139556321-tenis-_JM?matt_word=outro'));
  // A extensão pergunta pela fila, lê a página e devolve
  await ate(() => leitor.pendentes().length || db.get(`SELECT 1 FROM ml_leituras WHERE item = 'MLB5139556321' AND entregue_em IS NOT NULL`));
  assert.deepEqual(leitor.receber([{ item: 'MLB5139556321', produto: 'Tênis Vans Ultrarange Vr3 Neo', preco: 97.65, preco_anterior: 279,
    imagem: 'https://http2.mlstatic.com/D_NQ_NP_123-O.jpg', disponivel: true }]), { lidos: 1 });
  await ate(() => registro().some(r => r.chave === 'mercadolivre:MLB5139556321'));
  const r = registro().find(x => x.chave === 'mercadolivre:MLB5139556321');
  assert.equal(r.situacao, 'postada', r.motivo);
  assert.equal(enviados.length, antes + 1);
  assert.match(enviados.at(-1).texto, /97,65/);
  // Extensão desligada e mensagem sem preço: avisa o que fazer
  leitor._paraTestes({ contato: 0 });
  repostar.receber(null, mensagem('Camisa Polo Repostar Sem Extensão\nhttps://produto.mercadolivre.com.br/MLB-4119206697-camisa-_JM', ORIGEM2));
  await ate(() => registro().some(x => x.chave === 'mercadolivre:MLB4119206697'));
  assert.match(registro().find(x => x.chave === 'mercadolivre:MLB4119206697').motivo, /Chrome aberto com a extensão/);
  // Só a extensão com a chave certa fala com a fila
  assert.equal(leitor.chaveConfere('errada'), false);
  assert.equal(leitor.chaveConfere(leitor.chave()), true);
});

test('afiliado (cliente da ferramenta): usa a configuração e o link dele', async () => {
  const clientes = require('../src/clientes');
  const cid = clientes.criar({ nome: 'Afiliado Teste', email: 'afiliado-repostar@exemplo.test', senha: 'Senha-Forte-123!x', dias: 30 });
  clientes.salvarConfig(cid, { amazon_tag: 'afiliado-20', whatsapp_groups: JSON.stringify([{ id: DESTINO2, nome: 'Ofertou Casa' }]), repost_ativo: '1', repost_origens: JSON.stringify([{ id: ORIGEM, nome: 'Promoções da Ana' }]),
    repost_destinos: JSON.stringify([{ id: DESTINO2, nome: 'Ofertou Casa' }]), repost_por_tipo: '0', repost_inicio: '00:00', repost_fim: '23:59' });
  repostar._paraTestes({ zerar: true });
  const antes = enviados.length;
  repostar.receber(cid, mensagem('Garrafa Termica Repostar Afiliado\nDe R$ 150,00 Por R$ 75,00\nhttps://www.amazon.com.br/dp/B0REPOST07?tag=outro-20'));
  await ate(() => db.get('SELECT 1 FROM repostar_registro WHERE cliente_id = ?', cid));
  const r = db.get('SELECT * FROM repostar_registro WHERE cliente_id = ?', cid);
  assert.equal(r.situacao, 'postada', r.motivo);
  assert.equal(enviados.length, antes + 1);
  assert.equal(enviados.at(-1).destino, DESTINO2);
  assert.match(enviados.at(-1).texto, /tag=afiliado-20/);
  assert.doesNotMatch(enviados.at(-1).texto, /meutag-20|outro-20/);
});

test('lê os preços nos formatos comuns dos grupos de ofertas', () => {
  const { lerOfertaDoTexto: ler } = require('../src/grupo-automacao');
  const v = t => { const r = ler(t); return [r.titulo, r.anterior, r.atual]; };
  assert.deepEqual(v('🔥 OFERTA RELÂMPAGO 🔥\n\nMouse Gamer Logitech G203 Lightsync\n~R$ 199~\n✅ R$ 99\n👉 https://x'), ['Mouse Gamer Logitech G203 Lightsync', 199, 99]);
  assert.deepEqual(v('Kit 3 Camisetas Básicas Algodão\nPor apenas 59,90\nEra 119,90\nhttps://x'), ['Kit 3 Camisetas Básicas Algodão', 119.9, 59.9]);
  assert.deepEqual(v('Placa-mãe MSI A520M-A Pro\nDe: R$499 Por: R$379\nCupom: TECH10 (R$ 10 OFF)\nFrete grátis acima de R$ 79'), ['Placa-mãe MSI A520M-A Pro', 499, 379]);
  const tv = ler('Smart TV 50" Samsung 4K UHD\nR$ 2.199,00 à vista\nou 10x de R$ 239,90 sem juros\n-21%');
  assert.equal(tv.atual, 2199);
  assert.ok(Math.abs(tv.anterior - 2783.54) < 0.01, 'o preço "de" sai do desconto, sem contar a parcela');
  assert.deepEqual(v('Air Fryer Mondial 4L\n💸 R$ 289,90'), ['Air Fryer Mondial 4L', null, 289.9]);
});

test('mensagem sem preço: busca na página da loja; palavra proibida e horário não barram', async () => {
  configurar({ repost_inicio: '03:00', repost_fim: '03:01' }); // horário antigo que nunca bate: não vale mais
  const proibidas = require('../src/palavras-proibidas');
  const amazon = getStore('amazon');
  const ler = amazon.lerProduto;
  amazon.lerProduto = async asin => ({ deal: { store_product_id: asin, produto: 'Monitor AOC 27 120Hz Gaming Vape Edition', preco_atual: 661, preco_anterior: 819,
    imagem: 'https://m.media-amazon.com/images/I/x.jpg', original_url: `https://www.amazon.com.br/dp/${asin}` } });
  const antesLista = proibidas.listar ? proibidas.listar() : null;
  settings.set('mineracao_palavras_proibidas', 'vape');
  try {
    const antes = enviados.length;
    repostar.receber(null, mensagem('🔥 Achadinho do dia\nhttps://www.amazon.com.br/dp/B0F81WGSYP?tag=outro-20'));
    await ate(() => registro().some(r => r.chave === 'amazon:B0F81WGSYP'));
    const r = registro().find(x => x.chave === 'amazon:B0F81WGSYP');
    assert.equal(r.situacao, 'postada', r.motivo);
    assert.equal(enviados.length, antes + 1);
    assert.match(enviados.at(-1).texto, /661/);
  } finally { amazon.lerProduto = ler; if (antesLista) settings.set('mineracao_palavras_proibidas', antesLista.join(', ')); }
});

test('botões do registro: Enviar no grupo posta a oferta barrada; Apagar e Apagar todas limpam o registro', async () => {
  configurar({ repost_desconto_min: '50' });
  repostar.receber(null, mensagem('Teclado Mecânico Repostar Botão\nDe R$ 200,00 Por R$ 150,00\nhttps://www.amazon.com.br/dp/B0REPOST20'));
  await ate(() => registro().some(r => r.chave === 'amazon:B0REPOST20'));
  const barrada = registro().find(r => r.chave === 'amazon:B0REPOST20');
  assert.equal(barrada.situacao, 'ignorada');
  assert.match(barrada.motivo, /abaixo do mínimo/);
  const antes = enviados.length;
  const r = await repostar.enviarDoRegistro(null, barrada.id);
  assert.equal(r.ok, true);
  assert.equal(enviados.length, antes + 1);
  assert.equal(enviados.at(-1).destino, DESTINO);
  assert.equal(db.get('SELECT situacao FROM repostar_registro WHERE id = ?', barrada.id).situacao, 'postada');
  // Oferta relâmpago: o aviso vai no começo da mensagem
  db.run(`UPDATE offers SET relampago_fim = datetime('now', '+2 hours'), relampago_tipo = 'loja' WHERE id = ?`, barrada.offer_id);
  const texto = social.textoPadrao(db.get('SELECT * FROM offers WHERE id = ?', barrada.offer_id), settings.getAll());
  assert.match(texto, /^⚡🔥 \*OFERTA RELÂMPAGO\* 🔥⚡/);
  // Apagar uma e depois todas
  assert.deepEqual(repostar.apagarRegistro(null, barrada.id), { apagadas: 1 });
  assert.ok(registro().length > 0);
  repostar.apagarRegistro(null);
  assert.equal(registro().length, 0);
  await assert.rejects(repostar.enviarDoRegistro(null, barrada.id), /não está mais no registro/);
});
