// Lojas de empresas dentro do site: dados da loja, produtos cadastrados à mão e importação pelo link.
const db = require('./db');
const offers = require('./offers');
const { fetchStoreFeed } = require('./feeds');
const { assertPublicUrl } = require('./net');

const FEED_VALIDITY_HOURS = 72;   // produto importado sai do ar se sumir do feed por 3 dias

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'loja';
}

function uniqueSlug(base, ignoreId = null) {
  let slug = base, n = 1;
  while (db.get('SELECT id FROM lojas WHERE slug = ? AND id IS NOT ?', slug, ignoreId)) slug = `${base}-${++n}`;
  return slug;
}

const getByUser = userId => db.get('SELECT * FROM lojas WHERE user_id = ?', userId) || null;
// A loja como o dono vê no navegador: sem os tokens de acesso do Mercado Pago (ficam só no servidor)
const SEGREDOS_LOJA = ['mp_access_token', 'mp_refresh_token'];
function paraODono(loja) {
  if (!loja) return loja;
  const out = { ...loja };
  for (const k of SEGREDOS_LOJA) delete out[k];
  out.mp_conectado = Boolean(loja.mp_access_token);
  return out;
}

// "Loja" no formato que o gravador de ofertas espera.
const pseudoStore = loja => ({ id: `loja:${loja.id}`, name: loja.nome, affiliateLink: o => o.original_url });

