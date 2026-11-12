// Ofertas relâmpago e lembrete da coleta do Mercado Livre, num banco temporário (nunca o do site).
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
const relampago = require('../src/relampago');
const agenda = require('../src/agenda');
const social = require('../src/social');
const whatsapp = require('../src/whatsapp');
whatsapp.fotoParaEnvio = async () => null; // sem internet nos testes
const avisoMl = require('../src/aviso-ml');
const { getStore } = require('../src/stores');

test.after(() => { try { db.db.close(); } catch { /* */ } try { fs.rmSync(PASTA, { recursive: true, force: true }); } catch { /* */ } });

const kabum = getStore('kabum'), shopee = getStore('shopee'), amazon = getStore('amazon');
let n = 0;
const base = (extra = {}) => ({ store_product_id: `R${++n}`, produto: `Produto Relampago ${n}`, preco_anterior: 500, preco_atual: 400, imagem: 'https://exemplo.test/f.jpg', original_url: `https://www.exemplo.test/p/${n}`, ...extra });
const opts = { settings: { ...settings.getAll(), min_discount_pct: 5 } };
const salvar = (store, d) => offers.saveDeal(store, d, opts);
const linha = id => db.get('SELECT * FROM offers WHERE id = ?', id);
const envelhecer = id => db.run(`UPDATE offers SET created_at = datetime('now', '-5 days') WHERE id = ?`, id);

test('a loja marca: guarda o fim informado', () => {
  const fim = Date.now() + 2 * 3600000;
  const id = salvar(kabum, base({ relampago: { fim } }));
  const o = linha(id);
  assert.equal(o.relampago_tipo, 'loja');
  assert.equal(o.relampago_fim_real, 1);
  assert.ok(relampago.estaAtiva(id));
});

test('KaBuM!: campanha longa não é relâmpago, oferta curta é', () => {
  const agora = 1_800_000_000;
  const de = (ini, fim, extra = {}) => kabum.relampagoDe({ offer: { price_with_discount: 10, starts_at: ini, ends_at: fim, quantity_available: 3, ...extra } }, agora);
  assert.equal(de(agora - 86400, agora + 8 * 86400), null, 'campanha de vários dias');
  assert.deepEqual(de(agora - 3600, agora + 5 * 3600), { fim: (agora + 5 * 3600) * 1000 });
  assert.ok(de(agora - 9 * 86400, agora + 3600), 'campanha longa nas últimas horas');
  assert.equal(de(agora - 3600, agora + 3600, { quantity_available: 0 }), null, 'esgotada');
  assert.equal(de(agora - 3600, agora + 3600, { is_logged_user_exclusive: true }), null, 'só para logados');
  assert.equal(de(agora + 60, agora + 3600), null, 'ainda não começou');
  assert.equal(kabum.relampagoDe({}, agora), null);
});

test('queda de preço: só produto conhecido, queda grande e menor preço em 30 dias', () => {
  const d = base({ preco_anterior: 500, preco_atual: 400 });
  const id = salvar(shopee, d);
  // Produto novo: sem comparação
  salvar(shopee, { ...d, preco_atual: 250 });
  assert.equal(linha(id).relampago_tipo, null, 'produto visto agora não conta');
  envelhecer(id);
  salvar(shopee, { ...d, preco_atual: 240 });
  assert.equal(linha(id).relampago_tipo, null, 'queda pequena não conta');
  salvar(shopee, { ...d, preco_atual: 195 });
  const o = linha(id);
  assert.equal(o.relampago_tipo, 'queda');
  assert.equal(o.relampago_fim_real, 0);
  salvar(shopee, { ...d, preco_atual: 260 });
  assert.equal(linha(id).relampago_tipo, null, 'o preço voltou a subir: acabou');
});

test('queda de preço: não conta se o preço já esteve mais baixo em 30 dias', () => {
  const d = base({ preco_anterior: 500, preco_atual: 200 });
  const id = salvar(shopee, d);
  salvar(shopee, { ...d, preco_atual: 400 });
  envelhecer(id);
  salvar(shopee, { ...d, preco_atual: 300 });
  assert.equal(linha(id).relampago_tipo, null);
});

