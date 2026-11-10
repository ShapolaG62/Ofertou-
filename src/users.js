// Usuários do site (consumidores e empresas): cadastro, login, sessão e moderação.
// São contas separadas do administrador: nenhum usuário do site acessa o painel /admin.
const crypto = require('crypto');
const db = require('./db');
const settings = require('./settings');
const { hashPassword, verifyPassword, tokenHash, parseCookies, cookieFlags } = require('./auth');
const cadastro = require('./cadastro');

// Campos cadastrais que o próprio usuário vê e (exceto documentos e e-mail) pode editar.
const PESSOA_FIELDS = ['nome', 'data_nascimento', 'telefone', 'cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf'];
const EMPRESA_FIELDS = ['empresa_tipo', 'razao_social', 'empresa_nome', 'inscricao_estadual', 'telefone_empresa', 'ramo', 'site_empresa',
  'emp_cep', 'emp_logradouro', 'emp_numero', 'emp_complemento', 'emp_bairro', 'emp_cidade', 'emp_uf'];

// Cadastro rápido (nome, celular e senha): a conta nasce com um e-mail provisório que nunca recebe mensagens
// (termina em .invalid, domínio reservado). A pessoa informa o e-mail de verdade e o CPF depois, em Meus dados.
try { db.db.exec('ALTER TABLE users ADD COLUMN email_provisorio INTEGER NOT NULL DEFAULT 0'); } catch { /* já existe */ }
const EMAIL_PROVISORIO = /@cadastro\.ofertou\.invalid$/;
const emailProvisorio = tel => `tel-${tel}@cadastro.ofertou.invalid`;

const COOKIE = 'gp_user';
const SESSION_DAYS = 180; // "lembrar de mim": renovado a cada uso (ver renovarSessao)
const MIN_PASSWORD = 8;
const TIPOS = ['consumidor', 'empresa', 'afiliado'];
const NOME_TIPO = { consumidor: 'consumidores', empresa: 'empresas', afiliado: 'afiliados (usuários da ferramenta)' };
const SIGNUP_MODES = ['aberto', 'aprovacao', 'fechado'];

// SQL reutilizado: conta liberada (ativa ou com suspensão já vencida)

const normalizeEmail = e => String(e || '').trim().toLowerCase();
const fmtDate = s => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');

function signupMode(tipo) {
  const mode = settings.get(`signup_${tipo}`);
  const m = SIGNUP_MODES.includes(mode) ? mode : 'aprovacao';
  // Acesso grátis à ferramenta nunca é liberado sozinho: sempre passa pela aprovação do admin.
  return tipo === 'afiliado' && m === 'aberto' ? 'aprovacao' : m;
}

// Formato enviado ao próprio usuário (sem hash de senha).
function publicUser(u) {
  if (!u) return null;
  const out = {
    id: u.id, tipo: u.tipo, email: u.email, cpf: u.cpf, cnpj: u.cnpj,
    status: u.status, bloqueio_publicacao: Boolean(u.bloqueio_publicacao), pode_postar: Boolean(u.pode_postar), pode_sac: Boolean(u.pode_sac), pode_moderar: Boolean(u.pode_moderar), pode_equipe: Boolean(u.pode_equipe), pode_punir: Boolean(u.pode_punir), cargo: u.staff ? u.cargo || null : null, staff: Boolean(u.staff),
    plano: u.plano || null, assinatura_ate: u.assinatura_ate || null,
    assinatura_vencida: Boolean(u.assinatura_ate && u.assinatura_ate < nowSql()),
    created_at: u.created_at,
    avatar_url: u.avatar_url, google: Boolean(u.google_id), tem_senha: Boolean(u.senha_hash),
    ferramenta: Boolean(u.cliente_id),
    cadastro_simplificado: Boolean(u.email_provisorio) || !u.cpf,
    email_provisorio: Boolean(u.email_provisorio),
  };
  for (const k of [...PESSOA_FIELDS, ...(u.tipo === 'empresa' ? EMPRESA_FIELDS : [])]) out[k] = u[k] ?? null;
  return out;
}