function httpsUrlOrNull(raw, campo) {
  const v = String(raw || '').trim();
  if (!v) return null;
  if (!/^https:\/\//i.test(v) || v.length > 500) throw fail(`${campo}: use um link começando com https://`);
  assertPublicUrl(v);
  return v;
}

function assertCanPublish(user) {
  if (user.tipo !== 'empresa') throw fail('Somente contas de empresa podem ter loja.', 403);
  if (user.bloqueio_publicacao) throw fail('Sua conta está impedida de publicar pelo administrador.', 403);
}

function saveLoja(user, body) {
  if (user.tipo !== 'empresa') throw fail('Somente contas de empresa podem ter loja.', 403);
  const nome = String(body.nome || '').trim().replace(/\s+/g, ' ');
  if (nome.length < 2 || nome.length > 60) throw fail('Informe o nome da loja (2 a 60 caracteres).');
  const descricao = String(body.descricao || '').trim().slice(0, 500) || null;
  const existente = getByUser(user.id);
  const logoBruto = String(body.logo_url ?? existente?.logo_url ?? '').trim();
  const logo = /^\/uploads\/([a-f0-9]{32}\.(jpg|png|webp)|perfis\/[\w.-]+\.webp)$/.test(logoBruto) ? logoBruto : httpsUrlOrNull(logoBruto, 'Logo');
  const site = httpsUrlOrNull(body.site_url, 'Site');
  const existing = existente;
  if (existing) {
    db.run('UPDATE lojas SET nome = ?, descricao = ?, logo_url = ?, site_url = ? WHERE id = ?',
      nome, descricao, logo, site, existing.id);
    if ((logo || null) !== (existing.logo_url || null)) require('./foto-loja').daLoja(user.id, logo); // a foto do perfil acompanha
    db.run('UPDATE offers SET plataforma = ? WHERE loja_id = ?', nome, existing.id);
    return getByUser(user.id);
  }
  // Loja nova: sem logo, usa a foto do perfil; com logo, ele vira a foto do perfil
  const fotoPerfil = db.get('SELECT avatar FROM perfis WHERE dono = ?', `u:${user.id}`)?.avatar;
  const logoFinal = logo || require('./foto-loja').valida(fotoPerfil);
  db.run('INSERT INTO lojas (user_id, nome, slug, descricao, logo_url, site_url) VALUES (?, ?, ?, ?, ?, ?)',
    user.id, nome, uniqueSlug(slugify(nome)), descricao, logoFinal, site);
  if (logo) require('./foto-loja').daLoja(user.id, logo);
  return getByUser(user.id);
}

function listProducts(lojaId) {
  return db.all(
    `SELECT id, produto, preco_atual, preco_anterior, desconto_pct, categoria, imagem, original_url, fonte, oculto,
            link_clicks, created_at, expires_at, (expires_at > datetime('now')) AS no_prazo
     FROM offers WHERE loja_id = ? ORDER BY created_at DESC`, lojaId
  );
}


function deleteProduct(user, offerId) {
  const loja = getByUser(user.id);
  if (!loja) throw fail('Loja não encontrada.', 404);
  const n = db.run('DELETE FROM offers WHERE id = ? AND loja_id = ?', offerId, loja.id).changes;
  if (!n) throw fail('Produto não encontrado.', 404);
}

function setFeed(user, rawUrl) {
  assertCanPublish(user);
  const loja = getByUser(user.id);
  if (!loja) throw fail('Crie sua loja antes de configurar a importação.');
  const url = httpsUrlOrNull(rawUrl, 'Link da loja');
  db.run(`UPDATE lojas SET feed_url = ?, feed_tipo = NULL, feed_status = ?, feed_mensagem = NULL WHERE id = ?`,
    url, url ? 'pendente' : null, loja.id);
  return getByUser(user.id);
}

// Importa os produtos com desconto do link configurado.
async function syncFeed(lojaId) {
  const loja = db.get(
    `SELECT l.*, u.bloqueio_publicacao, u.status FROM lojas l JOIN users u ON u.id = l.user_id WHERE l.id = ?`, lojaId
  );
  if (!loja || !loja.feed_url) return { saved: 0 };
  if (loja.bloqueio_publicacao || loja.status === 'banned') return { saved: 0, skipped: true };

  const finish = (status, msg, tipo = loja.feed_tipo) =>
    db.run(`UPDATE lojas SET feed_status = ?, feed_mensagem = ?, feed_tipo = ?, feed_ultima_sync = datetime('now') WHERE id = ?`,
      status, msg, tipo, loja.id);
  try {
    const { tipo, items } = await fetchStoreFeed(loja.feed_url);
    const max = require('./planos').maxProdutos(loja.user_id);
    const manual = db.get(`SELECT COUNT(*) AS n FROM offers WHERE loja_id = ? AND fonte = 'empresa'`, loja.id).n;
    const expires = new Date(Date.now() + FEED_VALIDITY_HOURS * 3600000).toISOString().replace('T', ' ').slice(0, 19);
    const store = pseudoStore(loja);
    let saved = 0;
    for (const it of items.slice(0, Math.max(0, max - manual))) {
      let imagem = null;
      try { imagem = it.imagem ? httpsUrlOrNull(it.imagem.replace(/^\/\//, 'https://'), 'Imagem') : null; } catch { imagem = null; }
      const id = offers.saveDeal(store, {
        store_product_id: `f:${String(it.id).slice(0, 80)}`,
        produto: it.titulo.slice(0, 200),
        preco_atual: it.preco,
        preco_anterior: it.preco_anterior,
        imagem,
        original_url: it.url,
        affiliate_url: it.url,
      }, { fonte: 'feed', expiresAt: expires, lojaId: loja.id });
      if (id) saved++;
    }
    finish('ok', `${saved} produto(s) com desconto importado(s) de ${items.length} encontrado(s).`, tipo);
    return { saved, found: items.length, tipo };
  } catch (err) {
    finish('erro', err.message.slice(0, 300));
    return { saved: 0, error: err.message };
  }
}

async function syncAllFeeds() {
  const lojas = db.all(`SELECT id FROM lojas WHERE feed_url IS NOT NULL AND oculta = 0`);
  let total = 0;
  for (const { id } of lojas) total += (await syncFeed(id)).saved || 0;
  if (lojas.length) console.log(`[LOJAS] ${lojas.length} feed(s) sincronizado(s), ${total} produto(s) atualizados.`);
  return total;
}

// Página pública da loja (só se estiver visível e com o dono liberado).
function publicStore(slug) {
  const loja = db.get(
    `SELECT l.id, l.nome, l.slug, l.descricao, l.logo_url, l.site_url, l.created_at
     FROM lojas l JOIN users u ON u.id = l.user_id
     WHERE l.slug = ? AND l.oculta = 0
       AND (u.status = 'active' OR (u.status = 'suspended' AND u.suspenso_ate <= datetime('now')))`, slug
  );
  if (!loja) return null;
  return { loja, ofertas: offers.listActive(1000, loja.id) };
}

// Exclui a loja: página, produtos/anúncios, catálogos e avaliações. A conta continua (pode criar outra loja depois);
// pedidos e conversas ficam guardados como histórico. Não deixa excluir com pedido em andamento.
function excluirLoja(lojaId) {
  const loja = db.get('SELECT * FROM lojas WHERE id = ?', lojaId);
  if (!loja) throw fail('Loja não encontrada.', 404);
  const andamento = db.get(`SELECT COUNT(*) AS n FROM pedidos_loja WHERE loja_id = ?
    AND status IN ('aguardando_pagamento', 'pagamento_informado', 'pago', 'enviado')`, lojaId).n;
  if (andamento) throw fail(`A loja tem ${andamento} pedido(s) em andamento. Conclua ou cancele os pedidos antes de excluir a loja.`, 409);
  const produtos = db.run('DELETE FROM offers WHERE loja_id = ?', lojaId).changes;
  db.run('DELETE FROM loja_metricas WHERE loja_id = ?', lojaId);
  db.run('DELETE FROM lojas WHERE id = ?', lojaId); // catálogos e avaliações saem junto (ON DELETE CASCADE)
  return { loja: loja.nome, produtos };
}

function setHidden(lojaId, oculta) {
  db.run('UPDATE lojas SET oculta = ? WHERE id = ?', oculta ? 1 : 0, lojaId);
}

module.exports = {
  getByUser, paraODono, pseudoStore, assertCanPublishUser: assertCanPublish, saveLoja, listProducts, deleteProduct, setFeed, syncFeed, syncAllFeeds, publicStore, setHidden, excluirLoja,
};
