// Envio aos grupos: entrega por grupo, nova tentativa, avisos, preço na hora, cliques, temas e repetição.
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ofertou-envio-'));
const db = require('../src/db');
const settings = require('../src/settings');
const whatsapp = require('../src/whatsapp');
const social = require('../src/social');
const agenda = require('../src/agenda');
const envio = require('../src/envio-grupos');
const avisos = require('../src/envio-avisos');
const precoNaHora = require('../src/preco-na-hora');
const busca = require('../src/busca-ofertas');
const { getStore } = require('../src/stores');
require('../src/ganhos'); // cria a tabela dos avisos do painel

social.ajustes.pausaEntreGrupos = false;
agenda._paraTestes({ pausa: false });

const GRUPOS = [{ id: '120363000000000001@g.us', nome: 'Todos' }, { id: '120363000000000002@g.us', nome: 'Tecnologia', categorias: ['informatica'] }];
let enviados = [];
let falhar = null;
let conectado = true;
whatsapp.enviar = async (s, grupo, msg) => { const e = falhar && falhar(grupo); if (e) throw e; enviados.push({ grupo, ...msg }); return 'id'; };
whatsapp.config = () => ({ tipo: 'proprio', dono: 'site' });
whatsapp.status = async () => ({ conectado, mensagem: conectado ? 'ok' : 'Número desconectado.' });
let fotoFalha = () => false;
const FOTO = Buffer.from('foto');
const pedidasDeFoto = [];
whatsapp.fotoParaEnvio = async url => { pedidasDeFoto.push(url); if (fotoFalha(url)) throw new Error('Não consegui baixar a foto (erro 403).'); return FOTO; };

function limpar() {
  for (const t of ['social_posts', 'envio_grupo', 'post_queue', 'admin_notificacoes', 'offers']) db.run(`DELETE FROM ${t}`);
  enviados = []; falhar = null; conectado = true; fotoFalha = () => false; pedidasDeFoto.length = 0;
  agenda._paraTestes({ limparFotos: true });
  settings.set('site_url', 'https://exemplo.test');
  settings.set('whatsapp_groups', JSON.stringify(GRUPOS));
  settings.set('agenda_redes', JSON.stringify(['whatsapp']));
  settings.set('agenda_ativa', '1');
  settings.set('agenda_completar', '1');
  settings.set('agenda_qtd', '1');
  settings.set('agenda_nota_minima', '0'); // a nota de viral tem testes próprios (test/nota-grupos.test.js)
  settings.set('smtp_host', '');
}
let seq = 0;
function oferta(extra = {}) {
  seq++;
  const o = { store_id: 'amazon', store_product_id: `P${seq}`, plataforma: 'Amazon', produto: `Produto ${seq} unico${seq}`, preco_atual: 80, preco_anterior: 100, desconto_pct: 20, categoria: 'informatica', imagem: 'https://img.test/a.jpg', original_url: `https://www.amazon.com.br/dp/B00000000${seq}`, ...extra };
  const k = Object.keys(o);
  return Number(db.run(`INSERT INTO offers (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`, ...k.map(x => o[x])).lastInsertRowid);
}
const envios = () => db.all('SELECT * FROM envio_grupo ORDER BY id');
const atualizarBusca = () => busca.atualizar();
const voltarHoras = (id, h) => db.run(`UPDATE envio_grupo SET created_at = datetime('now', ?), proxima_em = datetime('now', '-1 minutes') WHERE id = ?`, `-${h * 60} minutes`, id);
const vencer = id => db.run(`UPDATE envio_grupo SET proxima_em = datetime('now', '-1 minutes') WHERE id = ?`, id);
const avisosDoSite = () => db.all('SELECT titulo, texto FROM admin_notificacoes');

test('entrega por grupo: cada grupo recebe um link próprio e o clique conta', async () => {
  limpar();
  const id = oferta();
  const [r] = await social.publicar(id, ['whatsapp'], `Oferta\nhttps://exemplo.test/o/${id}`, 'teste');
  assert.equal(r.ok, true);
  assert.equal(enviados.length, 2);
  assert.notEqual(enviados[0].texto, enviados[1].texto);
  assert.match(enviados[0].texto, /https:\/\/exemplo\.test\/p\/[\w-]+$/);
  assert.ok(!enviados[0].texto.includes('/o/'));
  const [a] = envios();
  assert.equal(a.situacao, 'enviado');
  assert.equal(a.texto, null);
  const e = envio.porToken(a.token);
  assert.equal(envio.registrarClique(e, '1.1.1.1'), true);
  assert.equal(envio.registrarClique(e, '1.1.1.1'), false, 'a mesma pessoa conta uma vez por hora');
  assert.equal(envio.registrarClique(e, '2.2.2.2'), true);
  assert.equal(envios()[0].cliques, 2);
  const res = envio.resultados(null, 30);
  assert.equal(res.total.envios, 2);
  assert.equal(res.total.cliques, 2);
  assert.equal(res.grupos[0].nome, 'Todos');
  assert.equal(res.temas[0].nome, 'Informática');
  assert.equal(res.horas.length, 1);
  assert.equal(envio.porToken('../../x'), null);
});