test('terminou: a marcada pela loja sai do ar até a próxima leitura e a fila é limpa', () => {
  const id = salvar(kabum, base({ relampago: { fim: Date.now() + 3600000 } }));
  agenda.enfileirar([{ offer_id: id, prioridade: 1 }], 'teste', null);
  db.run(`UPDATE offers SET relampago_fim = datetime('now', '-1 minute') WHERE id = ?`, id);
  relampago.varrer();
  assert.equal(linha(id).relampago_fim, null);
  assert.equal(offers.isActive(id), false, 'preço de oferta encerrada não fica no ar');
  assert.equal(db.get('SELECT status FROM post_queue WHERE offer_id = ?', id).status, 'expirado');
});

test('Amazon: lê a página de ofertas e só LIGHTNING_DEAL é relâmpago', () => {
  const produto = (asin, tipo, fim) => ({ asin, title: `Produto ${asin}`, image: { hiRes: { baseUrl: 'https://m.media-amazon.com/images/I/x', extension: 'jpg' } },
    price: { priceToPay: { price: '100.0' }, basisPrice: { price: '200.0' } }, dealDetails: { state: 'AVAILABLE', type: tipo, ...(fim ? { endTime: fim } : {}) } });
  const html = `<script>{"x":1,"productSearchResponse":${JSON.stringify({ products: [produto('B000000001', 'BEST_DEAL'), produto('B000000002', 'LIGHTNING_DEAL'), produto('B000000003', 'LIGHTNING_DEAL', 1800000000000), { ...produto('B000000004', 'LIGHTNING_DEAL'), dealDetails: { state: 'EXPIRED', type: 'LIGHTNING_DEAL' } }] })},"y":"}"}</script>`;
  const d = amazon.parseOfertas(html);
  assert.equal(d.length, 3);
  assert.equal(d[0].relampago, undefined);
  assert.deepEqual(d[1].relampago, { fim: 0 });
  assert.deepEqual(d[2].relampago, { fim: 1800000000000 });
  assert.equal(d[0].imagem, 'https://m.media-amazon.com/images/I/x.jpg');
  assert.deepEqual(amazon.parseOfertas('<html></html>'), []);
});

test('Mercado Livre: importa as ofertas da extensão sem apagar o cupom', () => {
  const ml = getStore('mercadolivre');
  const cml = require('../src/cupons-ml');
  const id = offers.saveDeal(ml, base({ store_product_id: 'MLB1234567', preco_atual: 90, preco_anterior: 200, cupom_codigo: 'ML55', cupom_texto: '10% OFF', preco_sem_cupom: 100 }), opts);
  const r = cml.importarOfertas([
    { produto: 'MLB1234567', nome: 'Produto com cupom', preco: 90, preco_anterior: 200, link: 'https://www.mercadolivre.com.br/p/MLB1234567', relampago: true, resta_s: 3600 },
    { item: 'MLB7654321', nome: 'Outro produto', preco: 50, preco_anterior: 100, link: 'https://produto.mercadolivre.com.br/MLB-7654321', relampago: false },
    { produto: 'MLB9999999', nome: 'Site errado', preco: 50, preco_anterior: 100, link: 'https://golpe.test/MLB9999999', relampago: true },
  ]);
  assert.deepEqual([r.recebidos, r.gravados, r.relampagos], [3, 2, 1]);
  const o = linha(id);
  assert.equal(o.cupom_codigo, 'ML55', 'o cupom continua');
  assert.equal(o.relampago_tipo, 'loja');
  assert.equal(o.relampago_fim_real, 1);
});

