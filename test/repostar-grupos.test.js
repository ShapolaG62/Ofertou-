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