test('sem site público o envio sai normal, sem link próprio', async () => {
  limpar();
  settings.set('site_url', '');
  const id = oferta();
  await social.publicar(id, ['whatsapp'], 'Oferta https://www.amazon.com.br/dp/X', 'teste');
  assert.equal(enviados[0].texto, 'Oferta https://www.amazon.com.br/dp/X');
  assert.equal(envios()[0].rastreado, 0);
});

test('o erro nunca fica sem motivo', async () => {
  limpar();
  falhar = () => Object.assign(new AggregateError([new Error('connect ECONNREFUSED')], ''), {});
  const id = oferta();
  const [r] = await social.publicar(id, ['whatsapp'], 'x', 'teste');
  assert.equal(r.ok, false);
  assert.match(r.mensagem, /ECONNREFUSED/);
  assert.match(db.get('SELECT mensagem FROM social_posts WHERE ok = 0').mensagem, /ECONNREFUSED/);
});

test('grupo que falha entra em nova tentativa, usa o mesmo link e aparece como entregue', async () => {
  limpar();
  falhar = g => (g === GRUPOS[1].id ? new Error('grupo fora') : null);
  const id = oferta();
  const [r] = await social.publicar(id, ['whatsapp'], `Oferta https://exemplo.test/o/${id}`, 'teste');
  assert.equal(r.ok, true);
  assert.match(r.mensagem, /nova tentativa em 5 min em 1 grupo/);
  const f = envios().find(x => x.grupo_id === GRUPOS[1].id);
  assert.equal(f.situacao, 'tentando');
  await envio.rodarTentativas();
  assert.equal(enviados.length, 1, 'não tenta antes da hora');

  vencer(f.id);
  await envio.rodarTentativas();
  let g = envios().find(x => x.id === f.id);
  assert.equal(g.tentativas, 2);
  assert.equal(g.situacao, 'tentando');

  falhar = null;
  vencer(f.id);
  await envio.rodarTentativas();
  g = envios().find(x => x.id === f.id);
  assert.equal(g.situacao, 'enviado');
  assert.ok(enviados.at(-1).texto.endsWith(`/p/${f.token}`));
  assert.equal(envio.resultados(null, 30).total.recuperados, 1);
});

test('depois de 3 tentativas desiste e avisa', async () => {
  limpar();
  falhar = () => new Error('sem permissão no grupo');
  const id = oferta();
  settings.set('whatsapp_groups', JSON.stringify([GRUPOS[0]]));
  await social.publicar(id, ['whatsapp'], 'x', 'teste');
  const [f] = envios();
  for (let i = 0; i < 2; i++) { vencer(f.id); await envio.rodarTentativas(); }
  const [g] = envios();
  assert.equal(g.situacao, 'falhou');
  assert.equal(g.tentativas, 3);
  assert.match(avisosDoSite()[0].titulo, /não chegou ao grupo Todos/);
  assert.match(avisosDoSite()[0].texto, /sem permissão/);
});

test('sem confirmação do envio não repete no grupo', async () => {
  limpar();
  falhar = () => Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' });
  settings.set('whatsapp_groups', JSON.stringify([GRUPOS[0]]));
  await social.publicar(oferta(), ['whatsapp'], 'x', 'teste');
  assert.equal(envios()[0].situacao, 'falhou');
  assert.match(envios()[0].erro, /não reenviei/);
});

test('número desconectado espera voltar sem gastar tentativa; oferta que mudou é cancelada', async () => {
  limpar();
  falhar = () => new Error('caiu');
  settings.set('whatsapp_groups', JSON.stringify([GRUPOS[0]]));
  const id = oferta();
  await social.publicar(id, ['whatsapp'], 'x', 'teste');
  const [f] = envios();
  conectado = false;
  vencer(f.id);
  await envio.rodarTentativas();
  assert.equal(envios()[0].tentativas, 1);
  assert.equal(envios()[0].situacao, 'tentando');
  conectado = true;
  db.run('UPDATE offers SET preco_atual = 70 WHERE id = ?', id);
  vencer(f.id);
  await envio.rodarTentativas();
  assert.equal(envios()[0].situacao, 'cancelado');
  voltarHoras(f.id, 2);
});

test('passou de 1 hora sem conseguir: desiste e avisa', async () => {
  limpar();
  falhar = () => new Error('caiu');
  settings.set('whatsapp_groups', JSON.stringify([GRUPOS[0]]));
  await social.publicar(oferta(), ['whatsapp'], 'x', 'teste');
  voltarHoras(envios()[0].id, 2);
  await envio.rodarTentativas();
  assert.equal(envios()[0].situacao, 'falhou');
  assert.equal(avisosDoSite().length, 1);
});