test('Mercado Livre: oferta do dia fora do catálogo (link /up/) entra com o anúncio certo, sem virar relâmpago', () => {
  const cml = require('../src/cupons-ml');
  const r = cml.importarOfertas([{ item: 'MLB6501664470', nome: 'Microfone Uhf Sem Fio Duplo Outlet', preco: 1129.41, preco_anterior: 1340,
    link: 'https://www.mercadolivre.com.br/up/MLBU3864817912', relampago: false }]);
  assert.equal(r.gravados, 1);
  assert.equal(r.relampagos, 0);
  const o = db.get("SELECT * FROM offers WHERE store_id = 'mercadolivre' AND store_product_id = 'MLB6501664470'");
  assert.equal(o.original_url, 'https://www.mercadolivre.com.br/up/MLBU3864817912?pdp_filters=item_id%3AMLB6501664470');
  assert.match(o.affiliate_url, /pdp_filters=item_id%3AMLB6501664470/);
  assert.equal(o.relampago_tipo, null);
});

test('Mercado Livre: anúncio patrocinado (link do contador de cliques) entra com o link do produto, e as gravadas são consertadas', () => {
  const cml = require('../src/cupons-ml');
  cml.importarOfertas([{ item: 'MLB6799498078', nome: 'Chave De Impacto Brushless 700nm 2 Baterias', preco: 278.98, preco_anterior: 655,
    link: 'https://click1.mercadolivre.com.br/mclics/clicks/external/MLB/count', relampago: false }]);
  const o = db.get("SELECT * FROM offers WHERE store_id = 'mercadolivre' AND store_product_id = 'MLB6799498078'");
  assert.equal(o.original_url, 'https://produto.mercadolivre.com.br/MLB-6799498078');
  assert.match(o.affiliate_url, /^https:\/\/produto\.mercadolivre\.com\.br\/MLB-6799498078/);
  // Oferta gravada antes da correção, com o link do contador
  db.run(`UPDATE offers SET original_url = 'https://click1.mercadolivre.com.br/mclics/clicks/external/MLB/count', affiliate_url = 'https://click1.mercadolivre.com.br/mclics/clicks/external/MLB/count?matt_word=x' WHERE id = ?`, o.id);
  assert.equal(cml.consertarLinks(), 1);
  const c = db.get('SELECT original_url, affiliate_url FROM offers WHERE id = ?', o.id);
  assert.equal(c.original_url, 'https://produto.mercadolivre.com.br/MLB-6799498078');
  assert.doesNotMatch(c.affiliate_url, /click1/);
  assert.equal(cml.consertarLinks(), 0, 'na segunda vez não há o que consertar');
});

test('primeira página: relâmpagos na frente, sem encher a página e sem mexer na busca', async () => {
  const busca = require('../src/busca-ofertas');
  db.run('UPDATE offers SET relampago_fim = NULL, relampago_tipo = NULL, relampago_desde = NULL');
  for (let i = 0; i < 40; i++) salvar(kabum, base({ preco_atual: 300 + i }));
  const NOMES = 'geladeira fogao notebook monitor cafeteira ventilador bicicleta mochila perfume furadeira tablet impressora roteador teclado headset soundbar liquidificador aspirador esteira parafusadeira'.split(' ');
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push(salvar(kabum, base({ preco_atual: 350, produto: `${NOMES[i]} modelo ${NOMES[19 - i]} exclusivo`, relampago: { fim: Date.now() + (i + 1) * 3600000 } })));
  busca.montar();
  const r = busca.buscar({ por: 24, pagina: 1 });
  const naPagina = r.itens.filter(o => ids.includes(o.id));
  assert.ok(naPagina.length >= 12);
  assert.deepEqual(r.itens.slice(0, 12).map(o => o.id), ids.slice(0, 12), 'as que acabam antes vêm primeiro');
  assert.equal(r.itens[0].relampago_tipo, 'loja');
  const outraOrdem = busca.buscar({ por: 24, pagina: 1, ordem: 'menor-preco' });
  assert.ok(!outraOrdem.itens.slice(0, 12).every(o => ids.includes(o.id)), 'outras ordens continuam como estão');
});

