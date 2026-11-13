// Comissão, membros e site do grupo dos clientes da ferramenta, num banco temporário. Rode com: npm test
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const PASTA = fs.mkdtempSync(path.join(os.tmpdir(), 'ofertou-afiliado-'));
process.env.DATA_DIR = PASTA;
process.env.DISABLE_MINER = '1';
process.env.DISABLE_AGENDA = '1';

const db = require('../src/db');
assert.ok(db.DB_PATH.startsWith(PASTA), 'os testes só rodam no banco temporário');
const clientes = require('../src/clientes');
const cg = require('../src/cliente-ganhos');
const membros = require('../src/membros-grupo');
const gc = require('../src/grupos-convite');

const hoje = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
function novoCliente(email) {
  return clientes.criar({ nome: 'Afiliado Teste', email, senha: 'Kw9#vTz4!qLm2x', dias: 30 });
}
let A, B;
test.before(() => { A = novoCliente('a@exemplo.test'); B = novoCliente('b@exemplo.test'); });

test('venda repetida é atualizada, não duplicada, e cada cliente vê só as suas', () => {
  assert.equal(cg.registrar(A, { plataforma: 'shopee', externo: 'x1', data_venda: hoje, produto: 'Air Fryer', valor_venda: 200, comissao: 10, status: 'pendente' }, 'api').novo, true);
  assert.equal(cg.registrar(A, { plataforma: 'shopee', externo: 'x1', data_venda: hoje, produto: 'Air Fryer', valor_venda: 200, comissao: 12, status: 'completed' }, 'api').novo, false);
  cg.registrar(B, { plataforma: 'shopee', externo: 'x1', data_venda: hoje, produto: 'Outro', comissao: 99, status: 'paga' });
  const r = cg.resumo(A, 30);
  assert.equal(r.pedidos, 1);
  assert.equal(r.comissao, 12);
  assert.equal(r.confirmada, 12);
  assert.equal(cg.resumo(B, 30).comissao, 99);
});

test('venda cancelada fica fora da comissão, mas é contada à parte', () => {
  cg.registrar(A, { plataforma: 'amazon', externo: 'c1', data_venda: hoje, produto: 'Fone', comissao: 50, status: 'cancelado' });
  const r = cg.resumo(A, 30);
  assert.equal(r.comissao, 12);
  assert.equal(r.cancelados, 1);
});

test('planilha importa em real brasileiro e não duplica ao enviar de novo', () => {
  const csv = `Data;Produto;Pedido;Comissão;Situação\n${hoje.split('-').reverse().join('/')};"Monitor 24""";P9;R$ 1.234,56;Aprovado\ninválida;Nada;P0;x;Aprovado\n`;
  const mapa = { data_venda: 0, produto: 1, pedido: 2, comissao: 3, status: 4 };
  const p = cg.previa(csv);
  assert.equal(p.total, 2);
  const r1 = cg.importar(B, csv, 'kabum', mapa);
  assert.deepEqual([r1.novas, r1.ignoradas], [1, 1]);
  const r2 = cg.importar(B, csv, 'kabum', mapa);
  assert.deepEqual([r2.novas, r2.atualizadas], [0, 1]);
  assert.equal(cg.resumo(B, 30).por_loja.find(l => l.plataforma === 'kabum').comissao, 1234.56);
  assert.throws(() => cg.importar(B, csv, 'kabum', { produto: 1 }), /colunas/);
});

test('avisos do WhatsApp: só contagens, só dos grupos de envio', () => {
  clientes.salvarConfig(A, { whatsapp_groups: [{ id: '120363@g.us', nome: 'Grupo 1' }] });
  assert.deepEqual(membros.lerEvento({ event: 'group-participants.update', data: { id: '120363@g.us', action: 'add', participants: ['551199@s', '551188@s'] } }), { grupo: '120363', entradas: 2, saidas: 0 });
  assert.deepEqual(membros.lerEvento({ event: 'GROUP_PARTICIPANTS_UPDATE', data: { id: '120363@g.us', action: 'remove', participants: ['551199@s'] } }), { grupo: '120363', entradas: 0, saidas: 1 });
  assert.equal(membros.lerEvento({ event: 'group-participants.update', data: { id: '1@g.us', action: 'promote', participants: ['x'] } }), null);
  assert.equal(membros.lerEvento({ text: { message: 'oi' } }), null);

  assert.equal(membros.receber(A, { event: 'group-participants.update', data: { id: '120363@g.us', action: 'add', participants: ['551199@s', '551188@s'] } }), true);
  assert.equal(membros.receber(A, { event: 'group-participants.update', data: { id: '120363@g.us', action: 'remove', participants: ['5511'] } }), true);
  assert.equal(membros.receber(A, { event: 'group-participants.update', data: { id: '999@g.us', action: 'add', participants: ['x'] } }), false, 'grupo que não é de envio não conta');
  assert.equal(membros.receber(B, { event: 'group-participants.update', data: { id: '120363@g.us', action: 'add', participants: ['5511'] } }), false, 'o grupo é de outro cliente');
  const r = membros.resumo(A, 7);
  assert.deepEqual([r.entradas, r.saidas], [2, 1]);
  assert.equal(r.grupos[0].nome, 'Grupo 1');
  const salvo = JSON.stringify(db.all('SELECT * FROM grupo_membros_dia'));
  assert.ok(!salvo.includes('551199'), 'o número das pessoas não é guardado');
});

