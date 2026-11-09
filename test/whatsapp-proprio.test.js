// API própria de WhatsApp com um WhatsApp simulado: QR code, grupos do número, fotos, conversas, envio, queda de conexão e saída.
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ofertou-wa-'));
const proprio = require('../src/whatsapp-proprio');
const whatsapp = require('../src/whatsapp');
const settings = require('../src/settings');
const db = require('../src/db');
const net = require('../src/net');

const SITE = 'site', CLI = 'c:7';
const espera = ms => new Promise(r => setTimeout(r, ms));
async function ate(condicao) {
  for (let i = 0; i < 200; i++) { if (condicao()) return; await espera(10); }
  assert.fail('a condição não aconteceu a tempo');
}
const MEU = '5511999990000@s.whatsapp.net', MEU_LID = '999@lid';
const GRUPOS = {
  '120363000000000001@g.us': { id: '120363000000000001@g.us', subject: 'Ofertas Tech', size: 42, owner: MEU, participants: [{ id: MEU, admin: 'superadmin' }, { id: 'x@s.whatsapp.net' }] },
  '120363000000000002@g.us': { id: '120363000000000002@g.us', subject: 'Criado com LID', owner: MEU_LID, ownerPn: MEU, participants: [{ id: MEU_LID, phoneNumber: MEU, admin: 'admin' }] },
  '120363000000000003@g.us': { id: '120363000000000003@g.us', subject: 'Sou admin, mas outra pessoa criou', owner: 'x@s.whatsapp.net', participants: [{ id: MEU, admin: 'admin' }] },
  '120363000000000004@g.us': { id: '120363000000000004@g.us', subject: 'Criei, mas perdi o admin', owner: MEU, participants: [{ id: MEU }] },
  '120363000000000005@g.us': { id: '120363000000000005@g.us', subject: 'Grupo de amigos', owner: 'x@s.whatsapp.net', participants: [{ id: MEU }] },
  '120363000000000006@g.us': { id: '120363000000000006@g.us', subject: 'Comunidade', isCommunity: true, owner: MEU, participants: [{ id: MEU, admin: 'superadmin' }] },
};
const G1 = '120363000000000001@g.us', G2 = '120363000000000002@g.us', G5 = '120363000000000005@g.us';

function simulado() {
  const ev = new EventEmitter();
  const s = {
    ev, enviados: [], fotosPedidas: [], user: { id: '5511999990000:7@s.whatsapp.net', lid: '999:7@lid', name: 'Teste' },
    end() { s.encerrado = true; },
    async logout() { s.saiu = true; },
    async groupFetchAllParticipating() { return GRUPOS; },
    async groupInviteCode() { return 'CODIGO'; },
    async profilePictureUrl(jid) { s.fotosPedidas.push(jid); return jid === G1 ? 'https://pps.whatsapp.net/foto.jpg' : undefined; },
    async onWhatsApp(j) { return [j.startsWith('5500') ? { exists: false } : { exists: true, jid: j }]; },
    async sendMessage(jid, conteudo, opcoes) {
      s.enviados.push({ jid, conteudo, opcoes });
      return { key: { id: opcoes.messageId, remoteJid: jid, fromMe: true }, message: { conversation: conteudo.text || conteudo.caption || '' }, messageTimestamp: Math.floor(Date.now() / 1000) };
    },
  };
  return s;
}
const criados = { [SITE]: [], [CLI]: [] };
let pareado = false;
proprio._paraTestes({ intervalo: 0, intervaloFotos: 0, criar: async dono => { const s = simulado(); criados[dono].push(s); return { sock: s, saveCreds: () => {}, pareado: () => pareado }; } });
const atual = (dono = SITE) => criados[dono][criados[dono].length - 1];
const entrante = (id, chat, texto, extra = {}) => ({ key: { id, remoteJid: chat, fromMe: false }, pushName: 'Ana', message: { conversation: texto }, messageTimestamp: Math.floor(Date.now() / 1000), ...extra });
async function ligar(dono = SITE) {
  pareado = true;
  await proprio.conectar(dono);
  atual(dono).ev.emit('connection.update', { connection: 'open' });
  await ate(() => proprio.status(dono).conectado);
  await proprio.carregarGrupos(dono);
}
const criarSessao = dono => { fs.mkdirSync(proprio.pastaSessao(dono), { recursive: true }); fs.writeFileSync(path.join(proprio.pastaSessao(dono), 'creds.json'), '{"me":{"id":"x"}}'); };