test('texto da postagem: avisa o relâmpago, a hora do fim e leva o cupom', () => {
  const id = salvar(kabum, base({ relampago: { fim: Date.now() + 3600000 }, cupom_codigo: 'CUPOMX', cupom_texto: '5% OFF', preco_sem_cupom: 420 }));
  const t = relampago.textoDaPostagem({ ...linha(id), __link: 'https://x.test/l' }, settings.getAll());
  assert.match(t, /OFERTA RELÂMPAGO/);
  assert.match(t, /Termina hoje às|Termina dia/);
  assert.equal((t.match(/CUPOMX/g) || []).length >= 1, true);
  const queda = relampago.textoDaPostagem({ ...linha(id), relampago_tipo: 'queda', relampago_fim_real: 0, cupom_codigo: null, __link: 'https://x.test/l' }, settings.getAll());
  assert.match(queda, /OFERTA RELÂMPAGO[\s\S]*O preço caiu agora/);
  assert.doesNotMatch(queda, /Termina/);
});

test('postar: respeita horário, palavras e grupos, um por vez, e não repete', async () => {
  const antes = { publicar: social.publicar, gruposDaOferta: whatsapp.gruposDaOferta, pronta: social.REDES.whatsapp.pronta, conferir: require('../src/preco-na-hora').conferir };
  const postados = [];
  social.publicar = async (id, redes, texto) => { postados.push({ id, texto }); return [{ rede: 'whatsapp', ok: true }]; };
  social.REDES.whatsapp.pronta = () => null;
  require('../src/preco-na-hora').conferir = async () => ({ acao: 'postar', situacao: 'sem_checagem' });
  agenda._paraTestes({ pausa: false });
  db.run(`UPDATE offers SET relampago_fim = NULL, relampago_tipo = NULL, relampago_desde = NULL`);
  db.run(`DELETE FROM post_queue`);
  const cat = linha(salvar(kabum, base({ produto: 'Item categoria teste' }))).categoria;
  settings.set('agenda_ativa', '1');
  settings.set('agenda_redes', '["whatsapp"]');
  settings.set('agenda_inicio', '00:00');
  settings.set('agenda_fim', '23:59');
  settings.set('agenda_palavras_bloqueadas', 'capinha');
  settings.set('agenda_nota_minima', '0'); // a nota de viral tem testes próprios
  settings.set('agenda_palavras_permitidas', '');
  settings.set('whatsapp_groups', JSON.stringify([{ id: 'g1', nome: 'Grupo', categorias: [cat], lojas: ['kabum'] }]));
  const fim = Date.now() + 3 * 3600000;
  const boa = salvar(kabum, base({ produto: 'Item categoria teste bom', relampago: { fim } }));
  const boa2 = salvar(kabum, base({ produto: 'Item categoria segundo diferente', relampago: { fim } }));
  const proibida = salvar(kabum, base({ produto: 'Capinha categoria', relampago: { fim } }));
  const outraLoja = salvar(amazon, base({ store_product_id: 'B00000000X', produto: 'Item categoria amazon', relampago: { fim } }));
  const acabando = salvar(kabum, base({ produto: 'Item quase no fim', relampago: { fim: Date.now() + 5 * 60000 } }));
  // Produto que já existia e só teve o preço caído: o site atualiza o preço, mas não vai para os grupos
  const caiu = salvar(kabum, base({ produto: 'Item categoria preco caiu' }));
  db.run(`UPDATE offers SET relampago_tipo = 'queda', relampago_fim = datetime('now', '+6 hours'), relampago_desde = datetime('now') WHERE id = ?`, caiu);
  for (const id of [boa, boa2, proibida, outraLoja, acabando, caiu]) db.run('UPDATE offers SET categoria = ? WHERE id = ?', cat, id);
  try {
    await relampago.despacharDono(null, new Set());
    assert.equal(postados.length, 1, 'uma por vez');
    assert.match(postados[0].texto, /OFERTA RELÂMPAGO/);
    const fila = db.all(`SELECT offer_id, status, prioridade FROM post_queue`);
    assert.deepEqual(fila.map(q => q.offer_id).sort(), [boa, boa2].sort(), 'só as que passam pelos filtros e pelos grupos (queda de preço não entra)');
    await relampago.despacharDono(null, new Set());
    assert.equal(postados.length, 1, 'espera o intervalo');
    db.run(`UPDATE post_queue SET posted_at = datetime('now', '-10 minutes') WHERE status = 'postado'`);
    await relampago.despacharDono(null, new Set());
    assert.equal(postados.length, 2);
    db.run(`UPDATE post_queue SET posted_at = datetime('now', '-10 minutes') WHERE status = 'postado'`);
    await relampago.despacharDono(null, new Set());
    assert.equal(postados.length, 2, 'a mesma oferta não sai de novo');
    // Fora do horário
    salvar(kabum, base({ produto: 'Item fora do horario', relampago: { fim } }));
    settings.set('agenda_inicio', '00:00');
    settings.set('agenda_fim', '00:00');
    const r = await relampago.despacharDono(null, new Set());
    assert.equal(r.motivo, 'desligado');
    settings.set('agenda_fim', '23:59');
    settings.set('agenda_relampago', '0');
    assert.equal((await relampago.despacharDono(null, new Set())).motivo, 'desligado');
    settings.set('agenda_relampago', '1');
    settings.set('agenda_ativa', '0');
    assert.equal((await relampago.despacharDono(null, new Set())).motivo, 'desligado');
  } finally {
    social.publicar = antes.publicar;
    social.REDES.whatsapp.pronta = antes.pronta;
    require('../src/preco-na-hora').conferir = antes.conferir;
    agenda._paraTestes({ pausa: true });
  }
});