test('aviso: número fora do ar avisa uma vez, aparece no painel e avisa quando volta', async () => {
  limpar();
  conectado = false;
  await avisos.conferirDono(null);
  assert.equal(avisos.problema(null), null, 'uma queda rápida não vira aviso');
  await avisos.conferirDono(null);
  assert.equal(avisos.problema(null).mensagem, 'Número desconectado.');
  await avisos.conferirDono(null);
  assert.equal(avisosDoSite().length, 1);
  assert.match(avisosDoSite()[0].titulo, /fora do ar/);
  assert.equal(agenda.estado(null).problema.mensagem, 'Número desconectado.');
  conectado = true;
  await avisos.conferirDono(null);
  assert.equal(avisos.problema(null), null);
  assert.match(avisosDoSite().at(-1).titulo, /voltou/);
});

test('aviso: rodada do agendamento com falha e sem rede configurada', async () => {
  limpar();
  falhar = () => new Error('fora do ar');
  const id = oferta();
  agenda.enfileirar([{ offer_id: id, texto: 'x' }], 'teste');
  const r = await agenda.executar('horário 09:00');
  assert.equal(r.feitos[0].ok, false);
  assert.match(avisosDoSite()[0].titulo, /falharam/);
  assert.match(db.get('SELECT status, resultado FROM post_queue').status, /erro/);
  limpar();
  settings.set('whatsapp_groups', '[]');
  assert.match((await agenda.executar('horário 14:00')).erro, /Nenhuma rede/);
  assert.match(avisosDoSite()[0].titulo, /não saíram/);
});

test('preço na hora: loja sem API segue a regra de sempre', async () => {
  limpar();
  assert.equal((await precoNaHora.conferir(oferta())).situacao, 'sem_checagem');
  assert.equal((await precoNaHora.conferir(oferta({ store_id: 'shopee', fonte: 'manual' }))).situacao, 'sem_checagem');
});

test('preço na hora: igual, baixou, subiu, saiu e API fora do ar', async () => {
  limpar();
  const shopee = getStore('shopee');
  const original = shopee.porLink;
  settings.set('shopee_app_id', 'teste'); settings.set('shopee_app_secret', 'teste');
  const s = settings.getAll();
  const shp = () => oferta({ store_id: 'shopee', original_url: 'https://shopee.com.br/x-i.1.2' });
  const deal = (preco, anterior = 100) => async () => ({ status: 'ok', deals: [{ preco_atual: preco, preco_anterior: anterior }] });
  try {
    shopee.porLink = deal(80);
    assert.equal((await precoNaHora.conferir(shp(), s)).situacao, 'igual');

    shopee.porLink = deal(70);
    let id = shp();
    let c = await precoNaHora.conferir(id, s);
    assert.deepEqual([c.acao, c.situacao, c.precoAntigo], ['postar', 'baixou', 80]);
    let o = db.get('SELECT preco_atual, desconto_pct FROM offers WHERE id = ?', id);
    assert.deepEqual([o.preco_atual, o.desconto_pct], [70, 30]);
    assert.equal(db.get('SELECT price FROM price_history WHERE offer_id = ?', id).price, 70);

    shopee.porLink = deal(84);
    assert.equal((await precoNaHora.conferir(shp(), s)).situacao, 'subiu_pouco');

    shopee.porLink = deal(95);
    c = await precoNaHora.conferir(shp(), s);
    assert.deepEqual([c.acao, c.situacao], ['pular', 'subiu']);

    shopee.porLink = async () => ({ status: 'ok', deals: [] });
    id = shp();
    c = await precoNaHora.conferir(id, s);
    assert.deepEqual([c.acao, c.situacao], ['pular', 'saiu']);
    assert.equal(require('../src/offers').isActive(id), false);

    shopee.porLink = async () => { throw new Error('API fora'); };
    assert.equal((await precoNaHora.conferir(shp(), s)).situacao, 'sem_checagem');
    shopee.porLink = async () => ({ status: 'error', deals: [] });
    assert.equal((await precoNaHora.conferir(shp(), s)).acao, 'postar');

    // Com cupom, o preço da loja é o sem cupom
    shopee.porLink = deal(90);
    id = oferta({ store_id: 'shopee', original_url: 'https://shopee.com.br/x-i.1.3', cupom_codigo: 'ABC', preco_sem_cupom: 90 });
    assert.equal((await precoNaHora.conferir(id, s)).situacao, 'igual');
    shopee.porLink = deal(70);
    assert.equal((await precoNaHora.conferir(id, s)).acao, 'pular');
  } finally { shopee.porLink = original; settings.set('shopee_app_id', ''); settings.set('shopee_app_secret', ''); }
});

