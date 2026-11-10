// "Esqueci minha senha" das contas do site (consumidor, empresa e afiliado).
// A pessoa informa o e-mail ou o celular da conta; o site manda para o E-MAIL da conta um link que vale 1 hora e
// funciona uma vez só. No link ela cria a senha nova (mesmo padrão de senha forte do cadastro); as sessões abertas
// da conta são encerradas. A resposta do pedido é sempre a mesma, exista a conta ou não (ninguém descobre quais
// e-mails têm cadastro). O login "admin" do painel não passa por aqui.
const crypto = require('crypto');
const db = require('./db');
const settings = require('./settings');
const users = require('./users');
const { hashPassword } = require('./auth');

const VALIDADE_MIN = 60;
db.db.exec(`CREATE TABLE IF NOT EXISTS senha_reset (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  usado INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const hash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const RESPOSTA = 'Se existir uma conta com esse e-mail ou celular, enviamos para o e-mail dela um link para criar uma senha nova. '
  + 'Ele vale por 1 hora. Confira também a caixa de spam.';

// Pede o link. Devolve sempre a mesma mensagem; o envio do e-mail acontece em segundo plano.
function pedir(entrada, baseUrl) {
  const e = String(entrada || '').trim();
  if (!e) throw fail('Informe o e-mail ou o celular da sua conta.');
  if (e.toLowerCase() === 'admin') return { mensagem: RESPOSTA }; // a senha do painel não é trocada por aqui
  let u = null;
  try { u = users.acharParaLogin(e); } catch { u = null; } // celular repetido em duas contas: não manda nada
  const email = u && String(u.email || '').trim();
  if (!u || !email || /\.invalid$/i.test(email) || ['rejected', 'banned'].includes(u.status)) return { mensagem: RESPOSTA };

  const token = crypto.randomBytes(32).toString('hex');
  db.run('DELETE FROM senha_reset WHERE user_id = ?', u.id); // só o link mais novo vale
  db.run(`INSERT INTO senha_reset (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`, hash(token), u.id, `+${VALIDADE_MIN} minutes`);
  const site = (String(settings.get('site_url') || '').replace(/\/+$/, '') || baseUrl).replace(/\/+$/, '');
  const link = `${site}/conta?redefinir=${token}`;
  const nome = String(u.nome || '').split(' ')[0];
  require('./email').enviar({
    para: email,
    assunto: 'Ofertou!: criar uma senha nova',
    texto: `Olá${nome ? `, ${nome}` : ''}!\n\nRecebemos um pedido para criar uma senha nova para a sua conta no Ofertou!.\n\n`
      + `Abra este link para criar a senha (vale por 1 hora e funciona uma vez só):\n${link}\n\n`
      + 'Se não foi você, é só ignorar este e-mail: a sua senha continua a mesma.',
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;line-height:1.5">
      <p>Olá${nome ? `, ${nome.replace(/[<>&"]/g, '')}` : ''}!</p>
      <p>Recebemos um pedido para criar uma senha nova para a sua conta no <b>Ofertou!</b>.</p>
      <p><a href="${link}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:#1fa463;color:#fff;text-decoration:none;font-weight:bold">Criar senha nova</a></p>
      <p style="font-size:13px;color:#666">O link vale por 1 hora e funciona uma vez só. Se o botão não abrir, copie e cole no navegador:<br>${link}</p>
      <p style="font-size:13px;color:#666">Se não foi você, é só ignorar este e-mail: a sua senha continua a mesma.</p></div>`,
  }).then(() => users.logAction(u, 'senha_link_enviado', null))
    .catch(err => console.error('[SENHA] não foi possível enviar o link:', err.message));
  return { mensagem: RESPOSTA };
}

// Confere se o link ainda vale (para a tela mostrar o formulário ou avisar que expirou)
function conferir(token) {
  const r = token && db.get(`SELECT r.user_id, u.email FROM senha_reset r JOIN users u ON u.id = r.user_id
    WHERE r.token_hash = ? AND r.usado = 0 AND r.expires_at > datetime('now')`, hash(token));
  if (!r) throw fail('Este link para criar a senha expirou ou já foi usado. Peça um novo em "Esqueci minha senha".', 410);
  return { email: r.email };
}

// Cria a senha nova pelo link
function redefinir(token, nova) {
  conferir(token);
  const r = db.get('SELECT user_id FROM senha_reset WHERE token_hash = ?', hash(token));
  const u = users.getById(r.user_id);
  if (!u) throw fail('Conta não encontrada.', 404);
  require('./senha').validar(nova, { email: u.email, nome: u.nome }); // padrão de senha forte
  const novoHash = hashPassword(nova);
  db.transaction(() => {
    db.run('UPDATE users SET senha_hash = ? WHERE id = ?', novoHash, u.id);
    require('./clientes').aoTrocarSenhaDaConta(u.id, novoHash);
    db.run('DELETE FROM user_sessions WHERE user_id = ?', u.id); // quem estava logado com a senha antiga sai
    db.run('DELETE FROM senha_reset WHERE user_id = ?', u.id);
  });
  users.logAction(u, 'senha_redefinida', 'pelo link de "Esqueci minha senha"');
  return { ok: true };
}

module.exports = { pedir, conferir, redefinir };
