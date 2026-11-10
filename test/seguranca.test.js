// Regras de segurança da revisão OWASP, num banco temporário (nunca o do site). Rode com: npm test
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const PASTA = fs.mkdtempSync(path.join(os.tmpdir(), 'ofertou-seguranca-'));
process.env.DATA_DIR = PASTA;
process.env.DISABLE_MINER = '1';
process.env.DISABLE_AGENDA = '1';

const db = require('../src/db');
assert.ok(db.DB_PATH.startsWith(PASTA), 'os testes só rodam no banco temporário');
const auth = require('../src/auth');
const clientes = require('../src/clientes');
const equipe = require('../src/equipe');
const cargos = require('../src/cargos');
const lojas = require('../src/lojas');
require('../src/pedidos-loja'); // cria as colunas do Mercado Pago da loja

test.after(() => { try { db.db.close(); } catch { /* */ } try { fs.rmSync(PASTA, { recursive: true, force: true }); } catch { /* */ } });

const SENHA = 'Kw9#vTz4!qLm2x';
function conta(email, extra = {}) {
  const cols = { email, nome: 'Pessoa Teste', senha_hash: auth.hashPassword(SENHA), tipo: 'consumidor', status: 'active', ...extra };
  return Number(db.run(`INSERT INTO users (${Object.keys(cols).join(', ')}) VALUES (${Object.keys(cols).map(() => '?').join(', ')})`, ...Object.values(cols)).lastInsertRowid);
}

test('Gerente não troca a senha de quem não é da equipe (só o dono do site)', () => {
  const gerente = conta('gerente@exemplo.test', { staff: 1, cargo: 'gerente' });
  db.run(`INSERT OR IGNORE INTO cargo_permissoes (cargo, permissao) VALUES ('gerente', 'equipe')`);
  cargos.sincronizar(gerente);
  const cliente = conta('cliente@exemplo.test');
  const suporte = conta('suporte@exemplo.test', { staff: 1, cargo: 'suporte' });
  const nova = 'Outra#Senha9xYz!';
  assert.throws(() => equipe.definirSenha(cliente, nova, `u:${gerente}`), /Só o dono do site/);
  assert.throws(() => equipe.adicionar({ email: 'cliente@exemplo.test', cargo: 'suporte', senha: nova }, `u:${gerente}`), /senha dela/);
  // Pessoa da equipe de cargo abaixo: continua podendo
  equipe.definirSenha(suporte, nova, `u:${gerente}`);
  // O dono do site pode tudo
  equipe.definirSenha(cliente, nova, 'admin');
  assert.ok(auth.verifyPassword(nova, db.get('SELECT senha_hash FROM users WHERE id = ?', cliente).senha_hash));
});

test('conta nova com o e-mail de um afiliado não fica com o acesso dele sem provar que é a mesma pessoa', () => {
  const cid = clientes.criar({ nome: 'Afiliado Antigo', email: 'afiliado@exemplo.test', senha: SENHA, dias: 30 });
  const intruso = conta('afiliado@exemplo.test', { tipo: 'afiliado', senha_hash: auth.hashPassword('Senha#Do9Intruso') });
  const u = db.get('SELECT * FROM users WHERE id = ?', intruso);
  assert.throws(() => clientes.vincularUsuario(u), /já tem um acesso ao painel do afiliado/);
  assert.equal(db.get('SELECT cliente_id FROM users WHERE id = ?', intruso).cliente_id, null);
  // E-mail confirmado pelo Google: liga
  db.run(`UPDATE users SET google_id = 'g-123' WHERE id = ?`, intruso);
  assert.equal(clientes.vincularUsuario(db.get('SELECT * FROM users WHERE id = ?', intruso)), cid);
  // Já ligado a uma conta: outra conta com prova não leva
  const outra = db.get('SELECT * FROM users WHERE id = ?', conta('outra@exemplo.test'));
  assert.equal(clientes.ligacaoPermitida({ ...outra, email: 'afiliado@exemplo.test' }, clientes.getById(cid), true), false);
});

test('os tokens do Mercado Pago da loja não vão para o navegador', () => {
  const dono = conta('loja@exemplo.test', { tipo: 'empresa' });
  db.run(`INSERT INTO lojas (user_id, nome, slug, mp_access_token, mp_refresh_token) VALUES (?, 'Loja Teste', 'loja-teste', 'APP_USR-segredo', 'TG-segredo')`, dono);
  const l = lojas.paraODono(lojas.getByUser(dono));
  assert.equal(l.mp_access_token, undefined);
  assert.equal(l.mp_refresh_token, undefined);
  assert.equal(l.mp_conectado, true);
  assert.equal(l.nome, 'Loja Teste');
});

test('endereços internos escondidos em IPv6 são recusados (SSRF)', () => {
  const { assertPublicUrl } = require('../src/net');
  for (const u of ['http://[::ffff:127.0.0.1]/', 'http://[::ffff:169.254.169.254]/latest', 'http://[64:ff9b::a9fe:a9fe]/', 'http://[2002:7f00:1::]/', 'http://[::1]/', 'http://[fd00::1]/']) {
    assert.throws(() => assertPublicUrl(u), /não permitido/, u);
  }
  for (const u of ['http://[::ffff:8.8.8.8]/', 'http://[2606:4700:4700::1111]/', 'https://www.mercadolivre.com.br/']) assertPublicUrl(u);
});

test('conta suspensa fecha o painel do afiliado; senha nova vale também nele', () => {
  const cid = clientes.criar({ nome: 'Afiliado Ligado', email: 'ligado@exemplo.test', senha: SENHA, dias: 30 });
  const uid = conta('ligado@exemplo.test', { tipo: 'afiliado', cliente_id: cid });
  assert.ok(clientes.login('ligado@exemplo.test', SENHA));
  const nova = 'Nova#Senha7Forte!';
  require('../src/users').changePassword(db.get('SELECT * FROM users WHERE id = ?', uid), SENHA, nova);
  assert.throws(() => clientes.login('ligado@exemplo.test', SENHA), /incorretos/);
  assert.ok(clientes.login('ligado@exemplo.test', nova));
  db.run(`UPDATE users SET status = 'suspended' WHERE id = ?`, uid);
  assert.throws(() => clientes.login('ligado@exemplo.test', nova), /suspensa/);
});