test('endereços de grupo e de celular em qualquer formato', () => {
  assert.equal(proprio.paraJid('120363000000000001@g.us'), G1);
  assert.equal(proprio.paraJid('120363000000000001-group'), G1);
  assert.equal(proprio.paraJid('5511999990000-1600000000'), '5511999990000-1600000000@g.us');
  assert.equal(proprio.paraJid('+55 (11) 99999-0000'), '5511999990000@s.whatsapp.net');
  assert.throws(() => proprio.paraJid('abc'));
});

test('lê texto, legenda e mensagens embrulhadas e ignora o que não é conversa', () => {
  const ler = (message, remoteJid = '1@s.whatsapp.net') => proprio.lerMensagem({ key: { id: 'A', remoteJid }, message });
  assert.equal(ler({ extendedTextMessage: { text: 'oi' } }).texto, 'oi');
  assert.equal(ler({ imageMessage: { caption: 'foto' } }).tipo, 'imagem');
  assert.equal(ler({ ephemeralMessage: { message: { conversation: 'some' } } }).texto, 'some');
  assert.equal(ler({ reactionMessage: { text: '👍' } }), null);
  assert.equal(ler({ conversation: 'x' }, 'status@broadcast'), null);
});

test('sem número conectado, o serviço diz o que falta', async () => {
  assert.match(whatsapp.config({}).erro, /Conecte o WhatsApp/);
  await assert.rejects(proprio.enviar(SITE, G1, { texto: 'oi' }), /não está conectado/);
});

test('QR code e conexão', async () => {
  pareado = false;
  await proprio.conectar(SITE);
  atual().ev.emit('connection.update', { qr: 'codigo-de-teste' });
  await ate(() => proprio.status(SITE).fase === 'qr');
  assert.match(proprio.status(SITE).qr, /^data:image\/png;base64,/);
  pareado = true;
  atual().ev.emit('connection.update', { connection: 'open' });
  await ate(() => proprio.status(SITE).conectado);
  assert.equal(proprio.status(SITE).numero, '5511999990000');
  assert.equal(proprio.status(SITE).qr, null);
  assert.equal(whatsapp.config({}).tipo, 'proprio');
});

test('vêm os grupos em que o número é administrador (criados por ele ou não)', async () => {
  const meus = await proprio.carregarGrupos(SITE);
  assert.deepEqual(meus.map(g => g.nome), ['Criado com LID', 'Ofertas Tech', 'Sou admin, mas outra pessoa criou']);
  assert.equal(meus.find(g => g.id === G1).membros, 42);
  const { ocultos } = await proprio.resumoGrupos(SITE);
  assert.equal(ocultos, 2);
  // Mensagens guardadas: só dos grupos que o número criou e administra (Política de Privacidade)
  assert.equal(db.get('SELECT meu_grupo FROM whatsapp_contatos WHERE dono = ? AND jid = ?', SITE, '120363000000000003@g.us').meu_grupo, 0);
  assert.equal(db.get('SELECT meu_grupo FROM whatsapp_contatos WHERE dono = ? AND jid = ?', SITE, G1).meu_grupo, 1);
  assert.equal((await proprio.carregarGrupos(SITE, { todos: true })).length, 5, 'comunidade nunca entra');
  assert.deepEqual((await whatsapp.listarGrupos({})).map(g => g.id).sort(), [G1, G2, '120363000000000003@g.us'].sort());
  // O total de membros é pedido também para grupo salvo antes
  assert.equal((await whatsapp.tamanhoGrupos({}, [G1])).get(G1), 42);
});

