// Cupons do Mercado Livre (Painel → Mineração → "Cupons do Mercado Livre").
// A central de cupons só abre com a conta logada (e a leitura automática pelo servidor é barrada como "tráfego
// suspeito"), então quem lê é a extensão do Chrome no navegador do admin e o Painel manda para cá:
//  • cupons: todos os da central (desconto, compra mínima, limite, validade, se já está ativo na conta);
//  • produtos: os marcados "com Cupom" na lista de cada cupom ativo (o link "Conferir"), como aparecem no cartão.
// Cada produto vira oferta pelo preço com o cupom (respeitando a compra mínima e o limite do cupom).
const db = require('./db');
const settings = require('./settings');
const offers = require('./offers');
const cupons = require('./cupons');
const ml = require('./stores/mercadolivre');

db.db.exec(`CREATE TABLE IF NOT EXISTS ml_cupons (
  campanha TEXT PRIMARY KEY,
  titulo TEXT NOT NULL,
  subtitulo TEXT,
  tipo TEXT,               -- pct | valor
  valor REAL,
  minimo REAL,             -- compra mínima (R$)
  limite REAL,             -- desconto máximo (R$)
  validade TEXT,           -- texto do Mercado Livre ("Vence 31 de dezembro")
  expira_em TEXT,          -- data de fim (ISO), quando o Mercado Livre informa
  ativo INTEGER NOT NULL DEFAULT 0,  -- já ativo na conta (tem o link dos produtos)
  link TEXT,
  previa TEXT,             -- nomes de alguns produtos (JSON)
  produtos INTEGER NOT NULL DEFAULT 0,
  visto_em TEXT NOT NULL DEFAULT (datetime('now'))
)`);

const preco = v => (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) < 1e6 ? Math.round(Number(v) * 100) / 100 : null);
const txt = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || null;

function salvarCupons(lista) {
  let n = 0;
  for (const c of (Array.isArray(lista) ? lista : []).slice(0, 5000)) {
    const campanha = String(c.id || '').replace(/\D/g, '').slice(0, 20);
    const titulo = txt(c.titulo, 120);
    if (!campanha || !titulo) continue;
    const link = /^https:\/\/lista\.mercadolivre\.com\.br\//.test(c.link || '') ? String(c.link).slice(0, 500) : null;
    db.run(`INSERT INTO ml_cupons (campanha, titulo, subtitulo, tipo, valor, minimo, limite, validade, expira_em, ativo, link, previa, visto_em)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(campanha) DO UPDATE SET titulo = excluded.titulo, subtitulo = excluded.subtitulo, tipo = excluded.tipo,
              valor = excluded.valor, minimo = excluded.minimo, limite = excluded.limite, validade = excluded.validade,
              expira_em = excluded.expira_em, ativo = excluded.ativo, link = excluded.link, previa = excluded.previa, visto_em = excluded.visto_em`,
      campanha, titulo, txt(c.subtitulo, 120), c.tipo === 'pct' || c.tipo === 'valor' ? c.tipo : null, preco(c.valor),
      preco(c.minimo), preco(c.limite), txt(c.validade, 60), txt(c.expira, 30), c.ativo ? 1 : 0, link,
      JSON.stringify((Array.isArray(c.previa) ? c.previa : []).map(p => txt(p, 120)).filter(Boolean).slice(0, 5)));
    n++;
  }
  return n;
}

// Cupons esgotados: saem da lista e as ofertas deles voltam ao preço sem cupom. Sem desconto suficiente nesse preço,
// a oferta sai do ar (se o produto voltar com desconto na mineração, ela volta sozinha).
function removerEsgotados(lista) {
  const campanhas = [...new Set((Array.isArray(lista) ? lista : []).slice(0, 5000).map(c => String(c || '').replace(/\D/g, '').slice(0, 20)).filter(Boolean))];
  const minimo = settings.getNumber('min_discount_pct', 5);
  let cupomRemovido = 0, ofertas = 0;
  db.transaction(() => {
    for (const campanha of campanhas) {
      cupomRemovido += db.run('DELETE FROM ml_cupons WHERE campanha = ?', campanha).changes;
      for (const o of db.all('SELECT id, preco_anterior, preco_sem_cupom FROM offers WHERE cupom_codigo = ?', `ML${campanha}`)) {
        const preco = Number(o.preco_sem_cupom) || null;
        if (!preco) { db.run('UPDATE offers SET cupom_codigo = NULL, cupom_texto = NULL, preco_sem_cupom = NULL WHERE id = ?', o.id); ofertas++; continue; }
        const desconto = o.preco_anterior > 0 ? Math.max(0, Math.round((1 - preco / o.preco_anterior) * 100)) : 0;
        db.run(`UPDATE offers SET preco_atual = ?, desconto_pct = ?, cupom_codigo = NULL, cupom_texto = NULL, preco_sem_cupom = NULL${desconto < minimo ? ", last_seen_at = datetime('now', '-29 days')" : ''} WHERE id = ?`, preco, desconto, o.id);
        ofertas++;
      }
    }
  });
  return { cupons: cupomRemovido, ofertas };
}