// e-mails, CPFs e CNPJs bloqueados pelo administrador ficam na mesma tabela ("cpf:...", "cnpj:...").
const isBlocked = key => Boolean(db.get('SELECT 1 FROM blocked_emails WHERE email = ?', key));

const allSignupsClosed = () => TIPOS.every(t => signupMode(t) === 'fechado');
const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// Passo 1: cria a conta só com e-mail e senha. O perfil (consumidor/empresa) e os dados vêm no primeiro acesso.
function register(body) {
  if (allSignupsClosed()) throw new Error('Os cadastros estão fechados no momento.');
  const email = normalizeEmail(body.email);
  const senha = String(body.senha || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) throw new Error('Informe um e-mail válido.');
  require('./senha').validar(senha, { email }); // padrão de senha forte
  if (body.senha_confirmacao !== undefined && body.senha_confirmacao !== senha) throw new Error('As senhas não conferem.');
  if (isBlocked(email)) throw new Error('Não é possível criar uma conta com este e-mail. Fale com o administrador.');
  const existing = db.get('SELECT google_id FROM users WHERE email = ?', email);
  if (existing) {
    throw new Error(existing.google_id
      ? 'Já existe uma conta com este e-mail criada pelo Google. Use "Entrar com Google".'
      : 'Já existe uma conta com este e-mail. Use "Entrar".');
  }
  const res = db.run(`INSERT INTO users (email, senha_hash, status) VALUES (?, ?, 'onboarding')`, email, hashPassword(senha));
  return getById(Number(res.lastInsertRowid));
}

// Cadastro rápido: só nome, celular (WhatsApp) e senha, mais os dois aceites (LGPD e Termos). A conta é de
// consumidor e segue a regra de liberação dos consumidores (Painel → Usuários). O resto vem depois, em Meus dados.
function registerRapido(body) {
  const modo = signupMode('consumidor');
  if (modo === 'fechado') throw new Error('Os cadastros estão fechados no momento.');
  const nome = String(body.nome || '').trim().replace(/\s+/g, ' ');
  if (nome.length < 3 || nome.length > 100) throw new Error('Informe o seu nome.');
  const tel = cadastro.digits(body.telefone);
  if (tel.length < 10 || tel.length > 11 || tel[0] === '0') throw new Error('Celular inválido: use DDD + número (ex.: 62 99999-9999).');
  const senha = String(body.senha || '');
  require('./senha').validar(senha, { nome });
  require('./consentimento').validar(body); // LGPD + Termos de Uso (duas caixas obrigatórias)
  if (isBlocked(`tel:${tel}`)) throw new Error('Não é possível criar uma conta com este número. Fale com o administrador.');
  if (db.get('SELECT 1 FROM users WHERE telefone = ?', tel)) throw new Error('Já existe uma conta com este celular. Use "Entrar" com o celular e a senha.');
  const email = emailProvisorio(tel);
  if (db.get('SELECT 1 FROM users WHERE email = ?', email)) throw new Error('Já existe uma conta com este celular. Use "Entrar".');
  const status = modo === 'aberto' ? 'active' : 'pending';
  const res = db.run(`INSERT INTO users (email, senha_hash, nome, telefone, tipo, status, email_provisorio, aceite_termos_em)
    VALUES (?, ?, ?, ?, 'consumidor', ?, 1, datetime('now'))`, email, hashPassword(senha), nome, tel, status);
  const u = getById(Number(res.lastInsertRowid));
  logAction(u, 'cadastro_rapido', `cadastro rápido (nome, celular e senha)${status === 'pending' ? ', aguardando aprovação' : ''}`);
  return u;
}