test('frente da fila: a rodada normal posta a relâmpago primeiro', async () => {
  db.run(`DELETE FROM post_queue`);
  const normal = salvar(kabum, base({ produto: 'Normal na fila' }));
  const rel = salvar(kabum, base({ produto: 'Relampago na fila', relampago: { fim: Date.now() + 3600000 } }));
  agenda.enfileirar([{ offer_id: normal }], 'teste', null);
  agenda.enfileirar([{ offer_id: rel, prioridade: 1 }], 'teste', null);
  assert.equal(agenda.listarFila(null)[0].offer_id, rel);
});

test('lembrete do Mercado Livre: 3 vezes ao dia e só some com ofertas e cupons', () => {
  const horario = (dia, h, m = 0) => Date.UTC(2026, 10, dia, h + 3, m);
  settings.set('ml_coleta_ofertas_em', '');
  settings.set('ml_coleta_cupons_em', '');
  const contar = () => db.get(`SELECT COUNT(*) n FROM admin_notificacoes WHERE tipo = 'ml-coleta'`).n;
  const inicio = contar();
  const t = horario(10, 9, 5);
  assert.equal(avisoMl.estado(t).pendente, true);
  assert.equal(avisoMl.verificar(t), true, 'avisa no horário');
  assert.equal(avisoMl.verificar(t + 60000), false, 'uma vez só por horário');
  assert.equal(contar(), inicio + 1);
  assert.deepEqual(avisoMl.registrar('ofertas', t + 120000).falta, ['cupons'], 'só as ofertas não bastam');
  assert.equal(avisoMl.estado(t + 180000).pendente, true);
  assert.equal(avisoMl.registrar('cupons', t + 240000).pendente, false, 'com os dois, o aviso some');
  assert.equal(db.get(`SELECT COUNT(*) n FROM admin_notificacoes WHERE tipo = 'ml-coleta' AND lida = 0`).n, 0);
  assert.equal(avisoMl.verificar(horario(10, 13)), false, 'antes do próximo horário continua resolvido');
  assert.equal(avisoMl.estado(horario(10, 14)).pendente, true, 'no próximo horário volta');
  assert.equal(avisoMl.verificar(horario(10, 14)), true);
  assert.equal(avisoMl.verificar(horario(10, 20)), true);
  assert.equal(avisoMl.ultimoHorario(horario(11, 3)).hora, 20, 'de madrugada vale o das 20h de ontem');
  assert.equal(contar(), inicio + 3);
});

