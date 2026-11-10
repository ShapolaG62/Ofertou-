const db = require('./db');
const settings = require('./settings');
require('./relampago'); // cria as colunas das ofertas relâmpago
const palavrasProibidas = require('./palavras-proibidas');
const { getStore } = require('./stores');
const { classifyCategory, classifySubcategory } = require('./categorize');
const { discountOf, round2 } = require('./util');

const MAX_DISCOUNT = 99; // acima disso é erro de leitura de preço; entre 85% e 99% a oferta entra, marcada como suspeita

// Oferta "no ar": não oculta, dentro da validade e, se for de uma loja parceira, com a loja visível
// e o dono com a conta liberada (banido/suspenso some do site imediatamente).
function activeClause() {
  const hours = settings.getNumber('offer_max_age_hours', 24);
  return {
    sql: `o.oculto = 0 AND (
      (o.fonte = 'auto' AND o.last_seen_at >= datetime('now', ?)) OR
      (o.fonte <> 'auto' AND o.expires_at > datetime('now'))
    ) AND (o.loja_id IS NULL OR EXISTS (
      SELECT 1 FROM lojas lj JOIN users uj ON uj.id = lj.user_id
      WHERE lj.id = o.loja_id AND lj.oculta = 0
        AND (uj.status = 'active' OR (uj.status = 'suspended' AND uj.suspenso_ate <= datetime('now')))
    ))`,
    params: [`-${hours} hours`],
  };
}

function affiliateFor(store, offer, s) {
  try { return store.affiliateLink(offer, s) || offer.original_url; } catch { return offer.original_url; }
}