// Login/cadastro com Google: acha pela conta Google, depois pelo e-mail (vincula) ou cria uma conta nova.
function loginWithGoogle(profile) {
  let u = db.get('SELECT * FROM users WHERE google_id = ?', profile.sub)
    || db.get('SELECT * FROM users WHERE email = ?', profile.email);
  if (u && !u.google_id) {
    db.run('UPDATE users SET google_id = ?, avatar_url = COALESCE(avatar_url, ?) WHERE id = ?', profile.sub, profile.picture, u.id);
    u = getById(u.id);
  }
  if (!u) {
    if (allSignupsClosed()) throw new Error('Os cadastros estão fechados no momento.');
    if (isBlocked(profile.email)) throw new Error('Não é possível criar uma conta com este e-mail. Fale com o administrador.');
    const res = db.run(
      `INSERT INTO users (email, google_id, avatar_url, nome, status) VALUES (?, ?, ?, ?, 'onboarding')`,
      profile.email, profile.sub, profile.picture, String(profile.name || '').slice(0, 100) || null
    );
    u = getById(Number(res.lastInsertRowid));
  }
  const reason = blockedReason(u);
  if (reason) throw Object.assign(new Error(reason), { status: 403 });
  db.run(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`, u.id);
  return u;
}

// Passo 2 (primeiro acesso): escolhe o perfil e informa os dados cadastrais.
function completeProfile(u, body) {
  if (u.status !== 'onboarding') throw new Error('Seu perfil já foi definido.');
  const tipo = String(body.tipo || '');
  if (!TIPOS.includes(tipo)) throw new Error('Escolha o perfil: consumidor, empresarial ou usuário da ferramenta.');
  const mode = signupMode(tipo);
  if (mode === 'fechado') throw new Error(`Os cadastros de ${NOME_TIPO[tipo]} estão fechados no momento.`);
  require('./consentimento').validar(body); // LGPD + Termos de Uso (duas caixas obrigatórias)
  require('./consentimento').validarParceiro(body, require('./consentimento').papeisDe({ tipo })); // lojista / afiliado
  const dados = { ...cadastro.dadosPessoa(body), ...(tipo === 'empresa' ? cadastro.dadosEmpresa(body) : {}) };
  if (isBlocked(`cpf:${dados.cpf}`) || (dados.cnpj && isBlocked(`cnpj:${dados.cnpj}`))) {
    throw new Error('Não é possível concluir o cadastro com estes dados. Fale com o administrador.');
  }
  if (db.get('SELECT 1 FROM users WHERE cpf = ? AND id <> ?', dados.cpf, u.id)) throw new Error('Já existe uma conta com este CPF.');
  if (dados.cnpj && db.get('SELECT 1 FROM users WHERE cnpj = ? AND id <> ?', dados.cnpj, u.id)) throw new Error('Já existe uma conta com este CNPJ.');

  const status = mode === 'aberto' ? 'active' : 'pending';
  const cols = { tipo, status, aceite_termos_em: nowSql(), ...dados };
  db.run(`UPDATE users SET ${Object.keys(cols).map(c => `${c} = ?`).join(', ')} WHERE id = ?`, ...Object.values(cols), u.id);
  logAction(getById(u.id), 'cadastro_concluido', `perfil ${tipo}${status === 'pending' ? ', aguardando aprovação' : ''}`);
  return getById(u.id);
}

const getById = id => db.get('SELECT * FROM users WHERE id = ?', id);

// Explica por que a conta não pode entrar (ou null se pode). Contas em cadastro ou aguardando
// aprovação podem entrar, mas só enxergam a tela de cadastro/espera (ver requireActive).
function blockedReason(u) {
  if (u.status === 'rejected') return `Seu cadastro não foi aprovado.${u.status_motivo ? ` Motivo: ${u.status_motivo}` : ''}`;
  if (u.status === 'banned') return `Esta conta foi banida.${u.status_motivo ? ` Motivo: ${u.status_motivo}` : ''}`;
  if (u.status === 'suspended') {
    const until = new Date(String(u.suspenso_ate).replace(' ', 'T') + 'Z');
    if (until > new Date()) {
      return `Conta suspensa até ${fmtDate(u.suspenso_ate)}.${u.status_motivo ? ` Motivo: ${u.status_motivo}` : ''}`;
    }
    db.run(`UPDATE users SET status = 'active', status_motivo = NULL, suspenso_ate = NULL WHERE id = ?`, u.id);
    u.status = 'active';
  }
  return null;
}

// Entrar com o e-mail ou com o celular (sem @: procura pelo celular cadastrado; aceita com ou sem o 55 do Brasil)
function acharParaLogin(entrada) {
  const e = String(entrada || '').trim();
  if (e.includes('@')) return db.get('SELECT * FROM users WHERE email = ?', normalizeEmail(e));
  let tel = cadastro.digits(e);
  if (tel.length === 13 && tel.startsWith('55')) tel = tel.slice(2);
  if (tel.length < 10 || tel.length > 11) return null;
  const achados = db.all('SELECT * FROM users WHERE telefone = ? ORDER BY id', tel);
  if (achados.length > 1) throw new Error('Há mais de uma conta com este celular. Entre com o e-mail.');
  return achados[0] || null;
}

function login(email, senha) {
  const u = acharParaLogin(email);
  if (u && !u.senha_hash) throw new Error('Esta conta foi criada com o Google. Use "Entrar com Google".');
  if (!u || !verifyPassword(String(senha || ''), u.senha_hash)) throw new Error('E-mail/celular ou senha incorretos.');
  const reason = blockedReason(u);
  if (reason) throw Object.assign(new Error(reason), { status: 403 });
  if (planoVencido(u)) throw erroPlanoVencido(u); // plano pago vencido: avisa e manda reativar
  db.run(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`, u.id);
  return u;
}

