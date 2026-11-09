// Clientes da ferramenta (acesso vendido pelo admin): cada um tem login próprio com validade, os próprios links
// de afiliado e os próprios canais (WhatsApp, Telegram...). Nada do admin é usado ou exibido para o cliente:
// sem link de afiliado configurado, o produto vai sem comissão — nunca com a do admin.
const crypto = require('crypto');
const db = require('./db');
const settings = require('./settings');
const auth = require('./auth');
const { getStore } = require('./stores');

const COOKIE = 'gp_cliente';
const SESSION_DAYS = 180; // renovado a cada uso (ver renovarSessao)
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Configurações que pertencem a cada cliente (valores padrão iguais aos do site, com as chaves vazias).
const AFILIADO_KEYS = ['amazon_tag', 'ml_matt_word', 'ml_matt_tool', 'kabum_afiliado', 'magalu_store',
  'aliexpress_app_key', 'aliexpress_app_secret', 'aliexpress_tracking_id', 'shopee_app_id', 'shopee_app_secret', 'shopee_afiliado_id'];
const REDES_KEYS = ['telegram_bot_token', 'telegram_chat_id', 'facebook_page_id', 'facebook_page_token', 'instagram_business_id',
  'x_api_key', 'x_api_secret', 'x_access_token', 'x_access_secret',
  'whatsapp_groups', 'whatsapp_intervalo_s', 'wa_grupo_controle'];
const AGENDA_KEYS = ['agenda_ativa', 'agenda_horarios', 'agenda_qtd', 'agenda_redes', 'agenda_completar', 'agenda_modo', 'agenda_inicio',
  'agenda_fim', 'agenda_intervalo_min', 'agenda_intervalo_max', 'agenda_por_vez', 'agenda_lojas', 'agenda_palavras_bloqueadas',
  'agenda_palavras_permitidas', 'post_modelo', 'agenda_cupons_ativa', 'agenda_cupons_horarios', 'agenda_cupons_redes', 'agenda_relampago'];
const GRUPO_KEYS = ['grupo_slug', 'grupo_titulo', 'grupo_texto', 'grupo_pixel_meta', 'grupos_convite']; // página /g/<endereço>
const REPOST_KEYS = ['repost_ativo', 'repost_origens', 'repost_destinos', 'repost_por_tipo', 'repost_por_hora', 'repost_intervalo_min',
  'repost_desconto_min', 'repost_lojas', 'repost_inicio', 'repost_fim']; // repostar de outros grupos (src/repostar-grupos.js)
const CLIENT_KEYS = [...AFILIADO_KEYS, ...REDES_KEYS, ...AGENDA_KEYS, ...GRUPO_KEYS, ...REPOST_KEYS];
const SECRET_KEYS = ['aliexpress_app_secret', 'shopee_app_secret', 'telegram_bot_token', 'facebook_page_token', 'x_api_secret',
  'x_access_token', 'x_access_secret'];
// Padrões próprios do cliente
const CLIENT_DEFAULTS = { agenda_ativa: '0' };

const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const addDays = (base, dias) => new Date(Math.max(Date.now(), new Date(String(base).replace(' ', 'T') + 'Z').getTime() || 0) + dias * 86400000)
  .toISOString().replace('T', ' ').slice(0, 19);