test('preço mudou: oferta da fila sai com o preço novo; a que encareceu dá lugar à próxima', async () => {
  limpar();
  const shopee = getStore('shopee');
  const original = shopee.porLink;
  settings.set('shopee_app_id', 'teste'); settings.set('shopee_app_secret', 'teste');
  settings.set('agenda_qtd', '2');
  settings.set('agenda_completar', '0');
  settings.set('whatsapp_groups', JSON.stringify([GRUPOS[0]]));
  const caiu = oferta({ store_id: 'shopee', store_product_id: 'CAIU', original_url: 'https://shopee.com.br/x-i.1.10' });
  const subiu = oferta({ store_id: 'shopee', store_product_id: 'SUBIU', original_url: 'https://shopee.com.br/x-i.1.11' });
  const normal = oferta();
  shopee.porLink = async url => ({ status: 'ok', deals: [{ preco_atual: url.endsWith('.10') ? 60 : 95, preco_anterior: 100 }] });
  try {
    agenda.enfileirar([{ offer_id: subiu, texto: 'De R$ 100,00 por R$ 80,00' }, { offer_id: caiu, texto: 'De R$ 100,00 por R$ 80,00' }, { offer_id: normal, texto: 'Normal' }], 'teste');
    const r = await agenda.executar('manual');
    assert.equal(r.feitos.length, 2);
    assert.equal(r.pulados.length, 1);
    assert.match(r.pulados[0].motivo, /subiu/);
    assert.equal(r.conferidos, 1);
    assert.match(db.get('SELECT status FROM post_queue WHERE offer_id = ?', subiu).status, /expirado/);
    assert.match(enviados[0].texto, /60,00/, 'refez o texto com o preço de agora');
    assert.doesNotMatch(enviados[0].texto, /por R\$ 80,00/);
    assert.equal(enviados[1].texto, 'Normal');
  } finally { shopee.porLink = original; settings.set('shopee_app_id', ''); settings.set('shopee_app_secret', ''); }
});

test('temas: cada grupo recebe só o seu tema; grupo sem tema recebe tudo', async () => {
  limpar();
  await social.publicar(oferta({ categoria: 'casa' }), ['whatsapp'], 'casa', 'teste');
  assert.deepEqual(enviados.map(e => e.grupo), [GRUPOS[0].id]);
  enviados = [];
  await social.publicar(oferta({ categoria: 'informatica' }), ['whatsapp'], 'pc', 'teste');
  assert.deepEqual(enviados.map(e => e.grupo), [GRUPOS[0].id, GRUPOS[1].id]);

  settings.set('whatsapp_groups', JSON.stringify([GRUPOS[1]]));
  const [r] = await social.publicar(oferta({ categoria: 'casa' }), ['whatsapp'], 'casa', 'teste');
  assert.equal(r.ok, false);
  assert.match(r.mensagem, /deste tipo e desta loja/);
});

test('temas: oferta da fila sem grupo do tema não conta como falha', async () => {
  limpar();
  settings.set('whatsapp_groups', JSON.stringify([GRUPOS[1]]));
  settings.set('agenda_completar', '0');
  agenda.enfileirar([{ offer_id: oferta({ categoria: 'casa' }), texto: 'x' }], 'teste');
  const r = await agenda.executar('manual');
  assert.equal(r.feitos.length, 0);
  assert.match(db.get('SELECT resultado FROM post_queue').resultado, /deste tipo e desta loja/);
  assert.equal(avisosDoSite().length, 0);
});

test('temas e repetição na escolha automática', async () => {
  limpar();
  settings.set('whatsapp_groups', JSON.stringify([
    { id: 'a@g.us', nome: 'A', categorias: ['informatica'] }, { id: 'b@g.us', nome: 'B', categorias: ['casa'] },
  ]));
  const pc = oferta({ produto: 'Notebook Acer Aspire Intel Core 512 Gb', categoria: 'informatica', preco_atual: 100, preco_anterior: 200, desconto_pct: 50 });
  const mesmoOutroVendedor = oferta({ produto: 'Notebook Acer Aspire Intel Core 512 Gb Prata', categoria: 'informatica', preco_atual: 99, preco_anterior: 200, desconto_pct: 50 });
  const cama = oferta({ produto: 'Jogo de cama solteiro algodao macio', categoria: 'casa', preco_atual: 50, preco_anterior: 100, desconto_pct: 50 });
  const tv = oferta({ produto: 'Smart TV grande fora dos temas', categoria: 'audio_tv', preco_atual: 50, preco_anterior: 100, desconto_pct: 50 });
  await atualizarBusca();
  const s = settings.getAll();

  let ids = agenda.melhoresOfertas(10, new Set(), null, s, { soTemas: true });
  assert.ok(ids.includes(cama));
  assert.ok(!ids.includes(tv), 'nada fora dos temas quando só há grupos com tema');
  assert.equal(ids.filter(i => i === pc || i === mesmoOutroVendedor).length, 1, 'o mesmo produto entra uma vez só');
  assert.ok(agenda.melhoresOfertas(10, new Set(), null, s).includes(tv), 'sem a regra, todas continuam disponíveis');

  // Cada grupo tem a sua vez
  const primeiro = agenda.melhoresOfertas(1, new Set(), null, s, { girar: true })[0];
  const segundo = agenda.melhoresOfertas(1, new Set(), null, s, { girar: true })[0];
  assert.notEqual(primeiro, segundo);

  // Repetição: postado há pouco não volta, nem por outro vendedor
  db.run(`INSERT INTO social_posts (offer_id, produto, rede, ok, preco, created_at) VALUES (?, ?, 'whatsapp', 1, 100, datetime('now', '-48 hours'))`, pc, 'Notebook Acer Aspire Intel Core 512 Gb');
  ids = agenda.melhoresOfertas(10, new Set(), null, s);
  assert.ok(!ids.includes(pc) && !ids.includes(mesmoOutroVendedor), 'preço igual não repete');

  // Só produto novo vai para os grupos: o preço caiu muito, mas o produto já foi postado. Só o site é atualizado.
  db.run("UPDATE offers SET preco_atual = 60, desconto_pct = 70, updated_at = datetime('now', '+1 minutes') WHERE id = ?", pc);
  await atualizarBusca();
  assert.ok(!agenda.melhoresOfertas(10, new Set(), null, s).includes(pc), 'preço novo não faz o produto voltar aos grupos');
  db.run(`UPDATE social_posts SET created_at = datetime('now', '-20 days') WHERE offer_id = ?`, pc);
  assert.ok(!agenda.melhoresOfertas(10, new Set(), null, s).includes(pc), 'nem 20 dias depois');

  // Passaram 30 dias: livre (se ainda for oferta nova)
  db.run(`UPDATE social_posts SET created_at = datetime('now', '-31 days') WHERE offer_id = ?`, pc);
  assert.ok(agenda.melhoresOfertas(10, new Set(), null, s).includes(pc));
});