// ── Plano pago: o login dura o prazo contratado ──────────────────────────────
const msSql = s => new Date(String(s).replace(' ', 'T') + 'Z').getTime();
const sqlMs = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const vencidoNoBanco = u => Boolean(u && u.assinatura_ate && u.assinatura_ate < nowSql());
// Plano pago vencido: se existe um plano grátis para este tipo de conta, a conta volta para ele (permanente,
// até assinar de novo). Atualiza o objeto recebido. Retorna true se voltou para o grátis.
function voltarParaGratis(u) {
  if (!vencidoNoBanco(u)) return false;
  const planos = require('./planos');
  const g = planos.planoGratisPara(u.tipo);
  if (!g) return false;
  const tipo = g.perfis.includes(u.tipo) ? u.tipo : g.perfis[0] || u.tipo;
  const r = db.run(`UPDATE users SET plano = ?, assinatura_ate = ?, tipo = ? WHERE id = ? AND assinatura_ate < datetime('now')`,
    g.id, planos.SEM_VENCIMENTO, tipo, u.id);
  if (g.ferramenta && u.cliente_id) {
    db.run(`UPDATE clientes SET plano = ?, validade = ?, status = 'ativo' WHERE id = ? AND validade < datetime('now') AND status <> 'bloqueado'`,
      g.id, planos.SEM_VENCIMENTO, u.cliente_id);
  }
  if (r.changes) logAction(getById(u.id), 'plano_gratis', `Plano ${planos.plano(u.plano)?.nome || u.plano || ''} venceu: voltou para ${g.nome}`);
  Object.assign(u, { plano: g.id, assinatura_ate: planos.SEM_VENCIMENTO, tipo });
  return true;
}
const planoVencido = u => vencidoNoBanco(u) && !voltarParaGratis(u);
const RENOVACAO_MS = 2 * 3600000; // plano vencido: sessão curta, só para reativar (ex.: conta do Google)