test('site do grupo: endereço único, rotação por limite e contagem separada', () => {
  clientes.salvarConfig(A, { grupo_slug: 'grupo-da-ana', grupos_convite: 'G1 | https://chat.whatsapp.com/aaa | 1\nG2 | https://chat.whatsapp.com/bbb | 0\nRuim | https://exemplo.test/x | 5' });
  assert.throws(() => clientes.salvarConfig(B, { grupo_slug: 'grupo-da-ana' }), /em uso/);
  assert.throws(() => clientes.salvarConfig(B, { grupo_slug: 'a' }), /Endereço/);
  assert.equal(gc.clienteDoEndereco('GRUPO-DA-ANA'), A);
  assert.equal(gc.lista(A).length, 2, 'link que não é de grupo fica de fora');
  assert.equal(gc.proximo(A).nome, 'G1');
  assert.equal(gc.proximo(A).nome, 'G2');
  assert.equal(gc.proximo(A).nome, 'G2');
  assert.deepEqual(gc.resumo(A).map(g => [g.entradas, g.lotado]), [[1, true], [2, false]]);
  assert.ok(!gc.lista(null).some(g => /aaa|bbb/.test(g.link)), 'não mexe na lista do site');
  assert.ok(gc.lista(null).every(g => g.principal), 'site sem lista: só o grupo principal');
  gc.zerar(A);
  assert.equal(gc.resumo(A)[0].entradas, 0);
  db.run(`UPDATE clientes SET status = 'bloqueado' WHERE id = ?`, A);
  assert.equal(gc.clienteDoEndereco('grupo-da-ana'), null, 'cliente bloqueado perde a página');
  db.run(`UPDATE clientes SET status = 'ativo' WHERE id = ?`, A);
});

test('a receber: respeita o prazo, o mínimo, os saques e fica separado por cliente', () => {
  const C = novoCliente('c@exemplo.test');
  const antes = dias => new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
  // Shopee: prazo de 30 dias e mínimo de R$ 30 (regras iniciais)
  cg.registrar(C, { plataforma: 'shopee', externo: 'velha', data_venda: antes(40), produto: 'A', comissao: 50, status: 'confirmada' });
  cg.registrar(C, { plataforma: 'shopee', externo: 'nova', data_venda: antes(5), produto: 'B', comissao: 20, status: 'confirmada' });
  cg.registrar(C, { plataforma: 'shopee', externo: 'pend', data_venda: antes(40), produto: 'C', comissao: 7, status: 'pendente' });
  cg.registrar(C, { plataforma: 'shopee', externo: 'canc', data_venda: antes(40), produto: 'D', comissao: 99, status: 'cancelada' });
  cg.registrar(C, { plataforma: 'shopee', externo: 'paga', data_venda: antes(90), produto: 'E', comissao: 11, status: 'paga' });
  let l = cg.saldos(C).lojas.find(x => x.plataforma === 'shopee');
  assert.deepEqual([l.disponivel, l.a_liberar, l.recebido, l.pode_sacar], [50, 27, 11, true]);
  assert.ok(l.proxima_liberacao > antes(0), 'a próxima liberação é no futuro');
  cg.registrarSaque(C, { plataforma: 'shopee', valor: '30,00' });
  l = cg.saldos(C).lojas.find(x => x.plataforma === 'shopee');
  assert.deepEqual([l.disponivel, l.recebido, l.pode_sacar, l.falta], [20, 41, false, 10]);
  const id = cg.resumo(C, 30).saques[0].id;
  assert.throws(() => cg.excluirSaque(A, id), /não encontrado/, 'não apaga saque de outro cliente');
  cg.excluirSaque(C, id);
  assert.equal(cg.saldos(C).lojas.find(x => x.plataforma === 'shopee').disponivel, 50);
  assert.equal(cg.saldos(A).lojas.find(x => x.plataforma === 'shopee').disponivel, 0, 'não mistura clientes');
  // AliExpress fica em dólar, fora do total em reais
  cg.registrar(C, { plataforma: 'aliexpress', externo: 'u1', data_venda: antes(90), produto: 'F', comissao: 20, status: 'confirmada' });
  const s = cg.saldos(C);
  assert.deepEqual([s.brl.disponivel, s.usd.disponivel], [50, 20]);
});