test('convite só de grupo do número', async () => {
  assert.equal(await proprio.convite(SITE, G1), 'https://chat.whatsapp.com/CODIGO');
  await assert.rejects(proprio.convite(SITE, G5), /não é deste número/);
});

test('foto: baixa uma vez, guarda 24 horas e quem não tem foto fica sem', async () => {
  const original = net.safeGet;
  const jpeg = await require('sharp')({ create: { width: 8, height: 8, channels: 3, background: '#0a0' } }).jpeg().toBuffer();
  let baixou = 0;
  net.safeGet = async () => { baixou++; return { status: 200, data: jpeg }; };
  try {
    const a = await proprio.foto(SITE, G1);
    assert.ok(fs.existsSync(a));
    assert.ok(a.startsWith(proprio.pastaFotos(SITE)));
    assert.equal(await proprio.foto(SITE, G1), a);
    assert.equal(baixou, 1, 'não baixa de novo');
    assert.equal(atual().fotosPedidas.length, 1);
    assert.equal(await proprio.foto(SITE, G2), null);
    assert.equal(await proprio.foto(SITE, G2), null);
    assert.equal(atual().fotosPedidas.filter(j => j === G2).length, 1, 'sem foto também fica guardado');
    await assert.rejects(proprio.foto(SITE, '../../senha'), /Destino inválido/);
  } finally { net.safeGet = original; }
});

test('lista de conversas e nomes ao conectar, sem guardar o histórico', () => {
  atual().ev.emit('messaging-history.set', {
    chats: [{ id: '5511911112222@s.whatsapp.net', conversationTimestamp: Math.floor(Date.now() / 1000) - 60 }, { id: '123@lid', name: 'Pelo LID' }, { id: 'status@broadcast' }],
    contacts: [{ id: '5511911112222@s.whatsapp.net', name: 'Maria Salva', notify: 'Mari' }],
    messages: [entrante('H1', '5511911112222@s.whatsapp.net', 'mensagem antiga')],
  });
  const lista = proprio.conversas(SITE);
  const maria = lista.find(c => c.chat === '5511911112222@s.whatsapp.net');
  assert.equal(maria.nome, 'Maria Salva');
  assert.equal(maria.grupo, false);
  assert.equal(lista.find(c => c.chat === '123@lid').nome, 'Pelo LID');
  assert.equal(proprio.mensagens(SITE, { chat: maria.chat }).length, 0, 'o histórico não fica guardado');
  assert.ok(!lista.some(c => /broadcast/.test(c.chat)));
  assert.ok(lista.some(c => c.chat === G1 && c.nome === 'Ofertas Tech' && c.grupo));
  assert.ok(!lista.some(c => c.chat === G5), 'grupo de outra pessoa não aparece');
  assert.ok(proprio.conversas(SITE, { tipo: 'grupos' }).every(c => c.grupo));
  assert.ok(proprio.conversas(SITE, { tipo: 'contatos' }).every(c => !c.grupo));
});

test('guarda o que chega e o que sai, sem repetir; de grupo alheio não guarda', () => {
  const chat = '5511977776666@s.whatsapp.net';
  atual().ev.emit('messages.upsert', { type: 'notify', messages: [entrante('M1', chat, 'olá'), entrante('M1', chat, 'olá')] });
  const lista = proprio.mensagens(SITE, { chat });
  assert.equal(lista.length, 1);
  assert.equal(lista[0].autor, 'Ana');
  atual().ev.emit('messages.upsert', { type: 'notify', messages: [entrante('M2', chat, 'tudo bem?')] });
  assert.deepEqual(proprio.mensagens(SITE, { chat, depois: lista[0].id }).map(m => m.texto), ['tudo bem?']);
  const c = proprio.conversas(SITE).find(x => x.chat === chat);
  assert.deepEqual([c.nome, c.texto], ['Ana', 'tudo bem?']);

  atual().ev.emit('messages.upsert', { type: 'notify', messages: [entrante('M3', G5, 'conversa dos amigos')] });
  assert.equal(proprio.mensagens(SITE, { chat: G5 }).length, 0);
  atual().ev.emit('messages.upsert', { type: 'notify', messages: [entrante('M4', G1, 'no meu grupo')] });
  assert.equal(proprio.mensagens(SITE, { chat: G1 }).length, 1);
});