test('só ofertas novas completam a rodada', async () => {
  limpar();
  settings.set('whatsapp_groups', JSON.stringify([GRUPOS[0]]));
  const nova = oferta({ produto: 'Air fryer nova encontrada agora', desconto_pct: 50 });
  const antiga = oferta({ produto: 'Liquidificador encontrado faz dias', desconto_pct: 50 });
  db.run(`UPDATE offers SET created_at = datetime('now', '-3 days') WHERE id = ?`, antiga);
  await atualizarBusca();
  const s = settings.getAll();
  let ids = agenda.melhoresOfertas(10, new Set(), null, s);
  assert.ok(ids.includes(nova));
  assert.ok(!ids.includes(antiga), 'encontrada há 3 dias não é mais oferta nova (padrão: 24 h)');
  ids = agenda.melhoresOfertas(10, new Set(), null, { ...s, agenda_novas_horas: '0' });
  assert.ok(ids.includes(antiga), '0 = qualquer oferta ainda não postada');
});

test('fila curta e atual: sai o que esperou demais e, passando do limite, as mais antigas', () => {
  limpar();
  settings.set('agenda_fila_horas', '6');
  settings.set('agenda_fila_max', '3');
  const ids = Array.from({ length: 6 }, (_, i) => oferta({ produto: `Produto da fila ${i}` }));
  agenda.enfileirar([{ offer_id: ids[0] }], 'teste');
  db.run(`UPDATE post_queue SET created_at = datetime('now', '-7 hours') WHERE offer_id = ?`, ids[0]);
  for (const [i, id] of ids.slice(1).entries()) {
    agenda.enfileirar([{ offer_id: id }], 'teste');
    db.run(`UPDATE post_queue SET created_at = datetime('now', ?) WHERE offer_id = ?`, `-${50 - i} minutes`, id);
  }
  agenda.arrumarFila();
  const fila = agenda.listarFila().filter(q => q.status === 'pendente').map(q => q.offer_id);
  assert.deepEqual(fila, [ids[5], ids[4], ids[3]], 'ficam as 3 mais novas, a mais nova primeiro');
  assert.match(db.get('SELECT resultado FROM post_queue WHERE offer_id = ?', ids[0]).resultado, /mais de 6 h/);
  assert.match(db.get('SELECT resultado FROM post_queue WHERE offer_id = ?', ids[1]).resultado, /passou de 3/);
  settings.set('agenda_fila_max', '20');
});

test('impressão do produto ignora ordem, acento e palavras vazias', () => {
  assert.equal(agenda.impressaoDoProduto('Fone de Ouvido Bluetooth JBL'), agenda.impressaoDoProduto('fone ouvido JBL bluetooth'));
  assert.notEqual(agenda.impressaoDoProduto('Fone JBL Tune 510'), agenda.impressaoDoProduto('Fone JBL Tune 720'));
});

test('limpa os registros antigos', () => {
  limpar();
  const id = oferta();
  db.run(`INSERT INTO envio_grupo (token, offer_id, grupo_id, situacao, created_at) VALUES ('velhoo', ?, 'x', 'enviado', datetime('now', '-181 days')), ('novooo', ?, 'x', 'enviado', datetime('now', '-179 days'))`, id, id);
  envio.limpar();
  assert.deepEqual(envios().map(e => e.token), ['novooo']);
});

test('escolher os grupos da postagem: por tipo ou todos, e o tipo que o nome sugere', () => {
  limpar();
  const s = settings.getAll();
  const escolhidos = [{ id: GRUPOS[1].id, nome: 'Tecnologia' }, { id: 'novo@g.us', nome: 'Ofertas Casa' }, { id: 'geral@g.us', nome: 'Promoções do dia' }];
  const porTipo = whatsapp.comDestinos(s, escolhidos, true);
  assert.deepEqual(whatsapp.gruposDaOferta(porTipo, 'informatica').map(g => g.id), [GRUPOS[1].id, 'geral@g.us']);
  assert.deepEqual(whatsapp.gruposDaOferta(porTipo, 'cozinha').map(g => g.id), ['novo@g.us', 'geral@g.us']);
  const todos = whatsapp.comDestinos(s, escolhidos, false);
  assert.equal(whatsapp.gruposDaOferta(todos, 'cozinha').length, 3);
});