test('Mercado Livre: o valor da extensão substitui o anterior e é validado', () => {
  const C = novoCliente('d@exemplo.test');
  cg.salvarEstimadoMl(C, 10);
  cg.salvarEstimadoMl(C, 25.5);
  const l = cg.saldos(C).lojas.find(x => x.plataforma === 'mercadolivre');
  assert.equal(l.disponivel, 25.5);
  assert.throws(() => cg.salvarEstimadoMl(C, -1), /inválido/);
  assert.throws(() => cg.salvarEstimadoMl(C, 'abc'), /inválido/);
  assert.equal(cg.saldos(A).lojas.find(x => x.plataforma === 'mercadolivre'), undefined, 'não aparece para outro cliente');
});

test('lembrete da planilha: só para lojas com link de afiliado e sem envio recente', () => {
  const C = novoCliente('e@exemplo.test');
  assert.deepEqual(cg.lembretePlanilha(C), [], 'sem link de afiliado, não cobra');
  clientes.salvarConfig(C, { amazon_tag: 'teste-20', shopee_app_id: '1', shopee_app_secret: 'x' });
  assert.deepEqual(cg.lembretePlanilha(C).map(l => l.plataforma), ['amazon'], 'a Shopee com chaves atualiza sozinha');
  const hojeBr = hoje.split('-').reverse().join('/');
  cg.importar(C, `Data;Comissão\n${hojeBr};5,00\n`, 'amazon', { data_venda: 0, comissao: 1 });
  assert.deepEqual(cg.lembretePlanilha(C), [], 'enviou agora, não lembra');
  db.run(`UPDATE cliente_vendas SET atualizado_em = datetime('now', '-8 days') WHERE cliente_id = ?`, C);
  assert.equal(cg.lembretePlanilha(C)[0].dias, 8);
});

test('Termos do Afiliado: pede uma vez e fica registrado na ficha do cliente', () => {
  const cons = require('../src/consentimento');
  const email = 'termos@exemplo.test';
  const id = novoCliente(email);
  const quem = { dono: `c:${id}`, email, papeis: ['afiliado'] };
  const ficha = () => clientes.listar().find(c => c.id === id).aceite_termos;
  assert.deepEqual(cons.pendentesParceiro(quem), ['afiliado']);
  assert.equal(ficha(), null);
  assert.throws(() => cons.aceitarParceiro({ ...quem, b: {} }), /aceite os Termos/i);
  cons.aceitarParceiro({ ...quem, b: { aceite_afiliado: true }, req: { ip: '203.0.113.9', get: () => 'Teste' } });
  assert.deepEqual(cons.pendentesParceiro(quem), [], 'não pede de novo');
  assert.equal(ficha().ip, '203.0.113.9');
  assert.equal(ficha().versao, cons.VERSAO);
  assert.ok(cons.VERSAO >= cons.VERSAO_PARCEIRO, "aceite atual vale para os Termos do Parceiro");
  cons.aceitarParceiro({ ...quem, b: {} });
  assert.equal(db.get(`SELECT COUNT(*) n FROM consentimentos WHERE dono = ?`, `c:${id}`).n, 1, 'não duplica o registro');
  assert.equal(clientes.listar().find(c => c.id === A).aceite_termos, null, 'não vale para outro cliente');
});

test('configuração do cliente: a contagem interna não pode ser editada', () => {
  clientes.salvarConfig(A, { grupos_convite_entradas: '{"x":999}', ganhos_sync_estado: 'x', ml_ganho_estimado: '{"valor":999999}' });
  assert.equal(db.get(`SELECT value FROM cliente_config WHERE cliente_id = ? AND key = 'ml_ganho_estimado'`, A), undefined);
  const v = db.get(`SELECT value FROM cliente_config WHERE cliente_id = ? AND key = 'ganhos_sync_estado'`, A);
  assert.equal(v, undefined);
});

test('página de venda sai com o preço do plano e sem erro', () => {
  const html = require('../src/paginas/ferramenta').pagina();
  assert.match(html, /Faça a sua conta/);
  assert.match(html, /Não é promessa de resultado/);
});