test('extensão: o .zip sai completo, íntegro e na versão atual', () => {
  const zlib = require('zlib');
  const ext = require('../src/extensao');
  const zip = ext.zip();
  const pasta = path.join(__dirname, '..', 'extensao-comissao');
  const fim = zip.length - 22;
  assert.equal(zip.readUInt32LE(fim), 0x06054b50);
  const total = zip.readUInt16LE(fim + 10);
  let p = zip.readUInt32LE(fim + 16);
  const nomes = [];
  for (let i = 0; i < total; i++) {
    assert.equal(zip.readUInt32LE(p), 0x02014b50);
    const tam = zip.readUInt32LE(p + 24), crc = zip.readUInt32LE(p + 16), n = zip.readUInt16LE(p + 28), local = zip.readUInt32LE(p + 42);
    const nome = zip.subarray(p + 46, p + 46 + n).toString();
    nomes.push(nome);
    const nl = zip.readUInt16LE(local + 26), comprimido = zip.readUInt32LE(local + 18);
    const dados = zlib.inflateRawSync(zip.subarray(local + 30 + nl, local + 30 + nl + comprimido));
    assert.equal(dados.length, tam);
    assert.equal(zlib.crc32(dados), crc);
    assert.ok(dados.equals(fs.readFileSync(path.join(pasta, nome.split('/')[1]))), nome);
    p += 46 + n;
  }
  for (const f of ['manifest.json', 'ofertas.js', 'cupons.js', 'mercadolivre.js', 'painel.js', 'painel-cliente.js', 'icone.png']) assert.ok(nomes.includes(`ofertou-extensao/${f}`), f);
  assert.equal(ext.versao(), JSON.parse(fs.readFileSync(path.join(pasta, 'manifest.json'), 'utf8')).version);
  const manifesto = JSON.parse(fs.readFileSync(path.join(pasta, 'manifest.json'), 'utf8'));
  const usados = manifesto.content_scripts.flatMap(c => c.js);
  for (const j of usados) assert.ok(fs.existsSync(path.join(pasta, j)), j);
});

test('Mercado Livre: as ofertas da extensão chegam com o link de afiliado', () => {
  const cml = require('../src/cupons-ml');
  const antes = [settings.get('ml_matt_word'), settings.get('ml_matt_tool')];
  settings.set('ml_matt_word', 'minhaconta');
  settings.set('ml_matt_tool', '123');
  try {
    const r = cml.importarOfertas([{ item: 'MLB5551112', nome: 'Oferta com link de afiliado', preco: 80, preco_anterior: 160, imagem: 'https://http2.mlstatic.com/x.jpg', link: 'https://produto.mercadolivre.com.br/MLB-5551112-oferta', relampago: true, resta_s: 1800 }]);
    assert.equal(r.gravados, 1);
    const o = db.get(`SELECT * FROM offers WHERE store_id = 'mercadolivre' AND store_product_id = 'MLB5551112'`);
    assert.match(o.affiliate_url, /matt_word=minhaconta/);
    assert.match(o.affiliate_url, /matt_tool=123/);
    assert.equal(o.imagem, 'https://http2.mlstatic.com/x.jpg');
    assert.equal(o.preco_atual, 80);
    assert.equal(o.relampago_tipo, 'loja');
  } finally {
    settings.set('ml_matt_word', antes[0] || '');
    settings.set('ml_matt_tool', antes[1] || '');
  }
});