// Desconto do cupom no cartão do produto ("5% OFF com Cupom", "R$ 30 OFF com Cupom"); sem número, vale o do cupom
function descontoDoRotulo(rotulo, c) {
  const pct = String(rotulo || '').match(/(\d{1,2}(?:[.,]\d{1,2})?)\s*%\s*OFF/i);
  if (pct) return { tipo: 'pct', valor: Number(pct[1].replace(',', '.')) };
  const valor = String(rotulo || '').match(/R\$\s*(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?)\s*OFF/i);
  if (valor) return { tipo: 'valor', valor: Number(valor[1].replace(/\./g, '').replace(',', '.')) };
  return c.tipo && c.valor ? { tipo: c.tipo, valor: c.valor } : null;
}

// "R$ 50 OFF" + "Em produtos de Cama Inbox" → "R$ 50 OFF em Cama Inbox" (o subtítulo genérico não entra)
const nomeDoCupom = c => {
  const sub = String(c.subtitulo || '').replace(/^em produtos (de|da|do)\s+/i, 'em ').trim();
  return sub && !/selecionados/i.test(sub) && !c.titulo.toLowerCase().includes(sub.toLowerCase()) ? `${c.titulo} ${sub}` : c.titulo;
};

function importarProdutos(campanha, itens) {
  const s = settings.getAll();
  const c = db.get('SELECT * FROM ml_cupons WHERE campanha = ?', String(campanha || ''));
  const out = { recebidos: 0, gravados: 0, ids: [] };
  if (!c) return out;
  for (const it of (Array.isArray(itens) ? itens : []).slice(0, 300)) {
    out.recebidos++;
    const id = String(it.produto || it.item || '').toUpperCase().match(/^MLB-?(\d{6,})$/);
    const nome = txt(it.nome, 200);
    const atual = preco(it.preco);
    let url;
    try { url = new URL(it.link); } catch { continue; }
    if (!id || !nome || !atual || !/(^|\.)mercadoli(vre|bre)\.com(\.br)?$/i.test(url.hostname)) continue;
    const desconto = descontoDoRotulo(it.rotulo, c);
    if (!desconto) continue;
    // "R$ 1.128 com Cupom" (rótulo colado no preço): o preço já vem com o cupom. "R$ 50 OFF com Cupom" (à parte): ainda não.
    const base = {
      store_product_id: `MLB${id[1]}`, produto: nome, preco_atual: atual, preco_anterior: preco(it.preco_anterior) || atual,
      imagem: /^https:\/\//.test(it.imagem || '') ? it.imagem : null,
      original_url: `${url.origin}${url.pathname}`,
    };
    const dadosCupom = { codigo: `ML${c.campanha}`, ...desconto, minimo: c.minimo, limite: c.limite, texto: nomeDoCupom(c) };
    const deal = /OFF/i.test(String(it.rotulo || '')) ? cupons.aplicar(base, dadosCupom) : cupons.jaIncluso(base, dadosCupom);
    if (!deal.cupom_codigo) continue; // abaixo da compra mínima: o cupom não vale para este produto
    const oid = offers.saveDeal(ml, deal, { settings: s });
    if (oid) { out.gravados++; out.ids.push(oid); }
  }
  db.run('UPDATE ml_cupons SET produtos = ? WHERE campanha = ?', out.gravados, c.campanha);
  return out;
}