// ── Cadastro (feito pelo admin) ──────────────────────────────────────────────
function validar(b, { novo }) {
  const nome = String(b.nome || '').trim().replace(/\s+/g, ' ');
  const email = String(b.email || '').trim().toLowerCase();
  if (nome.length < 2 || nome.length > 80) throw fail('Informe o nome do cliente.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) throw fail('Informe um e-mail válido.');
  const senha = String(b.senha || '');
  if (novo || senha) require('./senha').validar(senha, { email, nome }); // padrão de senha forte
  return { nome, email, senha };
}

function criar(b) {
  const { nome, email, senha } = validar(b, { novo: true });
  const dias = Math.min(Math.max(parseInt(b.dias, 10) || 30, 1), 3650);
  if (db.get('SELECT 1 FROM clientes WHERE email = ?', email)) throw fail('Já existe um cliente com esse e-mail.', 409);
  const r = db.run('INSERT INTO clientes (nome, email, senha_hash, validade, observacoes) VALUES (?, ?, ?, ?, ?)',
    nome, email, auth.hashPassword(senha), addDays(nowSql(), dias), String(b.observacoes || '').slice(0, 500) || null);
  return Number(r.lastInsertRowid);
}

function editar(id, b) {
  const c = getById(id);
  if (!c) throw fail('Cliente não encontrado.', 404);
  const { nome, email, senha } = validar({ ...c, ...b }, { novo: false });
  if (email !== c.email && db.get('SELECT 1 FROM clientes WHERE email = ? AND id <> ?', email, id)) throw fail('Já existe um cliente com esse e-mail.', 409);
  db.run('UPDATE clientes SET nome = ?, email = ?, observacoes = ? WHERE id = ?', nome, email, String(b.observacoes ?? c.observacoes ?? '').slice(0, 500) || null, id);
  if (senha) { db.run('UPDATE clientes SET senha_hash = ? WHERE id = ?', auth.hashPassword(senha), id); encerrarSessoes(id); }
}

// Renova somando dias a partir da validade atual (ou de hoje, se já venceu).
function renovar(id, dias) {
  const c = getById(id);
  if (!c) throw fail('Cliente não encontrado.', 404);
  const d = Math.min(Math.max(parseInt(dias, 10) || 30, 1), 3650);
  db.run('UPDATE clientes SET validade = ? WHERE id = ?', addDays(c.validade, d), id);
}

function definirStatus(id, status) {
  if (!['ativo', 'bloqueado'].includes(status)) throw fail('Situação inválida.');
  if (!db.run('UPDATE clientes SET status = ? WHERE id = ?', status, id).changes) throw fail('Cliente não encontrado.', 404);
  if (status === 'bloqueado') encerrarSessoes(id);
}

function excluir(id) {
  require('./perfis').excluir(`c:${id}`);
  require('./whatsapp-proprio').esquecer(`c:${id}`).catch(err => console.error('[CLIENTES] WhatsApp:', err.message));
  db.run('DELETE FROM post_queue WHERE cliente_id = ?', id);
  db.run('DELETE FROM clientes WHERE id = ?', id);
}

const getById = id => db.get('SELECT * FROM clientes WHERE id = ?', id);
const vencido = c => c.validade < nowSql();

function listar() {
  const { aceiteAfiliado } = require('./consentimento');
  return db.all(
    `SELECT c.id, c.nome, c.email, c.status, c.validade, c.observacoes, c.created_at, c.last_login_at,
       (c.validade < datetime('now')) AS vencido,
       (SELECT COUNT(*) FROM social_posts p WHERE p.cliente_id = c.id AND p.ok = 1) AS postagens
     FROM clientes c ORDER BY c.created_at DESC`).map(c => ({ ...c, aceite_termos: aceiteAfiliado({ dono: `c:${c.id}`, email: c.email }) }));
}

// ── Login do cliente ─────────────────────────────────────────────────────────
function motivoBloqueio(c) {
  if (c.status === 'bloqueado') return 'Seu acesso está bloqueado. Fale com o administrador.';
  if (vencido(c)) return 'Seu acesso venceu. Fale com o administrador para renovar.';
  return null;
}

function login(email, senha) {
  const c = db.get('SELECT * FROM clientes WHERE email = ?', String(email || '').trim().toLowerCase());
  if (!c || !auth.verifyPassword(String(senha || ''), c.senha_hash)) throw fail('E-mail ou senha incorretos.', 401);
  if (c.status !== 'bloqueado' && vencido(c)) {
    const data = new Date(msSql(c.validade)).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    throw Object.assign(fail(`Seu plano Afiliado Pro venceu em ${data}. Reative o plano para voltar a usar o painel.`, 402),
      { reativar: '/assinar?plano=pro&renovar=1' });
  }
  const motivo = motivoBloqueio(c);
  if (motivo) throw fail(motivo, 403);
  return c;
}

// O login do painel dura o prazo contratado (validade), renovando enquanto a pessoa usa.
const msSql = v => new Date(String(v).replace(' ', 'T') + 'Z').getTime();
const sqlMs = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const fimSessao = c => Math.max(Date.now(), Math.min(Date.now() + SESSION_DAYS * 86400000, msSql(c.validade)));

function criarSessao(req, res, c) {
  const token = crypto.randomBytes(32).toString('hex');
  const fim = fimSessao(c);
  db.run('INSERT INTO cliente_sessions (token_hash, cliente_id, expires_at) VALUES (?, ?, ?)', auth.tokenHash(token), c.id, sqlMs(fim));
  db.run(`UPDATE clientes SET last_login_at = datetime('now') WHERE id = ?`, c.id);
  res.append('Set-Cookie', `${COOKIE}=${token}; Max-Age=${Math.max(1, Math.floor((fim - Date.now()) / 1000))}; ${auth.cookieFlags(req)}`);
}

function renovarSessao(req, res) {
  const token = auth.parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return;
  const s = db.get(`SELECT s.expires_at, c.validade FROM cliente_sessions s JOIN clientes c ON c.id = s.cliente_id
                    WHERE s.token_hash = ? AND s.expires_at > datetime('now')`, auth.tokenHash(token));
  if (!s) return;
  const atual = msSql(s.expires_at);
  const fim = fimSessao(s);
  if (fim > atual + 86400000 || fim < atual - 60000) {
    db.run('UPDATE cliente_sessions SET expires_at = ? WHERE token_hash = ?', sqlMs(fim), auth.tokenHash(token));
    res.append('Set-Cookie', `${COOKIE}=${token}; Max-Age=${Math.max(1, Math.floor((fim - Date.now()) / 1000))}; ${auth.cookieFlags(req)}`);
  }
}

function encerrarSessao(req, res) {
  const token = auth.parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.run('DELETE FROM cliente_sessions WHERE token_hash = ?', auth.tokenHash(token));
  res.append('Set-Cookie', `${COOKIE}=; Max-Age=0; ${auth.cookieFlags(req)}`);
}
const encerrarSessoes = id => db.run('DELETE FROM cliente_sessions WHERE cliente_id = ?', id);

// Cliente logado, com acesso válido (ativo e dentro da validade); senão null.
function atual(req) {
  const token = auth.parseCookies(req.headers.cookie)[COOKIE];
  const c = token && db.get(
    `SELECT c.* FROM cliente_sessions s JOIN clientes c ON c.id = s.cliente_id
     WHERE s.token_hash = ? AND s.expires_at > datetime('now')`, auth.tokenHash(token));
  if (c) return motivoBloqueio(c) ? null : c;
  // Conta do site (e-mail/senha ou Google) ligada a um acesso da ferramenta: entra no painel com a mesma sessão.
  const u = require('./users').currentUser(req);
  if (!u || !u.cliente_id || u.status !== 'active') return null;
  const v = getById(u.cliente_id);
  return v && !motivoBloqueio(v) ? v : null;
}

// Liga (ou cria) o acesso da ferramenta de uma conta do site — cadastro gratuito de afiliado aprovado pelo admin.
function vincularUsuario(u, dias = null) {
  const ligado = u.cliente_id && getById(u.cliente_id);
  if (ligado) return ligado.id;
  let c = db.get('SELECT * FROM clientes WHERE email = ?', u.email);
  if (!c) {
    const pf = require('./planos').planoFerramenta();
    const d = dias || (pf ? pf.dias : 30);
    const senha = u.senha_hash || auth.hashPassword(crypto.randomBytes(24).toString('hex')); // só Google: entra pela conta do site
    const id = Number(db.run('INSERT INTO clientes (nome, email, senha_hash, validade, observacoes) VALUES (?, ?, ?, ?, ?)',
      u.nome || u.email.split('@')[0], u.email, senha, addDays(nowSql(), d), 'Cadastro gratuito de afiliado aprovado no painel').lastInsertRowid);
    c = getById(id);
  }
  db.run('UPDATE users SET cliente_id = ? WHERE id = ?', c.id, u.id);
  return c.id;
}

// Plano com a ferramenta comprado por uma conta do site: liga (ou cria) o acesso e define a validade.
// calcValidade recebe a validade atual do acesso (ou null) e devolve a nova.
function liberarPlano(u, planoId, calcValidade) {
  const antes = (u.cliente_id && getById(u.cliente_id)) || db.get('SELECT * FROM clientes WHERE email = ?', u.email);
  const cid = vincularUsuario(u);
  const validade = calcValidade(antes ? antes.validade : null);
  db.run(`UPDATE clientes SET validade = ?, status = 'ativo', plano = ? WHERE id = ?`, validade, planoId, cid);
  return { id: cid, validade };
}

function exigir(req, res, next) {
  const c = atual(req);
  if (!c) return res.status(401).json({ error: 'Entre no painel do cliente.' });
  req.cliente = c;
  next();
}

// ── Configurações do cliente ─────────────────────────────────────────────────
// Objeto no mesmo formato das configurações do site, mas só com dados do cliente (e o endereço público do site).
function config(id) {
  // Padrões do site (chaves e links de afiliado são vazios por padrão — nunca os valores salvos pelo admin).
  const out = {};
  for (const k of CLIENT_KEYS) out[k] = k in CLIENT_DEFAULTS ? CLIENT_DEFAULTS[k] : settings.DEFAULTS[k] ?? '';
  for (const r of db.all('SELECT key, value FROM cliente_config WHERE cliente_id = ?', id)) if (CLIENT_KEYS.includes(r.key)) out[r.key] = r.value;
  out.site_url = settings.get('site_url') || '';
  out.cliente_id = id;
  return out;
}

function configParaPainel(id) {
  const c = config(id);
  const out = {};
  for (const k of CLIENT_KEYS) {
    if (SECRET_KEYS.includes(k)) out[`${k}_set`] = Boolean(c[k]);
    else out[k] = c[k];
  }
  return out;
}

function salvarConfig(id, body) {
  const changed = [];
  for (const [k, raw] of Object.entries(body || {})) {
    if (!CLIENT_KEYS.includes(k)) continue;
    let v = typeof raw === 'string' ? raw.trim() : raw;
    if (['whatsapp_groups', 'agenda_redes'].includes(k) && typeof v === 'object') v = JSON.stringify(v);
    if (SECRET_KEYS.includes(k) && !v) continue; // vazio = mantém
    if (k === 'grupo_slug') {
      v = String(v || '').toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(v)) throw fail('Endereço da página: use de 3 a 40 letras, números ou hífens.');
      if (db.get(`SELECT 1 FROM cliente_config WHERE key = 'grupo_slug' AND value = ? AND cliente_id <> ?`, v, id)) throw fail('Esse endereço da página já está em uso. Escolha outro.');
    }
    db.run(`INSERT INTO cliente_config (cliente_id, key, value) VALUES (?, ?, ?)
            ON CONFLICT(cliente_id, key) DO UPDATE SET value = excluded.value`, id, k, v == null ? '' : String(v));
    changed.push(k);
  }
  // Mudou o programa de afiliados da AliExpress/Shopee: descarta os links já gerados.
  if (changed.some(k => /^(aliexpress|shopee)_/.test(k))) db.run('DELETE FROM cliente_links WHERE cliente_id = ?', id);
  return changed;
}