test('categoria Promoção relâmpago: só o que a loja marcou, com o que acaba antes na frente', async () => {
  const busca = require('../src/busca-ofertas');
  db.run(`UPDATE offers SET relampago_fim = NULL, relampago_tipo = NULL, relampago_desde = NULL, relampago_fim_real = 0`);
  const agora = Date.now();
  const longe = salvar(kabum, base({ produto: 'Relogio categoria longe', relampago: { fim: agora + 5 * 3600000 } }));
  const perto = salvar(kabum, base({ produto: 'Relogio categoria perto', relampago: { fim: agora + 3600000 } }));
  const semHora = salvar(amazon, base({ produto: 'Relogio categoria sem hora', relampago: { fim: 0 } }));
  const queda = salvar(kabum, base({ produto: 'Relogio categoria queda' }));
  db.run(`UPDATE offers SET relampago_tipo = 'queda', relampago_fim = datetime('now', '+6 hours'), relampago_fim_real = 0 WHERE id = ?`, queda);
  const terminou = salvar(kabum, base({ produto: 'Relogio categoria terminou', relampago: { fim: agora + 3600000 } }));
  db.run(`UPDATE offers SET relampago_fim = datetime('now', '-1 minutes') WHERE id = ?`, terminou);
  const comum = salvar(kabum, base({ produto: 'Relogio categoria comum' }));
  await busca.atualizar();

  const r = busca.buscar({ relampago: '1', por: 96 });
  assert.deepEqual(r.itens.map(o => o.id), [perto, longe, semHora]);
  assert.equal(r.total, 3);
  assert.equal(r.contagens.relampago, 3);
  const c = r.itens[0];
  assert.equal(c.relampago_fim_real, 1, 'o cartão recebe a hora real do fim');
  assert.ok(c.relampago_fim, 'e quando acaba');

  const geral = busca.buscar({ por: 96 });
  assert.equal(geral.contagens.relampago, 3, 'a contagem aparece fora da categoria');
  assert.ok(geral.itens.some(o => o.id === comum), 'o resto continua na lista geral');
  assert.equal(busca.buscar({ relampago: '1', loja: 'amazon', por: 96 }).total, 1, 'respeita a loja');
  assert.equal(busca.buscar({ relampago: '1', q: 'comum', por: 96 }).total, 0);
});

test('extensão: lê o relógio em dígitos separados do cartão do Mercado Livre', () => {
  const vm = require('vm');
  const digito = (cl, v) => ({ textContent: v, cl });
  const bloco = (...digitos) => ({ querySelectorAll: () => digitos.map(d => ({ querySelector: () => d })) });
  const card = (blocos, texto = '') => ({
    innerText: texto,
    querySelectorAll: s => (/countdown__block/.test(s) ? blocos : []),
    querySelector: s => {
      if (s.startsWith('a.poly')) return { href: 'https://www.mercadolivre.com.br/p/MLB1234567', textContent: 'Produto' };
      if (/current|previous/.test(s)) return { querySelector: q => (/fraction/.test(q) ? { textContent: /current/.test(s) ? '90' : '180' } : null) };
      if (s === 'img') return { getAttribute: () => null, src: 'https://x.test/f.jpg' };
      return null;
    },
  });
  const relogio = card([bloco(digito(0, '0'), digito(0, '8')), bloco(digito(0, '0'), digito(0, '7')), bloco(digito(0, '1'), digito(0, '3'))], '0 8 : 0 7 : 1 3 8');
  const antigo = card([], 'Termina em 02:14:33');
  const semNada = card([], 'sem relógio');
  const dias = card([bloco(digito(0, '1')), bloco(digito(0, '0'), digito(0, '2')), bloco(digito(0, '0'), digito(0, '0')), bloco(digito(0, '0'), digito(0, '0'))]);
  let cards = [];
  const store = {};
  const sandbox = { console, Number, String, Object, Math, URLSearchParams, Date, decodeURIComponent, setTimeout: () => 0, innerHeight: 800,
    chrome: { storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } } }, location: {}, document: { querySelectorAll: () => cards, createElement: () => ({ style: {} }), documentElement: { append() {} } } };
  sandbox.window = sandbox;
  const codigo = fs.readFileSync(path.join(__dirname, '../extensao-comissao/ofertas.js'), 'utf8').replace('function lerCartoes(relampago = true) {', 'window.__ler = () => lerCartoes(); function lerCartoes(relampago = true) {');
  vm.runInNewContext(codigo, sandbox);
  cards = [relogio];
  assert.equal(sandbox.__ler()[0].resta_s, 8 * 3600 + 7 * 60 + 13);
  assert.ok(Math.abs(sandbox.__ler()[0].fim_ms - (Date.now() + (8 * 3600 + 7 * 60 + 13) * 1000)) < 2000, 'a hora do fim sai da leitura');
  cards = [antigo];
  assert.equal(sandbox.__ler()[0].resta_s, 2 * 3600 + 14 * 60 + 33, 'continua lendo o formato antigo');
  cards = [semNada];
  assert.equal(sandbox.__ler()[0].resta_s, undefined);
  assert.equal(sandbox.__ler()[0].fim_ms, undefined, 'sem relógio não inventa hora');
  cards = [dias];
  assert.equal(sandbox.__ler()[0].resta_s, 86400 + 2 * 3600);
  void store;
});