// Cupons no Painel: os ativos com produtos primeiro, depois os maiores descontos; some o que não é visto há 3 dias
function listar() {
  db.run(`DELETE FROM ml_cupons WHERE visto_em < datetime('now', '-3 days')`);
  return db.all(`SELECT campanha, titulo, subtitulo, tipo, valor, minimo, limite, validade, ativo, link, previa, produtos, visto_em
                 FROM ml_cupons ORDER BY produtos DESC, ativo DESC, valor DESC LIMIT 3000`)
    .map(r => ({ ...r, previa: (() => { try { return JSON.parse(r.previa || '[]'); } catch { return []; } })() }));
}

// Ofertas lidas pela extensão na página de ofertas do Mercado Livre. As marcadas "relâmpago" entram com a hora do fim, se a página mostrar.
// Endereço guardado da oferta: sem rastreio; no link /up/ (vários vendedores) fica o pdp_filters do anúncio lido
function urlDoAnuncio(url, item) {
  const base = `${url.origin}${url.pathname}`;
  if (!/\/up\//i.test(url.pathname)) return base;
  const filtro = url.searchParams.get('pdp_filters') || (/^MLB\d{6,}$/i.test(String(item || '')) ? `item_id:${String(item).toUpperCase()}` : null);
  return filtro ? `${base}?pdp_filters=${encodeURIComponent(filtro)}` : base;
}

function importarOfertas(itens) {
  const s = settings.getAll();
  const out = { recebidos: 0, gravados: 0, relampagos: 0 };
  for (const it of (Array.isArray(itens) ? itens : []).slice(0, 500)) {
    out.recebidos++;
    const id = String(it.produto || it.item || '').toUpperCase().match(/^MLB-?(\d{6,})$/);
    const nome = txt(it.nome, 200);
    const atual = preco(it.preco), anterior = preco(it.preco_anterior);
    let url;
    try { url = new URL(it.link); } catch { continue; }
    if (!id || !nome || !atual || !anterior || !/(^|\.)mercadoli(vre|bre)\.com(\.br)?$/i.test(url.hostname)) continue;
    const resta = Number(it.resta_s);
    // A extensão manda a hora do fim calculada na leitura; a versão antiga, só o que faltava naquele momento
    const fimLido = Number(it.fim_ms);
    const fim = fimLido > Date.now() && fimLido < Date.now() + 7 * 86400000 ? fimLido : resta > 0 && resta < 7 * 86400 ? Date.now() + resta * 1000 : 0;
    const deal = {
      store_product_id: `MLB${id[1]}`, produto: nome, preco_atual: atual, preco_anterior: anterior,
      imagem: /^https:\/\//.test(it.imagem || '') ? it.imagem : null, original_url: urlDoAnuncio(url, it.item),
      ...(it.relampago ? { relampago: { fim } } : {}),
    };
    if (offers.saveDeal(ml, deal, { settings: s, manterCupom: true })) { out.gravados++; if (it.relampago) out.relampagos++; }
  }
  return out;
}

// Depois de gravar a leitura: o que estava como relâmpago do Mercado Livre e não veio nela já acabou.
//  • sem hora real do fim: nunca dá para saber quando acaba, então sai se não veio;
//  • com hora real: só sai se a leitura foi até o fim da lista (senão pode só estar numa página que não foi lida).
function encerrarRelampagos(vistos, completa = false) {
  const lidos = new Set((Array.isArray(vistos) ? vistos : []).map(v => String(v || '').toUpperCase().replace('-', '')).filter(v => /^MLB\d{6,}$/.test(v)));
  if (!lidos.size) return { encerradas: 0 }; // leitura vazia não prova nada
  const relampago = require('./relampago');
  let encerradas = 0;
  db.transaction(() => {
    for (const o of db.all(`SELECT id, store_product_id, relampago_fim_real FROM offers WHERE store_id = 'mercadolivre' AND fonte = 'auto' AND relampago_tipo = 'loja' AND relampago_fim > datetime('now')`)) {
      if (lidos.has(String(o.store_product_id).toUpperCase()) || (o.relampago_fim_real && !completa)) continue;
      relampago.encerrar(o.id);
      encerradas++;
    }
  });
  return { encerradas };
}

module.exports = { salvarCupons, removerEsgotados, importarProdutos, importarOfertas, encerrarRelampagos, listar };