// ── Link de afiliado de uma oferta para o cliente ────────────────────────────
// Link usado nas postagens do cliente: passa pelo site (/ir/...) para contar os cliques nas conquistas dele.
// Só com o site num endereço público https; sem isso, vai direto para o link de afiliado.
async function linkParaPostar(cid, o, s) {
  const site = String(settings.get('site_url') || '').trim().replace(/\/+$/, '');
  if (/^https:\/\/[^\s/]+/i.test(site) && o && o.id) return `${site}/ir/${cid}-${o.id}`;
  return linkAfiliado(cid, o, s);
}

async function linkAfiliado(clienteId, o, s = config(clienteId)) {
  const store = getStore(o.store_id);
  if (!store || o.loja_id || o.fonte === 'empresa' || o.fonte === 'feed') return o.original_url;
  if ((o.store_id === 'aliexpress' || o.store_id === 'shopee') && typeof store.gerarLink === 'function') {
    const pronto = o.store_id === 'aliexpress'
      ? s.aliexpress_app_key && s.aliexpress_app_secret && s.aliexpress_tracking_id
      : s.shopee_app_id && s.shopee_app_secret;
    // Shopee sem a API: link com o ID de afiliado do cliente (se ele informou)
    if (!pronto) return o.store_id === 'shopee' ? store.affiliateLink(o, s) : o.original_url;
    const chave = o.store_id === 'aliexpress' ? `${s.aliexpress_app_key}|${s.aliexpress_tracking_id}` : s.shopee_app_id;
    const salvo = db.get('SELECT link, chave FROM cliente_links WHERE cliente_id = ? AND offer_id = ?', clienteId, o.id);
    if (salvo && salvo.chave === chave) return salvo.link;
    try {
      const link = await store.gerarLink(o.original_url, s);
      db.run(`INSERT INTO cliente_links (cliente_id, offer_id, chave, link) VALUES (?, ?, ?, ?)
              ON CONFLICT(cliente_id, offer_id) DO UPDATE SET chave = excluded.chave, link = excluded.link, created_at = datetime('now')`,
        clienteId, o.id, chave, link);
      return link;
    } catch {
      return o.original_url;
    }
  }
  try { return store.affiliateLink(o, s) || o.original_url; } catch { return o.original_url; }
}