// Até quando a sessão vale: conta com plano pago → até o fim do plano; sem plano → 180 dias sem uso.
function fimSessao(u) {
  if (planoVencido(u)) return Date.now() + RENOVACAO_MS;
  const max = Date.now() + SESSION_DAYS * 86400000;
  return u && u.assinatura_ate ? Math.min(max, msSql(u.assinatura_ate)) : max;
}

// Erro mostrado ao tentar entrar com o plano vencido (com o link para reativar).
function erroPlanoVencido(u) {
  const planos = require('./planos');
  const p = planos.plano(u.plano || { empresa: 'empresa', afiliado: 'pro' }[u.tipo] || 'consumidor');
  const data = new Date(msSql(u.assinatura_ate)).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  return Object.assign(new Error(`Seu plano ${p ? p.nome : ''} venceu em ${data}. Reative o plano para voltar a usar o Ofertou!`),
    { status: 402, reativar: `/assinar?plano=${p ? p.id : 'consumidor'}&renovar=1`, plano: p ? p.id : 'consumidor' });
}

function createSession(req, res, userId) {
  try { require('./registro-acesso').gravar(req, `u:${userId}`, 'login'); } catch { /* registro opcional */ }
  const token = crypto.randomBytes(32).toString('hex');
  const fim = fimSessao(getById(userId));
  db.run('INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', tokenHash(token), userId, sqlMs(fim));
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Max-Age=${Math.max(1, Math.floor((fim - Date.now()) / 1000))}; ${cookieFlags(req)}`);
}

// Sessão deslizante: renova enquanto a pessoa usa o site, sem passar do fim do plano pago.
// Ajusta também quando o plano é renovado (estende) ou vence (encurta para a sessão de reativação).
function renovarSessao(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return;
  const s = db.get(`SELECT s.expires_at, u.* FROM user_sessions s JOIN users u ON u.id = s.user_id
                    WHERE s.token_hash = ? AND s.expires_at > datetime('now')`, tokenHash(token));
  if (!s) return;
  const atual = msSql(s.expires_at);
  const fim = planoVencido(s) ? Math.min(atual, Date.now() + RENOVACAO_MS) : fimSessao(s);
  if (fim > atual + 86400000 || fim < atual - 60000) {
    db.run('UPDATE user_sessions SET expires_at = ? WHERE token_hash = ?', sqlMs(fim), tokenHash(token));
    res.append('Set-Cookie', `${COOKIE}=${token}; Max-Age=${Math.max(1, Math.floor((fim - Date.now()) / 1000))}; ${cookieFlags(req)}`);
  }
}

function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.run('DELETE FROM user_sessions WHERE token_hash = ?', tokenHash(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieFlags(req)}`);
}

// Usuário da sessão atual; sessões de contas banidas/suspensas/recusadas deixam de valer na hora.
function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const u = db.get(
    `SELECT u.* FROM user_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > datetime('now')`, tokenHash(token)
  );
  if (!u || blockedReason(u)) return null;
  planoVencido(u); // pago vencido com plano grátis disponível: volta para o grátis
  return u;
}

function requireUser(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Entre na sua conta para continuar.' });
  req.user = u;
  next();
}

// Ferramentas (loja, anúncios, dados) só para contas com perfil definido e liberadas.
function requireActive(req, res, next) {
  const u = req.user;
  if (u.status === 'onboarding') return res.status(403).json({ error: 'Conclua seu cadastro escolhendo o perfil.' });
  if (u.status === 'pending') return res.status(403).json({ error: 'Seu cadastro está aguardando aprovação do administrador.' });
  if (u.assinatura_ate && u.assinatura_ate < nowSql()) return res.status(403).json({ error: 'Sua assinatura venceu. Renove o plano para continuar.' });
  next();
}