test('tipos de produto: pelo nome do grupo e pela categoria da oferta', () => {
  const temas = require('../src/temas-grupos');
  assert.deepEqual(temas.temasDoNome('Ofertas Tech 2'), ['tecnologia']);
  assert.deepEqual(temas.temasDoNome('Promoções de Automóveis'), ['automoveis']);
  assert.deepEqual(temas.temasDoNome('CASA & Cozinha'), ['casa']);
  assert.deepEqual(temas.temasDoNome('Grupo Popular'), [], 'lar dentro de popular não conta');
  assert.equal(temas.temaDaCategoria('celulares').nome, 'Tecnologia');
  assert.equal(temas.temaDaCategoria('automotivo').id, 'automoveis');
  assert.equal(temas.temaDaCategoria('x').id, 'outros');
  const { CATEGORIAS } = busca;
  const cobertas = new Set(temas.listar().flatMap(t => t.categorias));
  assert.deepEqual(Object.keys(CATEGORIAS).filter(c => !cobertas.has(c)), ['outros'], 'toda categoria tem um tipo');
});

test('fila guarda os grupos escolhidos e a rodada usa só eles', async () => {
  limpar();
  settings.set('agenda_completar', '0');
  const id = oferta({ categoria: 'casa' });
  agenda.enfileirar([{ offer_id: id, texto: 'x', destino: { grupos: [{ id: 'esse@g.us', nome: 'Só este' }], por_tipo: false } }], 'teste');
  const r = await agenda.executar('manual');
  assert.equal(r.feitos[0].ok, true);
  assert.deepEqual(enviados.map(e => e.grupo), ['esse@g.us']);
});

test('postar pela API: confere os grupos, o tipo e sai só para quem deve', async () => {
  limpar();
  const proprio = require('../src/whatsapp-proprio');
  const postar = require('../src/postar');
  const orig = proprio.carregarGrupos;
  proprio.carregarGrupos = async () => [{ id: 'tec@g.us', nome: 'Grupo Tech' }, { id: 'casa@g.us', nome: 'Grupo Casa' }];
  try {
    const id = oferta({ categoria: 'informatica' });
    await assert.rejects(postar.postar(null, { offerId: id, grupos: ['alheio@g.us'], autor: 'API' }), /não é deste número/);
    await assert.rejects(postar.postar(null, { offerId: 999999, autor: 'API' }), /não encontrada/);
    await assert.rejects(postar.postar(null, { offerId: id, grupos: ['casa@g.us'], autor: 'API' }), /tipo de produto/);
    const r = await postar.postar(null, { offerId: id, grupos: ['tec@g.us', 'casa@g.us'], texto: 'Texto próprio', autor: 'API' });
    assert.deepEqual(r.grupos.map(g => g.id), ['tec@g.us']);
    await new Promise(res => setTimeout(res, 50));
    assert.deepEqual(enviados.map(e => e.grupo), ['tec@g.us']);
    assert.equal(enviados[0].texto, 'Texto próprio');
    assert.equal(db.get('SELECT autor FROM social_posts').autor, 'API');
  } finally { proprio.carregarGrupos = orig; }
});

test('brinquedo em forma de carro não vai para o grupo de automóveis', () => {
  const { classifyCategory } = require('../src/categorize');
  for (const nome of ['Carrinho de criança três em um de alta visão', 'Carrinho Controle Remoto Rally Jipe Max Carro Grande', 'Carro de Controle Remoto Sem Fio Lamborgini', 'Carro Vira Robo Carrinho BMW Brinquedo Menino']) {
    assert.equal(classifyCategory(nome), 'brinquedos', nome);
  }
  for (const nome of ['Pneu Aro 15 Para Carro', 'Som Automotivo Bluetooth', 'Capacete Para Moto Fechado']) {
    assert.equal(classifyCategory(nome), 'automotivo', nome);
  }
});