// Lojas sem link de afiliado configurado pelo cliente (para avisar no painel).
function lojasSemAfiliado(s) {
  const faltam = [];
  if (!s.amazon_tag) faltam.push('Amazon');
  if (!s.ml_matt_word || !s.ml_matt_tool) faltam.push('Mercado Livre');
  if (!s.kabum_afiliado) faltam.push('KaBuM!');
  if (!(s.aliexpress_app_key && s.aliexpress_app_secret && s.aliexpress_tracking_id)) faltam.push('AliExpress');
  if (!(s.shopee_app_id && s.shopee_app_secret) && !s.shopee_afiliado_id) faltam.push('Shopee');
  if (!s.magalu_store) faltam.push('Magalu');
  return faltam;
}
// Lojas em que a pessoa ganha comissão: é delas que o agendamento e as sugestões escolhem
const LOJA_ID = { Amazon: 'amazon', 'Mercado Livre': 'mercadolivre', 'KaBuM!': 'kabum', AliExpress: 'aliexpress', Shopee: 'shopee', Magalu: 'magalu' };
function lojasComAfiliado(s) {
  const faltam = lojasSemAfiliado(s);
  return Object.entries(LOJA_ID).filter(([nome]) => !faltam.includes(nome)).map(([, id]) => id);
}

function publico(c) {
  let plano = null;
  try { plano = c.plano ? require('./planos').plano(c.plano)?.nome || null : null; } catch { /* sem planos */ }
  return { id: c.id, nome: c.nome, email: c.email, validade: c.validade, status: c.status, plano };
}

module.exports = {
  lojasComAfiliado,
  liberarPlano,
  linkParaPostar,
  renovarSessao,
  vincularUsuario,
  CLIENT_KEYS, SECRET_KEYS, criar, editar, renovar, definirStatus, excluir, listar, getById, login, criarSessao,
  encerrarSessao, atual, exigir, config, configParaPainel, salvarConfig, linkAfiliado, lojasSemAfiliado, publico, motivoBloqueio,
};