test('envio pela fila: texto, foto em JPEG, número conferido e um de cada vez', async () => {
  await whatsapp.enviar({}, '120363000000000001-group', { texto: 'promoção' });
  assert.deepEqual(atual().enviados.at(-1).jid, G1);
  assert.ok(atual().enviados.at(-1).opcoes.messageId, 'o id sai daqui, para reconhecer o que esta API enviou');
  assert.ok(proprio.mensagens(SITE, { chat: G1 }).some(m => m.de_mim === 1));

  const png = await require('sharp')({ create: { width: 4, height: 4, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  await proprio.enviar(SITE, G1, { imagem: png, texto: 'legenda' });
  const { conteudo } = atual().enviados.at(-1);
  assert.equal(conteudo.caption, 'legenda');
  assert.equal(conteudo.image[0], 0xff, 'começa como JPEG');

  await assert.rejects(proprio.enviar(SITE, '5500999990000', { texto: 'oi' }), /não tem WhatsApp/);
  proprio._paraTestes({ intervalo: 60 });
  const inicio = Date.now();
  await Promise.all([1, 2, 3].map(n => proprio.enviar(SITE, G1, { texto: `n${n}` })));
  assert.ok(Date.now() - inicio >= 120);
  assert.deepEqual(atual().enviados.slice(-3).map(e => e.conteudo.text), ['n1', 'n2', 'n3']);
  proprio._paraTestes({ intervalo: 0 });
});

test('grupo de automação: o que você digita no celular vale; o que a API enviou e comando velho, não', async () => {
  settings.set('wa_grupo_controle', G2);
  const conta = () => atual().enviados.length;
  let antes = conta();
  atual().ev.emit('messages.upsert', { type: 'notify', messages: [entrante('V1', G2, 'ajuda', { messageTimestamp: Math.floor(Date.now() / 1000) - 3600 })] });
  await espera(40);
  assert.equal(conta(), antes, 'comando de uma hora atrás');

  // Digitado no celular conectado
  atual().ev.emit('messages.upsert', { type: 'notify', messages: [{ ...entrante('C1', G2, 'ajuda'), key: { id: 'C1', remoteJid: G2, fromMe: true } }] });
  await ate(() => conta() > antes);
  const resposta = atual().enviados.at(-1);
  assert.match(resposta.conteudo.text, /grupo de automação/);

  // A própria resposta chegando de volta não vira comando
  antes = conta();
  atual().ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: resposta.opcoes.messageId + 'x', remoteJid: G2, fromMe: true }, message: { conversation: 'sem comando' }, messageTimestamp: Math.floor(Date.now() / 1000) }] });
  await proprio.enviar(SITE, G2, { texto: 'ajuda' });
  const enviada = atual().enviados.at(-1).opcoes.messageId;
  antes = conta();
  atual().ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: enviada, remoteJid: G2, fromMe: true }, message: { conversation: 'ajuda' }, messageTimestamp: Math.floor(Date.now() / 1000) }] });
  await espera(40);
  assert.equal(conta(), antes);
  settings.set('wa_grupo_controle', '');
});

test('entradas e saídas dos grupos vão para o monitor de membros', () => {
  settings.set('whatsapp_groups', JSON.stringify([{ id: G1, nome: 'Ofertas Tech' }]));
  atual().ev.emit('group-participants.update', { id: G1, action: 'add', participants: ['a', 'b'] });
  assert.equal(db.get(`SELECT entradas FROM grupo_membros_dia WHERE grupo = '120363000000000001'`).entradas, 2);
});

