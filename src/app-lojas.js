// Assinaturas compradas dentro do app (Google Play e App Store), validadas pelo RevenueCat.
// O app compra com o id da conta do site (ofertou-u-<id>); o site consulta o RevenueCat (nunca confia só no aparelho)
// e libera o plano até a data de expiração informada pela loja. Renovações e cancelamentos chegam pelo webhook.
const crypto = require('crypto');
const axios = require('axios');
const db = require('./db');
const settings = require('./settings');
const users = require('./users');
const clientes = require('./clientes');
const planos = require('./planos');

const RC = 'https://api.revenuecat.com/v1';
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const sqlDe = d => new Date(d).toISOString().replace('T', ' ').slice(0, 19);
// (uma validade "sem vencimento" vinda do plano grátis não conta: o plano pago passa a valer até a data da loja)
const maior = (a, b) => { if (a === planos.SEM_VENCIMENTO) a = null; if (b === planos.SEM_VENCIMENTO) b = null; return !a ? b : !b ? a : a > b ? a : b; };

const appUserId = userId => `ofertou-u-${userId}`;
const userIdDe = appUser => { const m = /^ofertou-u-(\d+)$/.exec(String(appUser || '')); return m ? Number(m[1]) : null; };

// Dados que o app precisa (chaves públicas do SDK e os ids dos produtos de cada plano nas lojas).
function config(s = settings.getAll()) {
  const ativo = s.app_ativo === '1';
  return {
    ativo,
    chaves: ativo ? { android: s.rc_chave_android || '', ios: s.rc_chave_ios || '' } : {},
    produtos: Object.fromEntries(planos.listar().filter(p => !p.gratis).map(p => [p.id, p.produto_app || ''])),
    // Só os planos pagos são vendidos pela loja; os grátis são ativados pelo site (/assinar)
    planos: planos.listar().filter(p => !p.gratis).map(p => ({ id: p.id, nome: p.nome, chamada: p.chamada, beneficios: p.beneficios, dias: p.dias })),
  };
}

// Qual plano um produto/entitlement da loja representa.
function planoDoProduto(produto, entitlement, s) {
  // O entitlement do RevenueCat tem o mesmo id do plano; senão, procura pelo ID do produto na loja
  if (entitlement && planos.plano(entitlement)) return entitlement;
  const p = String(produto || '');
  const achado = planos.todos().find(pl => pl.produto_app && (p === pl.produto_app || p.startsWith(`${pl.produto_app}:`)));
  return achado ? achado.id : null;
}

// Libera (ou estende) o plano da conta até a data de expiração da loja. Nunca encurta um prazo maior já existente.
function liberar(u, plano, expiraSql, origem) {
  const p = planos.plano(plano);
  if (!p) return null;
  // E-mail com acesso de afiliado que não é desta conta: não liga sem prova (o admin junta as contas, se for o caso)
  const outroAcesso = (p.conta === 'cliente' || p.ferramenta) && clientes.acessoComMesmoEmail(u);
  if (outroAcesso && !clientes.ligacaoPermitida(u, outroAcesso)) {
    users.logAction(u, 'assinatura_app_conflito', `${p.nome}: o e-mail já tem outro acesso de afiliado (${origem})`);
    return null;
  }
  if (p.conta === 'cliente') {
    const antes = u.cliente_id && clientes.getById(u.cliente_id);
    const cid = clientes.vincularUsuario(u);
    const validade = maior(antes ? antes.validade : null, expiraSql);
    db.run(`UPDATE clientes SET validade = ?, status = 'ativo', plano = ? WHERE id = ?`, validade, p.id, cid);
    const atual = users.getById(u.id);
    if (!atual.tipo || atual.tipo === 'afiliado') {
      db.run(`UPDATE users SET tipo = 'afiliado', plano = ?, assinatura_ate = ?,
              status = CASE WHEN status IN ('pending', 'onboarding') THEN 'active' ELSE status END WHERE id = ?`,
      p.id, maior(atual.assinatura_ate, validade), u.id);
    }
    users.logAction(atual, 'assinatura_app', `${p.nome} até ${validade.slice(0, 10)} (${origem})`);
    return { plano, validade, conta: 'cliente' };
  }
  const perfil = p.perfis.includes(u.tipo) ? u.tipo : p.perfil;
  if (u.tipo && u.tipo !== 'afiliado' && !p.perfis.includes(u.tipo)) {
    users.logAction(u, 'assinatura_app_conflito', `${p.nome} comprado numa conta de ${u.tipo} (${origem})`);
    return null;
  }
  const validade = maior(u.assinatura_ate, expiraSql);
  db.run(`UPDATE users SET plano = ?, assinatura_ate = ?, tipo = CASE WHEN tipo IS NULL OR tipo = 'afiliado' THEN ? ELSE tipo END,
          status = CASE WHEN status IN ('pending', 'onboarding') THEN 'active' ELSE status END WHERE id = ?`,
  p.id, validade, perfil, u.id);
  if (p.ferramenta) clientes.liberarPlano(users.getById(u.id), p.id, atual => maior(atual, expiraSql));
  users.logAction(users.getById(u.id), 'assinatura_app', `${p.nome} até ${validade.slice(0, 10)} (${origem})`);
  return { plano, validade, conta: 'usuario' };
}

