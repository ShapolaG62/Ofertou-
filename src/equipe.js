// Equipe (staff): contas do site que trabalham para o Ofertou!, cada uma com um cargo
// (Proprietário, Gerente, Admin, Moderador ou Suporte — ver src/cargos.js).
// O cargo define o que a pessoa faz na Área de trabalho (/trabalho). Ninguém da equipe entra no painel administrativo.
// Quem gerencia a equipe só cadastra e muda pessoas de cargos ABAIXO do seu; o dono do site (admin) gerencia todos.
const db = require('./db');
const { hashPassword } = require('./auth');
const users = require('./users');
const cargos = require('./cargos');

try { db.db.exec('ALTER TABLE users ADD COLUMN staff INTEGER NOT NULL DEFAULT 0'); } catch { /* já existe */ }

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

function montar(u) {
  const c = cargos.cargo(u.cargo);
  return {
    id: u.id, nome: u.nome, email: u.email, status: u.status, tipo: u.tipo, staff: Boolean(u.staff),
    cargo: c?.id || null, cargo_nome: c?.nome || 'Sem cargo', nivel: c?.nivel || 0, permissoes: c ? cargos.permissoesDe(c.id) : [],
    google: Boolean(u.google_id), created_at: u.created_at, last_login_at: u.last_login_at,
  };
}

// Lista (com o que quem está vendo pode fazer com cada pessoa)
function listar(quem = 'admin') {
  const eu = cargos.de(quem);
  return db.all(`SELECT * FROM users WHERE staff = 1 ORDER BY nome COLLATE NOCASE`).map(montar)
    .sort((a, b) => b.nivel - a.nivel || String(a.nome).localeCompare(String(b.nome)))
    .map(p => ({ ...p, pode_gerenciar: eu.dono_site || (eu.permissoes.includes('equipe') && p.nivel < eu.nivel && `u:${p.id}` !== quem) }));
}

// Cargos que quem está fazendo a ação pode dar (abaixo do seu; o dono do site dá qualquer um)
function cargosPermitidos(quem) {
  const eu = cargos.de(quem);
  if (eu.dono_site) return cargos.CARGOS.map(c => c.id);
  if (!eu.permissoes.includes('equipe')) return [];
  return cargos.CARGOS.filter(c => c.nivel < eu.nivel).map(c => c.id);
}
function exigirGerenciar(quem, alvo) {
  const eu = cargos.de(quem);
  if (eu.dono_site) return;
  if (!eu.permissoes.includes('equipe')) throw fail('Seu cargo não gerencia a equipe.', 403);
  if (`u:${alvo.id}` === quem) throw fail('Você não pode mudar o seu próprio cargo.', 403);
  if (alvo.staff && cargos.nivelCargo(alvo.cargo) >= eu.nivel) throw fail('Você só pode gerenciar pessoas de cargos abaixo do seu.', 403);
}
function conferirCargo(quem, novo) {
  if (!cargos.cargo(novo)) throw fail('Escolha o cargo.');
  if (!cargosPermitidos(quem).includes(novo)) throw fail('Você só pode dar cargos abaixo do seu.', 403);
}
const nomeQuem = quem => (quem === 'admin' ? 'administrador' : require('./chat').pessoa(quem).nome);

// Cadastra uma pessoa nova na equipe, ou coloca na equipe uma conta que já existe (pelo e-mail)
function adicionar(b, quem = 'admin') {
  const email = String(b.email || '').trim().toLowerCase();
  const nome = String(b.nome || '').trim().slice(0, 80);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) throw fail('Informe um e-mail válido.');
  const novo = String(b.cargo || '');
  conferirCargo(quem, novo);
  const existe = db.get('SELECT * FROM users WHERE email = ?', email);
  let id;
  if (existe) {
    if (['banned', 'rejected'].includes(existe.status)) throw fail('Esta conta está banida ou recusada. Reative a conta antes.');
    exigirGerenciar(quem, existe);
    // Conta que já existe (cliente, lojista, afiliado): a senha é da pessoa; só o dono do site pode trocar
    if (b.senha && !existe.staff && !cargos.de(quem).dono_site) throw fail('Esta conta já existe: a pessoa entra com a senha dela. Deixe o campo de senha em branco.', 403);
    db.run(`UPDATE users SET staff = 1, cargo = ?, nome = COALESCE(NULLIF(nome, ''), ?) WHERE id = ?`, novo, nome || null, existe.id);
    if (b.senha) definirSenha(existe.id, b.senha, quem, false);
    id = existe.id;
  } else {
    if (!nome) throw fail('Informe o nome da pessoa.');
    const senha = String(b.senha || '');
    require('./senha').validar(senha, { email, nome }); // padrão de senha forte
    id = Number(db.run(`INSERT INTO users (email, nome, senha_hash, tipo, status, staff, cargo) VALUES (?, ?, ?, 'consumidor', 'active', 1, ?)`,
      email, nome, hashPassword(senha), novo).lastInsertRowid);
  }
  cargos.sincronizar(id);
  users.logAction(users.getById(id), 'equipe_adicionado', `cargo ${cargos.cargo(novo).nome} (por ${nomeQuem(quem)})`);
  return montar(users.getById(id));
}

// Troca o cargo
function atualizar(id, b, quem = 'admin') {
  const u = users.getById(Number(id));
  if (!u || !u.staff) throw fail('Pessoa não encontrada na equipe.', 404);
  exigirGerenciar(quem, u);
  const novo = String(b.cargo || '');
  conferirCargo(quem, novo);
  db.run('UPDATE users SET cargo = ? WHERE id = ?', novo, u.id);
  cargos.sincronizar(u.id);
  users.logAction(users.getById(u.id), 'equipe_cargo', `${cargos.cargo(u.cargo)?.nome || 'sem cargo'} → ${cargos.cargo(novo).nome} (por ${nomeQuem(quem)})`);
  return montar(users.getById(u.id));
}

function definirSenha(id, senha, quem = 'admin', registrar = true) {
  senha = String(senha || '');
  const u = users.getById(Number(id));
  if (!u) throw fail('Pessoa não encontrada.', 404);
  exigirGerenciar(quem, u);
  if (!u.staff && !cargos.de(quem).dono_site) throw fail('Só o dono do site pode trocar a senha de quem não é da equipe.', 403);
  require('./senha').validar(senha, { email: u.email, nome: u.nome }); // padrão de senha forte
  const novoHash = hashPassword(senha);
  db.run('UPDATE users SET senha_hash = ? WHERE id = ?', novoHash, u.id);
  db.run('DELETE FROM user_sessions WHERE user_id = ?', u.id); // sai de todos os aparelhos
  require('./clientes').aoTrocarSenhaDaConta(u.id, novoHash);
  if (registrar) users.logAction(u, 'equipe_senha', `senha redefinida por ${nomeQuem(quem)}`);
  return montar(users.getById(u.id));
}

// Tira da equipe (a conta continua existindo como conta comum do site)
function remover(id, quem = 'admin') {
  const u = users.getById(Number(id));
  if (!u) throw fail('Pessoa não encontrada.', 404);
  exigirGerenciar(quem, u);
  db.run('UPDATE users SET staff = 0, cargo = NULL WHERE id = ?', u.id);
  cargos.sincronizar(u.id);
  users.logAction(u, 'equipe_removido', `por ${nomeQuem(quem)}`);
  return true;
}

module.exports = { listar, adicionar, atualizar, definirSenha, remover, cargosPermitidos };