test('site e cliente têm conexões separadas', async () => {
  db.run(`INSERT OR IGNORE INTO clientes (id, nome, email, senha_hash, validade) VALUES (7, 'Cliente', 'c7@exemplo.test', 'x', datetime('now', '+30 days'))`);
  assert.equal(proprio.status(CLI).conectado, false);
  await ligar(CLI);
  assert.equal(proprio.pastaSessao(CLI).endsWith('whatsapp-sessao-c7'), true);
  await whatsapp.enviar({ cliente_id: 7 }, G1, { texto: 'do cliente' });
  assert.equal(atual(CLI).enviados.at(-1).conteudo.text, 'do cliente');
  assert.ok(!atual().enviados.some(e => e.conteudo.text === 'do cliente'));
  atual(CLI).ev.emit('messages.upsert', { type: 'notify', messages: [entrante('CL1', '5511955554444@s.whatsapp.net', 'só do cliente')] });
  assert.equal(proprio.mensagens(CLI, { chat: '5511955554444@s.whatsapp.net' }).length, 1);
  assert.equal(proprio.mensagens(SITE, { chat: '5511955554444@s.whatsapp.net' }).length, 0, 'o site não vê as conversas do cliente');
  assert.ok(!proprio.conversas(SITE).some(c => c.chat === '5511955554444@s.whatsapp.net'));
  assert.throws(() => proprio.status('c:../x'), /inválido/);
});

test('aviso para outro programa: só https público e com assinatura', async () => {
  assert.throws(() => proprio.salvarWebhook(SITE, 'http://exemplo.test/a'), /https/);
  assert.throws(() => proprio.salvarWebhook(SITE, 'https://127.0.0.1/a'), /não permitido/);
  const { segredo, url } = proprio.salvarWebhook(SITE, 'https://exemplo.test/aviso');
  assert.ok(segredo);
  assert.deepEqual(proprio.lerWebhook(SITE), { url });
  const original = net.safePost;
  const chamadas = [];
  net.safePost = async (u, corpo, o) => { chamadas.push({ u, corpo, o }); return { status: 200 }; };
  try {
    atual().ev.emit('messages.upsert', { type: 'notify', messages: [entrante('W1', '5511944443333@s.whatsapp.net', 'aviso')] });
    assert.equal(chamadas.length, 1);
    const c = chamadas[0];
    assert.equal(JSON.parse(c.corpo).dados.texto, 'aviso');
    const esperado = require('crypto').createHmac('sha256', segredo).update(c.corpo).digest('hex');
    assert.equal(c.o.headers['X-Ofertou-Assinatura'], `sha256=${esperado}`);
  } finally { net.safePost = original; }
  proprio.salvarWebhook(SITE, '');
  assert.deepEqual(proprio.lerWebhook(SITE), { url: null });
});

test('conexão caída tenta de novo; 515 reabre na hora', async () => {
  const n = criados[SITE].length;
  atual().ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await ate(() => criados[SITE].length === n + 1);
  atual().ev.emit('connection.update', { connection: 'open' });
  await ate(() => proprio.status(SITE).conectado);
  atual().ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
  assert.equal(proprio.status(SITE).fase, 'reconectando');
  await assert.rejects(proprio.enviar(SITE, G1, { texto: 'x' }), /não está conectado/);
  await proprio.conectar(SITE);
  atual().ev.emit('connection.update', { connection: 'open' });
  await ate(() => proprio.status(SITE).conectado);
});

test('bloqueio e sessão aberta em outro lugar não ficam tentando sem parar', async () => {
  for (const [codigo, texto] of [[403, /recusou/], [440, /outro lugar/]]) {
    const n = criados[SITE].length;
    atual().ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: codigo } } } });
    assert.equal(proprio.status(SITE).fase, 'desligado');
    assert.match(proprio.status(SITE).erro, texto);
    await espera(30);
    assert.equal(criados[SITE].length, n);
    await proprio.conectar(SITE);
    atual().ev.emit('connection.update', { connection: 'open' });
    await ate(() => proprio.status(SITE).conectado);
  }
});

test('QR code vencido para e pede para gerar outro', async () => {
  await proprio.desconectar(SITE);
  pareado = false;
  await proprio.conectar(SITE);
  atual().ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
  assert.equal(proprio.status(SITE).fase, 'desligado');
  assert.match(proprio.status(SITE).erro, /venceu/);
});