// Valida e grava uma oferta encontrada numa loja. Retorna o id ou null se foi rejeitada.
function saveDeal(store, deal, opts = {}) {
  const s = opts.settings || settings.getAll();
  const fonte = opts.fonte || 'auto';
  const minDiscount = fonte === 'manual' || fonte === 'empresa' ? 1 : Number(s.min_discount_pct) || 5;

  const produto = String(deal.produto || '').replace(/\s+/g, ' ').trim();
  const atual = round2(Number(deal.preco_atual));
  const anterior = round2(Number(deal.preco_anterior));
  const desconto = discountOf(atual, anterior);
  if (!produto || !deal.store_product_id || !deal.original_url) return null;
  if (!(atual > 0) || desconto < minDiscount || desconto > MAX_DISCOUNT) return null;
  // ignorarProibidas: a repostagem de ofertas dos grupos de origem grava mesmo com palavra proibida (escolha do dono)
  if (fonte === 'auto' && !opts.ignorarProibidas && palavrasProibidas.bloqueia(produto)) return null;

  const offer = { ...deal, produto, preco_atual: atual, preco_anterior: anterior };
  const affFixed = deal.affiliate_url ? 1 : 0;
  const affiliate = deal.affiliate_url || affiliateFor(store, offer, s);
  const categoria = deal.categoria || classifyCategory(produto, opts.catHint);
  const expiresAt = fonte === 'auto' ? null : opts.expiresAt;
  const lojaId = opts.lojaId || null;
  // Comissão (%) só quando a API da loja informa; sem ela, fica a última conhecida
  const pct = v => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
  const comissao = pct(deal.comissao_pct), comissaoExtra = pct(deal.comissao_extra_pct);
  // Cupom: vale o que veio nesta leitura (sem cupom agora, ele sai: o preço novo não é mais o preço com cupom)
  const cupom = deal.cupom_codigo ? [String(deal.cupom_codigo), deal.cupom_texto || null, round2(Number(deal.preco_sem_cupom)) || null] : [null, null, null];

  return db.transaction(() => {
    const existing = db.get(
      'SELECT id, preco_atual, categoria, created_at, relampago_fim, cupom_codigo FROM offers WHERE store_id = ? AND store_product_id = ?',
      store.id, String(deal.store_product_id)
    );
    if (existing) {
      db.run(
        `UPDATE offers SET produto = ?, preco_atual = ?, preco_anterior = ?, desconto_pct = ?, imagem = COALESCE(?, imagem),
           original_url = ?, affiliate_url = ?, aff_fixed = ?, fonte = ?, expires_at = ?, subcategoria = ?,
           comissao_pct = COALESCE(?, comissao_pct), comissao_extra_pct = COALESCE(?, comissao_extra_pct),
           updated_at = datetime('now'), last_seen_at = datetime('now')
         WHERE id = ?`,
        produto, atual, anterior, desconto, deal.imagem || null, deal.original_url, affiliate, affFixed,
        fonte, expiresAt, classifySubcategory(produto, existing.categoria), comissao, comissaoExtra, existing.id
      );
      // manterCupom: leitura que não vê cupom (ofertas do Mercado Livre) não apaga o cupom de um produto com o mesmo preço
      if (!(opts.manterCupom && !deal.cupom_codigo && existing.cupom_codigo && atual <= Number(existing.preco_atual) * 1.01)) {
        db.run('UPDATE offers SET cupom_codigo = ?, cupom_texto = ?, preco_sem_cupom = ? WHERE id = ?', ...cupom, existing.id);
      }
      require('./relampago').aoGravar({ id: existing.id, antes: existing, deal, atual, desconto, fonte });
      if (Number(existing.preco_atual) !== atual) {
        db.run('INSERT INTO price_history (offer_id, price) VALUES (?, ?)', existing.id, atual);
      }
      return existing.id;
    }
    const res = db.run(
      `INSERT INTO offers (store_id, store_product_id, plataforma, produto, preco_atual, preco_anterior, desconto_pct,
         categoria, subcategoria, imagem, original_url, affiliate_url, aff_fixed, fonte, expires_at, loja_id, comissao_pct, comissao_extra_pct,
         cupom_codigo, cupom_texto, preco_sem_cupom)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      store.id, String(deal.store_product_id), store.name, produto, atual, anterior, desconto,
      categoria, classifySubcategory(produto, categoria), deal.imagem || null, deal.original_url, affiliate, affFixed, fonte,
      expiresAt, lojaId, comissao, comissaoExtra, ...cupom
    );
    const id = Number(res.lastInsertRowid);
    require('./relampago').aoGravar({ id, deal, atual, desconto, fonte });
    db.run('INSERT INTO price_history (offer_id, price) VALUES (?, ?)', id, atual);
    return id;
  });
}

const PUBLIC_FIELDS = `o.id, o.store_id, o.plataforma, o.produto, o.preco_atual, o.preco_anterior, o.desconto_pct,
  o.categoria, o.subcategoria, o.imagem, o.affiliate_url, o.link_clicks, o.fonte, o.created_at, o.last_seen_at`;

// lojaId: limita às ofertas de uma loja parceira (página da loja).
function listActive(limit = 2000, lojaId = null) {
  const active = activeClause();
  return db.all(
    `SELECT ${PUBLIC_FIELDS}, o.comissao_pct, o.comissao_extra_pct, l.slug AS loja_slug, l.nome AS loja_nome,
       CASE WHEN h.n >= 2 AND o.created_at <= datetime('now', '-7 days') AND o.preco_atual <= h.min30
            THEN 1 ELSE 0 END AS menor_preco_30d
     FROM offers o
     LEFT JOIN lojas l ON l.id = o.loja_id
     LEFT JOIN (
       SELECT offer_id, MIN(price) AS min30, COUNT(*) AS n FROM price_history
       WHERE checked_at >= datetime('now', '-30 days') GROUP BY offer_id
     ) h ON h.offer_id = o.id
     WHERE ${active.sql} ${lojaId ? 'AND o.loja_id = ?' : ''}
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT ?`,
    ...active.params, ...(lojaId ? [lojaId] : []), limit
  );
}

function stats() {
  const active = activeClause();
  const row = db.get(
    `SELECT COUNT(*) AS offer_count,
       SUM(CASE WHEN o.created_at >= datetime('now', 'start of day') THEN 1 ELSE 0 END) AS offers_today,
       SUM(CASE WHEN o.desconto_pct >= 55 THEN 1 ELSE 0 END) AS diamonds,
       COUNT(DISTINCT o.store_id) AS stores
     FROM offers o WHERE ${active.sql}`,
    ...active.params
  );
  return {
    offer_count: row.offer_count || 0,
    offers_today: row.offers_today || 0,
    diamonds: row.diamonds || 0,
    stores: row.stores || 0,
  };
}

function isActive(id) {
  const active = activeClause();
  return Boolean(db.get(`SELECT 1 FROM offers o WHERE o.id = ? AND ${active.sql}`, id, ...active.params));
}

// Lista para o painel, com filtro por situação.
function listForAdmin({ q = '', store = '', state = 'active', page = 1, perPage = 50 }) {
  const active = activeClause();
  const where = [];
  const params = [];
  if (state === 'active') { where.push(active.sql); params.push(...active.params); }
  else if (state === 'expired') { where.push(`o.oculto = 0 AND NOT (${active.sql})`); params.push(...active.params); }
  else if (state === 'hidden') where.push('o.oculto = 1');
  if (store) { where.push('o.store_id = ?'); params.push(store); }
  if (q) { where.push('o.produto LIKE ?'); params.push(`%${q}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.get(`SELECT COUNT(*) AS n FROM offers o ${whereSql}`, ...params).n;
  const rows = db.all(
    `SELECT o.*, (${active.sql}) AS ativo FROM offers o ${whereSql}
     ORDER BY o.last_seen_at DESC LIMIT ? OFFSET ?`,
    ...active.params, ...params, perPage, (page - 1) * perPage
  );
  return { total, page, perPage, rows };
}

// Recalcula os links de afiliado depois que o admin altera as tags.
function refreshAffiliateLinks() {
  const s = settings.getAll();
  const rows = db.all('SELECT id, store_id, store_product_id, original_url FROM offers WHERE aff_fixed = 0');
  let count = 0;
  db.transaction(() => {
    for (const row of rows) {
      const store = getStore(row.store_id);
      if (!store) continue;
      db.run('UPDATE offers SET affiliate_url = ? WHERE id = ?', affiliateFor(store, row, s), row.id);
      count++;
    }
  });
  return count;
}

// Remove do banco ofertas automáticas que não aparecem há mais de 30 dias.
function purgeOld() {
  return db.run(`DELETE FROM offers WHERE fonte = 'auto' AND last_seen_at < datetime('now', '-30 days')`).changes;
}

// Recalcula o tipo de produto de uma oferta (após mudar a categoria).
function reclassifyOne(id) {
  const r = db.get('SELECT produto, categoria FROM offers WHERE id = ?', id);
  if (r) db.run('UPDATE offers SET subcategoria = ? WHERE id = ?', classifySubcategory(r.produto, r.categoria), id);
}

// Reaplica as regras de categoria e tipo de produto (rodado ao iniciar, para valer também para ofertas antigas).
// Grava só as que mudaram e roda em partes de 3 mil, deixando o servidor atender entre uma parte e outra
// (antes regravava todas as ofertas de uma vez, antes de o site ligar: ~4 s parado a cada reinício).
function reclassifyAll() {
  const rows = db.all('SELECT id, produto, categoria, subcategoria, fonte FROM offers');
  let i = 0, mudadas = 0;
  return new Promise(resolve => {
    const parte = () => {
      const fim = Math.min(i + 3000, rows.length);
      db.transaction(() => {
        for (; i < fim; i++) {
          const r = rows[i];
          const categoria = r.fonte === 'auto' || r.fonte === 'feed' ? classifyCategory(r.produto, r.categoria) : r.categoria;
          const sub = classifySubcategory(r.produto, categoria);
          if (categoria === r.categoria && sub === r.subcategoria) continue;
          db.run('UPDATE offers SET categoria = ?, subcategoria = ? WHERE id = ?', categoria, sub, r.id);
          mudadas++;
        }
      });
      if (i < rows.length) setImmediate(parte); else resolve(mudadas);
    };
    parte();
  });
}

module.exports = {
  activeClause, saveDeal, listActive, stats, isActive, listForAdmin, refreshAffiliateLinks, purgeOld, reclassifyAll, reclassifyOne,
};