// Atualiza os dados cadastrais (CPF, CNPJ e e-mail não podem ser trocados pelo próprio usuário).
function updateProfile(u, body) {
  const dados = {
    ...cadastro.dadosPessoa(body, { exigirDocumento: false }),
    ...(u.tipo === 'empresa' ? cadastro.dadosEmpresa({ ...body, empresa_tipo: u.empresa_tipo || 'pj' }, { exigirDocumento: false }) : {}),
  };
  // Cadastro rápido: completa o e-mail (que ainda é o provisório) e o CPF (que ainda não existe)
  if (u.email_provisorio || EMAIL_PROVISORIO.test(u.email || '')) {
    const email = normalizeEmail(body.email);
    if (email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120 || EMAIL_PROVISORIO.test(email)) throw new Error('Informe um e-mail válido.');
      if (isBlocked(email)) throw new Error('Não é possível usar este e-mail. Fale com o administrador.');
      if (db.get('SELECT 1 FROM users WHERE email = ? AND id <> ?', email, u.id)) throw new Error('Este e-mail já é usado por outra conta.');
      dados.email = email; dados.email_provisorio = 0;
    }
  }
  if (!u.cpf && body.cpf) {
    const cpf = cadastro.digits(body.cpf);
    if (!cadastro.validCpf(cpf)) throw new Error('CPF inválido.');
    if (isBlocked(`cpf:${cpf}`)) throw new Error('Não é possível usar este CPF. Fale com o administrador.');
    if (db.get('SELECT 1 FROM users WHERE cpf = ? AND id <> ?', cpf, u.id)) throw new Error('Já existe uma conta com este CPF.');
    dados.cpf = cpf;
  }
  if (db.get('SELECT 1 FROM users WHERE telefone = ? AND id <> ?', dados.telefone, u.id) && u.email_provisorio) {
    throw new Error('Este celular já é usado por outra conta.');
  }
  const cols = Object.keys(dados);
  db.run(`UPDATE users SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`, ...Object.values(dados), u.id);
}

// Contas criadas pelo Google podem definir uma senha sem informar a atual.
function changePassword(u, atual, nova) {
  if (u.senha_hash && !verifyPassword(String(atual || ''), u.senha_hash)) throw new Error('Senha atual incorreta.');
  require('./senha').validar(nova, { email: u.email, nome: u.nome }); // padrão de senha forte
  const novoHash = hashPassword(nova);
  db.run('UPDATE users SET senha_hash = ? WHERE id = ?', novoHash, u.id);
  db.run('DELETE FROM user_sessions WHERE user_id = ?', u.id);
  require('./clientes').aoTrocarSenhaDaConta(u.id, novoHash);
}

function deleteOwnAccount(u, body) {
  if (u.senha_hash) {
    if (!verifyPassword(String(body.senha || ''), u.senha_hash)) throw new Error('Senha incorreta.');
  } else if (String(body.confirmacao || '').trim().toUpperCase() !== 'EXCLUIR') {
    throw new Error('Digite EXCLUIR para confirmar.');
  }
  logAction(u, 'conta_excluida_pelo_usuario', null);
  if (u.cliente_id) require('./whatsapp-proprio').esquecer(`c:${u.cliente_id}`).catch(err => console.error('[CONTA] WhatsApp:', err.message));
  db.run('DELETE FROM users WHERE id = ?', u.id); // loja, anúncios e sessões saem junto (ON DELETE CASCADE)
  require('./perfis').excluir(`u:${u.id}`); // perfil, conquistas e fotos
}

// ── Moderação (usado pelo painel do administrador) ────────────────────────────
function logAction(u, acao, detalhe) {
  db.run('INSERT INTO moderation_log (user_id, user_email, acao, detalhe) VALUES (?, ?, ?, ?)',
    u ? u.id : null, u ? u.email : null, acao, detalhe || null);
}

const killSessions = id => db.run('DELETE FROM user_sessions WHERE user_id = ?', id);