test('o WhatsApp desconectar o aparelho apaga a sessão salva', async () => {
  await ligar(SITE);
  criarSessao(SITE);
  assert.equal(proprio.status(SITE).sessao_salva, true);
  atual().ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  assert.equal(proprio.status(SITE).fase, 'desligado');
  assert.equal(fs.existsSync(proprio.pastaSessao(SITE)), false);
});

test('desconectar sai da conta e apaga sessão, fotos, contatos e mensagens só desse dono', async () => {
  await ligar(SITE);
  const s = atual();
  s.ev.emit('messages.upsert', { type: 'notify', messages: [entrante('Z1', '5511966665555@s.whatsapp.net', 'oi')] });
  criarSessao(SITE);
  fs.mkdirSync(proprio.pastaFotos(SITE), { recursive: true });
  await proprio.desconectar(SITE);
  assert.equal(s.saiu, true);
  assert.equal(fs.existsSync(proprio.pastaSessao(SITE)), false);
  assert.equal(fs.existsSync(proprio.pastaFotos(SITE)), false);
  assert.equal(proprio.mensagens(SITE, {}).length, 0);
  assert.equal(proprio.conversas(SITE).length, 0);
  assert.equal(proprio.status(SITE).fase, 'desligado');
  assert.ok(proprio.mensagens(CLI, {}).length > 0, 'as do cliente continuam');
});

test('apaga as mensagens com mais de 30 dias', () => {
  db.run(`INSERT INTO whatsapp_mensagens (dono, wa_id, chat, tipo, texto, criado_em) VALUES ('site', 'V', 'x@g.us', 'texto', 'velha', datetime('now', '-31 days')), ('site', 'N', 'x@g.us', 'texto', 'nova', datetime('now', '-29 days'))`);
  proprio.limpar();
  assert.deepEqual(proprio.mensagens(SITE, { chat: 'x@g.us' }).map(m => m.texto), ['nova']);
});

test('acesso excluído: apaga mensagens, contatos, ajustes e avisos só daquele número', async () => {
  const db = require('../src/db');
  const proprio = require('../src/whatsapp-proprio');
  for (const dono of ['c:901', 'c:902']) {
    db.run(`INSERT INTO whatsapp_mensagens (dono, wa_id, chat, de_mim, tipo, texto, criado_em) VALUES (?, 'x', 'y', 0, 'texto', 'oi', datetime('now'))`, dono);
    db.run(`INSERT INTO whatsapp_contatos (dono, jid) VALUES (?, 'y')`, dono);
    db.run(`INSERT INTO whatsapp_ajustes (dono, valores) VALUES (?, '{}')`, dono);
    db.run(`INSERT INTO whatsapp_webhooks (dono, url, segredo) VALUES (?, 'https://x.test', 's')`, dono);
  }
  db.db.exec('CREATE TABLE IF NOT EXISTS whatsapp_api_chaves (dono TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, criada_em TEXT)');
  db.run("INSERT INTO whatsapp_api_chaves (dono, hash) VALUES ('c:901', 'h901'), ('c:902', 'h902')");
  await proprio.esquecer('c:901');
  assert.equal(db.get("SELECT COUNT(*) n FROM whatsapp_api_chaves WHERE dono = 'c:901'").n, 0, 'a chave de API sai junto');
  assert.equal(db.get("SELECT COUNT(*) n FROM whatsapp_api_chaves WHERE dono = 'c:902'").n, 1);
  const conta = (tabela, dono) => db.get(`SELECT COUNT(*) n FROM ${tabela} WHERE dono = ?`, dono).n;
  for (const tabela of ['whatsapp_mensagens', 'whatsapp_contatos', 'whatsapp_ajustes', 'whatsapp_webhooks']) {
    assert.equal(conta(tabela, 'c:901'), 0, tabela);
    assert.equal(conta(tabela, 'c:902'), 1, `${tabela} de outro número fica`);
  }
  await assert.rejects(proprio.esquecer('../outra-pasta'), /Dono inválido/);
});