test('relâmpago encerrada sai do site: passou da hora, sumiu da lista do Mercado Livre e fim calculado na leitura', async () => {
  const busca = require('../src/busca-ofertas');
  const cml = require('../src/cupons-ml');
  const ml = getStore('mercadolivre');
  const item = (n, extra = {}) => ({ produto: `MLB${7700000 + n}`, item: `MLB${7700000 + n}`, link: `https://www.mercadolivre.com.br/produto-${n}/p/MLB${7700000 + n}`, nome: `Produto encerrar ${n}`, preco: 90, preco_anterior: 180, imagem: 'https://x.test/f.jpg', relampago: true, ...extra });
  const oferta = n => db.get('SELECT * FROM offers WHERE store_id = ? AND store_product_id = ?', 'mercadolivre', `MLB${7700000 + n}`);
  db.run(`UPDATE offers SET relampago_fim = NULL, relampago_tipo = NULL, relampago_fim_real = 0`);

  // A hora do fim vale a da leitura, mesmo gravando minutos depois
  const fim = Date.now() + 3 * 3600000;
  cml.importarOfertas([item(1, { fim_ms: fim, resta_s: 99 }), item(2, { resta_s: 3600 }), item(3), item(4, { fim_ms: fim }), item(5, { fim_ms: fim }), item(6, { fim_ms: Date.now() - 5000 })]);
  assert.equal(oferta(1).relampago_fim, new Date(fim).toISOString().slice(0, 19).replace('T', ' '));
  assert.equal(oferta(1).relampago_fim_real, 1);
  assert.equal(oferta(2).relampago_fim_real, 1, 'a versão antiga continua valendo');
  assert.equal(oferta(3).relampago_fim_real, 0);
  assert.equal(oferta(6).relampago_fim_real, 0, 'fim no passado não é aceito');

  // Leitura vazia não encerra nada
  assert.equal(cml.encerrarRelampagos([], true).encerradas, 0);
  // Leitura parcial: só sai o que não tinha hora real e não veio
  assert.equal(cml.encerrarRelampagos([oferta(1).store_product_id], false).encerradas, 2, 'as duas sem hora real (3 e 6)');
  assert.equal(oferta(3).relampago_fim, null);
  assert.equal(oferta(4).relampago_fim_real, 1, 'com hora real continua: pode estar em página não lida');
  // Lista lida até o fim: sai também o que tem hora real e não veio
  assert.equal(cml.encerrarRelampagos([oferta(1).store_product_id], true).encerradas, 3, '2, 4 e 5');
  assert.equal(oferta(4).relampago_fim, null);
  assert.ok(oferta(1).relampago_fim, 'a que veio continua');

  // Passou da hora: some da lista antes mesmo da limpeza e a limpeza a tira do site
  await busca.atualizar();
  assert.ok(busca.buscar({ relampago: '1', por: 96 }).itens.some(o => o.id === oferta(1).id));
  db.run(`UPDATE offers SET relampago_fim = datetime('now', '-1 minutes'), updated_at = datetime('now', '+1 minutes') WHERE id = ?`, oferta(1).id);
  await busca.atualizar();
  assert.ok(!busca.buscar({ por: 96, q: 'Produto encerrar 1' }).itens.some(o => o.id === oferta(1).id), 'sai antes da limpeza');
  const id = oferta(1).id;
  assert.ok(relampago.varrer() >= 1);
  assert.equal(linha(id).relampago_fim, null);
  assert.equal(offers.isActive(id), false, 'fica fora do ar até a loja mostrar o preço novo');
  void ml;
});