// Consulta o RevenueCat e libera o que estiver ativo para a conta.
async function sincronizar(userId, origem = 'app') {
  const s = settings.getAll();
  if (!s.rc_chave_secreta) throw fail('As compras pelo app ainda não foram configuradas no painel.', 503);
  const u = users.getById(userId);
  if (!u) throw fail('Conta não encontrada.', 404);
  const r = await axios.get(`${RC}/subscribers/${encodeURIComponent(appUserId(userId))}`, {
    headers: { Authorization: `Bearer ${s.rc_chave_secreta}` }, timeout: 15000, validateStatus: () => true,
  });
  if (r.status === 401) throw fail('O RevenueCat recusou a chave secreta (confira no painel).', 502);
  if (r.status >= 400) throw fail(`RevenueCat: HTTP ${r.status}`, 502);
  const ents = r.data?.subscriber?.entitlements || {};
  const liberados = [];
  for (const [ent, e] of Object.entries(ents)) {
    const expira = e.expires_date ? new Date(e.expires_date) : null;
    if (!expira || expira <= new Date()) continue; // vencido (assinaturas sempre têm data de expiração)
    const plano = planoDoProduto(e.product_identifier, ent, s);
    if (!plano) continue;
    // Compra de teste (TestFlight, testador de licença do Google Play) não libera plano de verdade
    const assinatura = r.data?.subscriber?.subscriptions?.[e.product_identifier];
    if (assinatura?.is_sandbox) { users.logAction(u, 'assinatura_app_teste', `${plano}: compra de teste ignorada (${origem})`); continue; }
    const ok = liberar(users.getById(userId), plano, sqlDe(expira), origem);
    if (ok) liberados.push(ok);
  }
  return liberados;
}

// Aviso do RevenueCat (compra, renovação, cancelamento…): confere a autorização e sincroniza pela API.
async function webhook(headers, body) {
  const s = settings.getAll();
  const esperado = String(s.rc_webhook_auth || '');
  const recebido = String(headers.authorization || '');
  const a = Buffer.from(recebido), b = Buffer.from(esperado);
  if (!esperado || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw fail('Não autorizado.', 401);
  const ev = body?.event || {};
  const ids = [ev.app_user_id, ev.original_app_user_id, ...(ev.aliases || [])];
  const userId = ids.map(userIdDe).find(Boolean);
  if (!userId || !users.getById(userId)) return { ignorado: true };
  const liberados = await sincronizar(userId, `webhook ${ev.type || ''}`.trim());
  // Registro da venda para o painel (uma vez por evento).
  if (['INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE'].includes(ev.type) && ev.id && ev.environment !== 'SANDBOX') {
    const plano = planoDoProduto(ev.product_id, (ev.entitlement_ids || [])[0], s);
    const u = users.getById(userId);
    if (plano && !db.get('SELECT 1 FROM pagamentos WHERE token = ?', `rc-${ev.id}`)) {
      const p = planos.plano(plano);
      db.run(`INSERT INTO pagamentos (token, plano, valor, dias, metodo, status, email, nome, dados, conta_tipo, conta_id,
              validade_ate, aprovado_em, login_entregue, email_enviado, observacao)
              VALUES (?, ?, ?, ?, ?, 'aprovado', ?, ?, '{}', ?, ?, ?, datetime('now'), 1, 1, ?)`,
      `rc-${ev.id}`, plano, Number(ev.price_in_purchased_currency ?? ev.price ?? 0) || 0, p.dias,
      ev.store === 'APP_STORE' ? 'app_store' : 'play_store', u.email, u.nome || null,
      p.conta === 'cliente' ? 'cliente' : 'usuario', p.conta === 'cliente' ? u.cliente_id : u.id,
      ev.expiration_at_ms ? sqlDe(Number(ev.expiration_at_ms)) : null,
      `${ev.type === 'RENEWAL' ? 'renovação' : 'compra'} pelo app (${ev.store || 'loja'})`);
    }
  }
  return { liberados };
}

module.exports = { config, sincronizar, webhook, appUserId, nowSql };