function moderate(id, action, { motivo = '', dias = 0, bloquearEmail = false } = {}) {
  const u = getById(id);
  if (!u) throw Object.assign(new Error('Usuário não encontrado.'), { status: 404 });
  motivo = String(motivo || '').trim().slice(0, 300);

  switch (action) {
    case 'aprovar':
      db.run(`UPDATE users SET status = 'active', status_motivo = NULL, suspenso_ate = NULL WHERE id = ?`, id);
      // Afiliado aprovado ganha o acesso à ferramenta (painel do cliente) ligado à mesma conta.
      if (u.tipo === 'afiliado') require('./clientes').vincularUsuario(getById(id));
      logAction(u, 'aprovado');
      break;
    case 'recusar':
      db.run(`UPDATE users SET status = 'rejected', status_motivo = ? WHERE id = ?`, motivo || null, id);
      killSessions(id);
      logAction(u, 'cadastro_recusado', motivo);
      break;
    case 'suspender': {
      const d = Math.min(Math.max(parseInt(dias, 10) || 0, 1), 365);
      db.run(`UPDATE users SET status = 'suspended', status_motivo = ?, suspenso_ate = datetime('now', ?) WHERE id = ?`,
        motivo || null, `+${d} days`, id);
      killSessions(id);
      logAction(u, 'suspenso', `${d} dia(s)${motivo ? ` — ${motivo}` : ''}`);
      break;
    }
    case 'banir':
      db.run(`UPDATE users SET status = 'banned', status_motivo = ?, suspenso_ate = NULL WHERE id = ?`, motivo || null, id);
      killSessions(id);
      logAction(u, 'banido', motivo);
      break;
    case 'reativar':
      db.run(`UPDATE users SET status = 'active', status_motivo = NULL, suspenso_ate = NULL WHERE id = ?`, id);
      logAction(u, 'reativado');
      break;
    case 'bloquear_publicacao':
      db.run('UPDATE users SET bloqueio_publicacao = 1 WHERE id = ?', id);
      logAction(u, 'publicacoes_bloqueadas', motivo);
      break;
    case 'liberar_publicacao':
      db.run('UPDATE users SET bloqueio_publicacao = 0 WHERE id = ?', id);
      logAction(u, 'publicacoes_liberadas');
      break;
    case 'permitir_postagens':
      db.run('UPDATE users SET pode_postar = 1 WHERE id = ?', id);
      logAction(u, 'postagens_permitidas');
      break;
    case 'remover_postagens':
      db.run('UPDATE users SET pode_postar = 0 WHERE id = ?', id);
      logAction(u, 'postagens_removidas', motivo);
      break;
    case 'permitir_sac':
      db.run('UPDATE users SET pode_sac = 1 WHERE id = ?', id);
      logAction(u, 'atendente_sac_permitido');
      break;
    case 'remover_sac':
      db.run('UPDATE users SET pode_sac = 0 WHERE id = ?', id);
      logAction(u, 'atendente_sac_removido', motivo);
      break;
    case 'excluir_loja': {
      const loja = db.get('SELECT id FROM lojas WHERE user_id = ?', id);
      if (!loja) throw Object.assign(new Error('Este usuário não tem loja.'), { status: 400 });
      const r = require('./lojas').excluirLoja(loja.id);
      logAction(u, 'loja_excluida', `"${r.loja}", ${r.produtos} produto(s)${motivo ? ` — ${motivo}` : ''}`);
      break;
    }
    case 'excluir_publicacoes': {
      const n = db.run('DELETE FROM offers WHERE loja_id IN (SELECT id FROM lojas WHERE user_id = ?)', id).changes;
      logAction(u, 'publicacoes_excluidas', `${n} produto(s)${motivo ? ` — ${motivo}` : ''}`);
      break;
    }
    case 'excluir':
      require('./perfis').excluir(`u:${id}`);
      if (bloquearEmail) {
        // Bloqueia e-mail, CPF e CNPJ para a pessoa não voltar com outro e-mail.
        for (const key of [u.email, u.cpf && `cpf:${u.cpf}`, u.cnpj && `cnpj:${u.cnpj}`].filter(Boolean)) {
          db.run('INSERT OR REPLACE INTO blocked_emails (email, motivo) VALUES (?, ?)', key, motivo || null);
        }
      }
      logAction(u, 'perfil_excluido', `${motivo || ''}${bloquearEmail ? ' (e-mail e documentos bloqueados)' : ''}`.trim());
      if (u.cliente_id) require('./whatsapp-proprio').esquecer(`c:${u.cliente_id}`).catch(err => console.error('[USUARIOS] WhatsApp:', err.message));
      db.run('DELETE FROM users WHERE id = ?', id);
      break;
    default:
      throw Object.assign(new Error('Ação desconhecida.'), { status: 400 });
  }
  return getById(id);
}