test('lojas de cada grupo: tipo e loja valem juntos, em todos os envios', async () => {
  limpar();
  const L = id => db.get('SELECT store_id FROM offers WHERE id = ?', id).store_id;
  settings.set('whatsapp_groups', JSON.stringify([
    { id: 'tudo@g.us', nome: 'Tudo' },
    { id: 'ml@g.us', nome: 'Só ML', lojas: ['mercadolivre'] },
    { id: 'shp@g.us', nome: 'Tech Shopee', categorias: ['informatica'], lojas: ['shopee'] },
  ]));
  const s = settings.getAll();
  const ids = lista => lista.map(g => g.id);
  assert.deepEqual(ids(whatsapp.gruposDaOferta(s, 'casa', 'amazon')), ['tudo@g.us']);
  assert.deepEqual(ids(whatsapp.gruposDaOferta(s, 'casa', 'mercadolivre')), ['tudo@g.us', 'ml@g.us']);
  assert.deepEqual(ids(whatsapp.gruposDaOferta(s, 'informatica', 'shopee')), ['tudo@g.us', 'shp@g.us']);
  assert.deepEqual(ids(whatsapp.gruposDaOferta(s, 'casa', 'shopee')), ['tudo@g.us'], 'loja certa e tipo errado não recebe');

  const shopee = oferta({ store_id: 'shopee', categoria: 'informatica' });
  assert.equal(L(shopee), 'shopee');
  await social.publicar(shopee, ['whatsapp'], 'x', 'teste');
  assert.deepEqual(enviados.map(e => e.grupo), ['tudo@g.us', 'shp@g.us']);

  // Escolhendo os grupos da postagem: por tipo respeita a loja; "todos" não
  const escolhidos = [{ id: 'ml@g.us', nome: 'Só ML' }, { id: 'shp@g.us', nome: 'Tech Shopee' }];
  assert.deepEqual(ids(whatsapp.gruposDaOferta(whatsapp.comDestinos(s, escolhidos, true), 'informatica', 'mercadolivre')), ['ml@g.us']);
  assert.equal(whatsapp.gruposDaOferta(whatsapp.comDestinos(s, escolhidos, false), 'casa', 'amazon').length, 2);

  // Agendamento: oferta da fila que nenhum grupo recebe é descartada, sem contar como falha
  settings.set('whatsapp_groups', JSON.stringify([{ id: 'ml@g.us', nome: 'Só ML', lojas: ['mercadolivre'] }]));
  settings.set('agenda_completar', '0');
  enviados = [];
  agenda.enfileirar([{ offer_id: oferta({ store_id: 'amazon' }), texto: 'x' }], 'teste');
  const r = await agenda.executar('manual');
  assert.equal(r.feitos.length, 0);
  assert.equal(enviados.length, 0);
  assert.match(db.get('SELECT resultado FROM post_queue').resultado, /desta loja/);
});

test('lojas na escolha automática: só o que algum grupo recebe, e cada grupo na sua vez', async () => {
  limpar();
  settings.set('whatsapp_groups', JSON.stringify([
    { id: 'ml@g.us', nome: 'ML', lojas: ['mercadolivre'] }, { id: 'shp@g.us', nome: 'Shopee', lojas: ['shopee'] },
  ]));
  const barata = { preco_atual: 50, preco_anterior: 100, desconto_pct: 50 };
  const ml = oferta({ ...barata, store_id: 'mercadolivre', produto: 'Fone de ouvido bluetooth modelo alfa', categoria: 'audio_tv' });
  const shp = oferta({ ...barata, store_id: 'shopee', produto: 'Liquidificador potente modelo beta', categoria: 'cozinha' });
  const amz = oferta({ ...barata, store_id: 'amazon', produto: 'Mochila resistente modelo gama', categoria: 'moda' });
  await busca.atualizar();
  const s = settings.getAll();
  const so = agenda.melhoresOfertas(10, new Set(), null, s, { soTemas: true });
  assert.ok(so.includes(ml) && so.includes(shp));
  assert.ok(!so.includes(amz), 'nenhum grupo recebe Amazon');
  const a = agenda.melhoresOfertas(1, new Set(), null, s, { soTemas: true, girar: true })[0];
  const b = agenda.melhoresOfertas(1, new Set(), null, s, { soTemas: true, girar: true })[0];
  assert.deepEqual([a, b].sort(), [ml, shp].sort());
});

test('foto recusada: nada vai ao grupo, entra a oferta seguinte e não vira erro', async () => {
  limpar();
  fotoFalha = url => url.includes('magalu');
  const ruim = oferta({ store_id: 'magalu', plataforma: 'Magalu', imagem: 'https://a-static.mlcdn.com.br/magalu.jpg', original_url: 'https://www.magazineluiza.com.br/p/ruim' });
  const boa = oferta();
  agenda.enfileirar([{ offer_id: ruim, texto: 'oferta ruim' }, { offer_id: boa, texto: 'oferta boa' }], 'teste');
  const r = await agenda.executar('horário 09:00');
  assert.deepEqual(r.feitos.map(f => [f.offer_id, f.ok]), [[boa, true]]);
  assert.equal(enviados.length, 2);
  assert.ok(enviados.every(e => e.texto.includes('oferta boa') && e.imagem === FOTO), 'sai com a foto já baixada, sem pedir de novo à loja');
  assert.equal(envios().filter(e => e.offer_id === ruim).length, 0, 'nem começa o envio da oferta recusada');
  assert.equal(db.get('SELECT status FROM post_queue WHERE offer_id = ?', ruim).status, 'expirado');
  assert.match(db.get('SELECT resultado FROM post_queue WHERE offer_id = ?', ruim).resultado, /recusou a foto/);
  assert.equal(r.pulados[0].foto, true);
  assert.equal(avisosDoSite().length, 0, 'sem aviso de falha: a rodada saiu certa');
});