function listForAdmin({ q = '', tipo = '', status = '', page = 1, perPage = 30 }) {
  const where = [];
  const params = [];
  if (q) {
    const doc = cadastro.digits(q);
    where.push('(u.nome LIKE ? OR u.email LIKE ? OR u.empresa_nome LIKE ? OR u.razao_social LIKE ? OR l.nome LIKE ?'
      + (doc.length >= 5 ? ' OR u.cpf LIKE ? OR u.cnpj LIKE ?' : '') + ')');
    params.push(...Array(5).fill(`%${q}%`), ...(doc.length >= 5 ? [`%${doc}%`, `%${doc}%`] : []));
  }
  if (TIPOS.includes(tipo)) { where.push('u.tipo = ?'); params.push(tipo); }
  if (status) { where.push('u.status = ?'); params.push(status); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = 'FROM users u LEFT JOIN lojas l ON l.user_id = u.id';
  const total = db.get(`SELECT COUNT(*) AS n ${from} ${whereSql}`, ...params).n;
  const rows = db.all(
    `SELECT u.id, u.tipo, u.nome, u.email, u.empresa_nome, u.cnpj, u.status, u.status_motivo, u.suspenso_ate,
            u.bloqueio_publicacao, u.pode_postar, u.pode_sac, u.created_at, u.last_login_at,
            l.id AS loja_id, l.nome AS loja_nome, l.slug AS loja_slug, l.oculta AS loja_oculta,
            (SELECT COUNT(*) FROM offers o WHERE o.loja_id = l.id) AS produtos
     ${from} ${whereSql}
     ORDER BY CASE u.status WHEN 'pending' THEN 0 WHEN 'onboarding' THEN 2 ELSE 1 END, u.created_at DESC
     LIMIT ? OFFSET ?`,
    ...params, perPage, (page - 1) * perPage
  );
  const pending = db.get(`SELECT COUNT(*) AS n FROM users WHERE status = 'pending'`).n;
  return { total, page, perPage, pending, rows };
}

function detailForAdmin(id) {
  const u = getById(id);
  if (!u) return null;
  const { senha_hash, ...user } = u;
  const loja = db.get('SELECT * FROM lojas WHERE user_id = ?', id) || null;
  const produtos = loja ? db.all(
    `SELECT id, produto, preco_atual, preco_anterior, desconto_pct, fonte, oculto, link_clicks, created_at, expires_at,
            affiliate_url, (expires_at > datetime('now')) AS no_prazo
     FROM offers WHERE loja_id = ? ORDER BY created_at DESC LIMIT 500`, loja.id
  ) : [];
  const historico = db.all('SELECT acao, detalhe, created_at FROM moderation_log WHERE user_id = ? ORDER BY id DESC LIMIT 50', id);
  return { user, loja, produtos, historico };
}

module.exports = {
  planoVencido, erroPlanoVencido,
  renovarSessao,
  TIPOS, SIGNUP_MODES, signupMode, register, registerRapido, login, createSession, destroySession, currentUser,
  requireUser, requireActive, loginWithGoogle, completeProfile, publicUser, updateProfile, changePassword, deleteOwnAccount, moderate, listForAdmin, detailForAdmin,
  getById, logAction, acharParaLogin, blockedReason,
};