test('foto recusada: completa a rodada com as melhores ofertas e evita a mesma foto por um tempo', async () => {
  limpar();
  settings.set('agenda_qtd', '2');
  fotoFalha = url => url.includes('ruim');
  const ruim = oferta({ produto: 'Cafeteira eletrica expresso inox grande', imagem: 'https://img.test/ruim.jpg', preco_atual: 100, preco_anterior: 200, desconto_pct: 50 });
  const boa1 = oferta({ produto: 'Ventilador coluna silencioso branco', categoria: 'casa', preco_atual: 50, preco_anterior: 100, desconto_pct: 50 });
  const boa2 = oferta({ produto: 'Caixa de som portatil resistente agua', categoria: 'audio_tv', preco_atual: 50, preco_anterior: 100, desconto_pct: 50 });
  db.run(`UPDATE offers SET updated_at = datetime('now', '+1 minutes')`); // a lista de ofertas só remonta se algo mudar
  await atualizarBusca();
  const r = await agenda.executar('horário 10:00');
  assert.deepEqual(r.feitos.map(f => f.offer_id).sort(), [boa1, boa2].sort());
  assert.ok(r.pulados.some(p => p.offer_id === ruim));
  const pedidas = pedidasDeFoto.filter(u => u.includes('ruim')).length;
  assert.equal(pedidas, 1);
  db.run('DELETE FROM social_posts');
  await agenda.executar('horário 11:00');
  assert.equal(pedidasDeFoto.filter(u => u.includes('ruim')).length, pedidas, 'não pede de novo a foto recusada há pouco');
});

test('foto recusada e nenhuma outra oferta: avisa pela foto, sem enviar nada', async () => {
  limpar();
  settings.set('agenda_completar', '0');
  fotoFalha = () => true;
  const id = oferta();
  agenda.enfileirar([{ offer_id: id, texto: 'x' }], 'teste');
  const r = await agenda.executar('horário 12:00');
  assert.equal(r.feitos.length, 0);
  assert.equal(enviados.length, 0);
  assert.match(avisosDoSite()[0].titulo, /recusaram as fotos/);
});

test('outro erro no envio continua como antes, e foto baixada não atrapalha as outras redes', async () => {
  limpar();
  falhar = () => new Error('fora do ar');
  const id = oferta();
  agenda.enfileirar([{ offer_id: id, texto: 'x' }], 'teste');
  const r = await agenda.executar('horário 13:00');
  assert.equal(r.feitos[0].ok, false);
  assert.match(avisosDoSite()[0].titulo, /falharam/);
});

test('nota de viral: só o que tem cara de vender completa a rodada', async () => {
  limpar();
  settings.set('agenda_nota_minima', '60');
  settings.set('whatsapp_groups', JSON.stringify([GRUPOS[0]]));
  const viral = oferta({ produto: 'Fone de Ouvido JBL Tune 520BT Bluetooth', preco_atual: 69.9, preco_anterior: 149.9, desconto_pct: 53, categoria: 'audio_tv' });
  db.run('UPDATE offers SET vendidos = 12000, avaliacao = 4.8 WHERE id = ?', viral);
  const comum = oferta({ produto: 'Camisa Social Masculina Slim Manga Longa', preco_atual: 66, preco_anterior: 80, desconto_pct: 18, categoria: 'moda' });
  const nicho = oferta({ produto: 'Processador AMD Ryzen 5 5500 3.6GHz', preco_atual: 589, preco_anterior: 800, desconto_pct: 26 });
  await atualizarBusca();
  const ids = agenda.melhoresOfertas(10, new Set(), null, settings.getAll());
  assert.deepEqual(ids, [viral], 'a comum e a peça de computador ficam de fora');
  settings.set('agenda_nota_minima', '0');
  assert.ok(agenda.melhoresOfertas(10, new Set(), null, settings.getAll()).includes(comum), 'nota mínima 0: todas continuam disponíveis');
  assert.ok(nicho);
});

test('foto pequena ou em formato de faixa não vai ao grupo: entra a oferta seguinte', async () => {
  limpar();
  const sharp = require('sharp');
  const imagem = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
  const pequena = oferta({ imagem: 'https://img.test/pequena.jpg' });
  const faixa = oferta({ imagem: 'https://img.test/faixa.jpg' });
  const boa = oferta({ imagem: 'https://img.test/boa.jpg' });
  const fotos = { pequena: await imagem(200, 200), faixa: await imagem(1000, 300), boa: await imagem(800, 800) };
  const antes = whatsapp.fotoParaEnvio;
  whatsapp.fotoParaEnvio = async url => fotos[url.match(/(pequena|faixa|boa)/)[1]];
  try {
    agenda.enfileirar([{ offer_id: pequena, texto: 'pequena' }, { offer_id: faixa, texto: 'faixa' }, { offer_id: boa, texto: 'boa' }], 'teste');
    const r = await agenda.executar('horário 09:00');
    assert.deepEqual(r.feitos.map(f => f.offer_id), [boa]);
    assert.match(db.get('SELECT resultado FROM post_queue WHERE offer_id = ?', pequena).resultado, /pequena demais/);
    assert.match(db.get('SELECT resultado FROM post_queue WHERE offer_id = ?', faixa).resultado, /formato de faixa/);
    assert.equal(avisosDoSite().length, 0, 'não vira aviso de loja recusando foto');
  } finally { whatsapp.fotoParaEnvio = antes; }
});
