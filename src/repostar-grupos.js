// Repostar ofertas de outros grupos: o número das postagens participa de grupos de ofertas de outras pessoas (os
// "grupos de origem" escolhidos no painel). Quando chega neles uma oferta com link de loja, o site:
//  1. acha o produto (no site, pela API oficial da loja quando dá, ou pelos preços escritos na mensagem);
//  2. limpa o link (sai o código de afiliado de quem postou) e aplica os filtros, a lista de palavras e a regra de repetição;
//  3. confere o preço na loja (Mercado Livre e Shopee) e posta nos grupos de destino que recebem daquela origem, com o link de afiliado.
//     Os grupos de destino são os salvos em "Grupos de destino"; em cada um a pessoa marca de quais origens ele recebe.
//     e o modelo de mensagem do dono. O texto e o cupom de quem postou não são copiados.
// Uma postagem por vez, com intervalo mínimo e limite por hora. Nada das conversas desses grupos fica guardado: só o
// registro do que foi feito com cada oferta (7 dias), para o painel.
// Vale para o site (admin, cid = null) e para cada cliente da ferramenta (afiliado), cada um com o próprio número e escolhas.
const crypto = require('crypto');
const db = require('./db');
const settings = require('./settings');

db.db.exec(`
  CREATE TABLE IF NOT EXISTS repostar_registro (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER,
    origem TEXT,
    chave TEXT,
    produto TEXT,
    store_id TEXT,
    offer_id INTEGER,
    situacao TEXT NOT NULL,
    motivo TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_repostar_dono ON repostar_registro (cliente_id, id);
  CREATE INDEX IF NOT EXISTS idx_repostar_chave ON repostar_registro (cliente_id, chave, created_at);
`);

// Link do produto (sem o código de quem postou), para conferir depois por que uma oferta não foi repostada
if (!db.all('PRAGMA table_info(repostar_registro)').some(c => c.name === 'link')) db.db.exec('ALTER TABLE repostar_registro ADD COLUMN link TEXT');

const CHAVES = ['repost_ativo', 'repost_origens', 'repost_destinos', 'repost_por_tipo', 'repost_por_hora', 'repost_intervalo_min',
  'repost_desconto_min', 'repost_lojas', 'repost_inicio', 'repost_fim'];
const MAX_ORIGENS = 40;
const FILA_MAX = 15;                    // ofertas esperando a vez, por dono
const VALIDADE_MS = 30 * 60000;         // esperou mais que isso na fila: a oferta pode ter acabado
const IDADE_MAX_MENSAGEM_S = 900;       // mensagem antiga (o site estava fora do ar) não é repostada
const JA_VISTA_MIN = 30;                // a mesma oferta vinda de vários grupos: só a primeira é tratada
const LOJAS = ['mercadolivre', 'amazon', 'shopee', 'magalu', 'kabum', 'aliexpress'];

const log = m => console.log(`[REPOSTAR] ${m}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chaveDono = cid => (cid ? Number(cid) : 0);
const configDe = cid => (cid ? require('./clientes').config(cid) : settings.getAll());
const sqlAgora = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const lerLista = v => { try { const l = JSON.parse(v || '[]'); return Array.isArray(l) ? l.filter(g => g && g.id) : []; } catch { return []; } };
const numero = (v, padrao, min, max) => Math.min(Math.max(Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : padrao, min), max);
const hhmm = v => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim()); return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null; };

let pausas = true; // os testes desligam as esperas

// ── Ajustes ──────────────────────────────────────────────────────────────────
function ajustes(s) {
  return {
    ativo: s.repost_ativo === '1',
    origens: lerLista(s.repost_origens),
    // origens: null = recebe de todas (ajuste antigo, salvo antes de dar para escolher)
    destinos: lerLista(s.repost_destinos).map(g => ({ id: String(g.id), nome: g.nome, origens: Array.isArray(g.origens) ? g.origens.map(String) : null })),
    por_tipo: s.repost_por_tipo !== '0',
    por_hora: numero(s.repost_por_hora, 10, 1, 30),
    intervalo_min: numero(s.repost_intervalo_min, 3, 1, 120),
    desconto_min: numero(s.repost_desconto_min, 15, 1, 90),
    lojas: String(s.repost_lojas || '').split(/[,;\s]+/).filter(l => LOJAS.includes(l)),
    inicio: hhmm(s.repost_inicio) === null ? '08:00' : s.repost_inicio,
    fim: hhmm(s.repost_fim) === null ? '22:00' : s.repost_fim,
  };
}

// Leitura rápida a cada mensagem que chega (os grupos de ofertas mandam muitas): guardada por 30 segundos
const cacheAjustes = new Map();
function ajustesRapidos(cid) {
  const k = chaveDono(cid);
  const c = cacheAjustes.get(k);
  if (c && Date.now() - c.em < 30000) return c;
  const a = ajustes(configDe(cid));
  const novo = { em: Date.now(), ativo: a.ativo, origens: new Map(a.origens.map(g => [g.id, g.nome || g.id])) };
  cacheAjustes.set(k, novo);
  return novo;
}

// Grupos de destino da repostagem: os salvos em "Grupos de destino" (o número é administrador deles)
const gruposDestino = s => require('./whatsapp').gruposEscolhidos(s).map(g => ({ id: String(g.id), nome: g.nome || String(g.id) }));

// Salva o que veio do painel. Origem: qualquer grupo em que o número esteja (conferido com o número conectado).
// Destino: um dos "Grupos de destino", com as origens de que ele recebe.
async function salvar(cid, corpo = {}) {
  const s = configDe(cid);
  const proprio = require('./whatsapp-proprio');
  const dono = proprio.donoDe(cid);
  const valores = {};
  const ids = l => [...new Set((Array.isArray(l) ? l : []).map(g => String(g?.id || g)))];
  let origens = lerLista(s.repost_origens).map(g => g.id);
  if ('origens' in corpo && JSON.stringify(ids(corpo.origens).sort()) !== JSON.stringify([...origens].sort())) {
    const todos = await proprio.carregarGrupos(dono, { todos: true });
    const porId = new Map(todos.map(g => [g.id, g]));
    origens = ids(corpo.origens);
    const fora = origens.find(id => !porId.has(id));
    if (fora) throw Object.assign(new Error('Um dos grupos de origem não está mais neste número. Carregue os grupos de novo.'), { status: 400 });
    if (origens.length > MAX_ORIGENS) throw Object.assign(new Error(`Escolha no máximo ${MAX_ORIGENS} grupos de origem.`), { status: 400 });
    valores.repost_origens = JSON.stringify(origens.map(id => ({ id, nome: porId.get(id).nome })));
  }
  const controle = String(s.wa_grupo_controle || '').trim();
  if (controle && origens.includes(controle)) throw Object.assign(new Error('O grupo de automação não pode ser usado aqui.'), { status: 400 });
  if ('destinos' in corpo || 'origens' in corpo) {
    const validos = new Map(gruposDestino(s).map(g => [g.id, g]));
    const pedidos = 'destinos' in corpo ? (Array.isArray(corpo.destinos) ? corpo.destinos : []) : ajustes(s).destinos;
    const destinos = [];
    for (const d of pedidos) {
      const id = String(d?.id || '');
      const g = validos.get(id);
      if (!g) {
        if (!('destinos' in corpo)) continue; // saiu de "Grupos de destino": deixa de receber
        throw Object.assign(new Error('Um dos grupos de destino não está mais em "Grupos de destino". Atualize a página.'), { status: 400 });
      }
      // Origem que saiu da lista deixa de valer para o destino
      const deQuais = d.origens === null ? null : ids(d.origens).filter(o => origens.includes(o));
      if (deQuais && !deQuais.length) continue;
      if (origens.includes(id)) throw Object.assign(new Error(`O grupo ${g.nome} não pode ser origem e destino ao mesmo tempo.`), { status: 400 });
      if (!destinos.some(x => x.id === id)) destinos.push({ id, nome: g.nome, origens: deQuais });
    }
    valores.repost_destinos = JSON.stringify(destinos);
  }
  if ('ativo' in corpo) valores.repost_ativo = corpo.ativo ? '1' : '0';
  if ('por_tipo' in corpo) valores.repost_por_tipo = corpo.por_tipo ? '1' : '0';
  if ('por_hora' in corpo) valores.repost_por_hora = String(numero(corpo.por_hora, 10, 1, 30));
  if ('intervalo_min' in corpo) valores.repost_intervalo_min = String(numero(corpo.intervalo_min, 3, 1, 120));
  if ('desconto_min' in corpo) valores.repost_desconto_min = String(numero(corpo.desconto_min, 15, 1, 90));
  if ('lojas' in corpo) valores.repost_lojas = (Array.isArray(corpo.lojas) ? corpo.lojas : []).filter(l => LOJAS.includes(l)).join(',');
  for (const k of ['inicio', 'fim']) {
    if (!(k in corpo)) continue;
    if (hhmm(corpo[k]) === null) throw Object.assign(new Error('Horário inválido: use HH:MM (ex.: 08:00).'), { status: 400 });
    valores[`repost_${k}`] = String(corpo[k]).trim().padStart(5, '0');
  }
  const final = ajustes({ ...s, ...valores });
  if (final.ativo && (!final.origens.length || !final.destinos.length)) {
    throw Object.assign(new Error('Para ligar, escolha pelo menos um grupo de origem e marque, em um grupo de destino, de qual origem ele recebe.'), { status: 400 });
  }
  if (cid) require('./clientes').salvarConfig(cid, valores);
  else for (const [k, v] of Object.entries(valores)) settings.set(k, v);
  cacheAjustes.delete(chaveDono(cid));
  return painel(cid);
}

// ── Registro (o que aparece no painel) ───────────────────────────────────────
function registrar(cid, item, dados) {
  db.run(`INSERT INTO repostar_registro (cliente_id, origem, chave, produto, store_id, offer_id, situacao, motivo, link) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    cid ? Number(cid) : null, item?.origem || null, dados.chave || null, dados.produto ? String(dados.produto).slice(0, 200) : null,
    dados.store_id || null, dados.offer_id || null, dados.situacao, dados.motivo ? String(dados.motivo).slice(0, 300) : null,
    item?.link ? String(item.link).slice(0, 500) : null);
}
function painel(cid) {
  const s = configDe(cid);
  const a = ajustes(s);
  const dono = cid ? Number(cid) : null;
  const registro = db.all(`SELECT r.id, r.origem, r.produto, r.store_id, r.offer_id, r.situacao, r.motivo, r.link, r.created_at FROM repostar_registro r
    WHERE r.cliente_id IS ? ORDER BY r.id DESC LIMIT 40`, dono);
  const hoje = db.get(`SELECT SUM(situacao = 'postada') AS postadas, SUM(situacao = 'ignorada') AS ignoradas, SUM(situacao = 'erro') AS erros
    FROM repostar_registro WHERE cliente_id IS ? AND created_at >= datetime('now', '-24 hours')`, dono) || {};
  const semAfiliado = require('./clientes').lojasSemAfiliado(s);
  return {
    ajustes: a, registro, fila: (filas.get(chaveDono(cid)) || []).length,
    resumo: { postadas: hoje.postadas || 0, ignoradas: hoje.ignoradas || 0, erros: hoje.erros || 0, ultima_hora: postadasNaUltimaHora(cid) },
    sem_afiliado: semAfiliado, lojas: LOJAS, grupos_destino: gruposDestino(s), leitor_ml: require('./leitor-ml').estado(),
    // O que chegou de cada grupo de origem desde que o site ligou (mostra se o número está recebendo as mensagens)
    recebidas: a.origens.map(g => ({ id: g.id, nome: g.nome, ...(vistas.get(`${chaveDono(cid)}|${g.id}`) || { total: 0, ilegiveis: 0, ultima: null }) })),
  };
}
const postadasNaUltimaHora = cid => db.get(`SELECT COUNT(*) AS n FROM repostar_registro WHERE cliente_id IS ? AND situacao = 'postada' AND created_at >= datetime('now', '-1 hour')`, cid ? Number(cid) : null).n;
function limpar() { db.run(`DELETE FROM repostar_registro WHERE created_at < datetime('now', '-7 days')`); }

// ── Links ────────────────────────────────────────────────────────────────────
function linksDa(texto) {
  return [...new Set((String(texto || '').match(/https?:\/\/[^\s<>"'*_~]+/gi) || []).map(u => u.replace(/[).,;!?]+$/, '')))].slice(0, 5);
}
// Tira do link tudo o que identifica quem postou (código de afiliado, rastreio), deixando só o endereço do produto
function limparLink(store, url) {
  let u;
  try { u = new URL(String(url).split('#')[0]); } catch { return null; }
  if (store.id === 'mercadolivre') {
    const filtro = u.searchParams.get('pdp_filters');
    u.search = '';
    if (filtro) u.searchParams.set('pdp_filters', filtro);
    return u.href;
  }
  if (store.id === 'magalu' && /magazinevoce\.com\.br$/i.test(u.hostname)) {
    // Vitrine de outra pessoa (magazinevoce.com.br/magazine<loja>/…): volta para o endereço da Magazine Luiza
    const resto = u.pathname.split('/').filter(Boolean).slice(1).join('/');
    return resto ? `https://www.magazineluiza.com.br/${resto}${resto.endsWith('/') ? '' : '/'}` : null;
  }
  u.search = '';
  return u.href;
}

const resolvidos = new Map(); // link curto → endereço final (1 hora)
async function resolver(url) {
  const r = resolvidos.get(url);
  if (r && Date.now() - r.em < 3600000) return r.final;
  const final = await require('./net').resolverLink(url);
  if (resolvidos.size > 500) resolvidos.clear();
  resolvidos.set(url, { em: Date.now(), final });
  return final;
}

// ── Achar a oferta ───────────────────────────────────────────────────────────
// Dados do produto pela API oficial da loja (com as chaves do site). null = não deu para consultar.
async function lerNaLoja(store, url, pid) {
  const s = settings.getAll();
  const { getStore } = require('./stores');
  if (store.id === 'shopee') {
    if (!s.shopee_app_id || !s.shopee_app_secret) return null;
    const r = await getStore('shopee').porLink(url, s);
    if (r.status !== 'ok') return null;
    if (!r.deals.length) return { disponivel: false };
    return { deal: r.deals[0] };
  }
  if (store.id === 'mercadolivre' && pid) {
    const ml = getStore('mercadolivre');
    if (/\/p\/MLB\d+/i.test(url)) {
      const catalogo = (/\/p\/(MLB\d+)/i.exec(url) || [])[1];
      const deal = await ml.ofertaDoProduto(catalogo, s);
      if (deal === null && s.ml_client_id) return { disponivel: false };
      return deal ? { deal } : null;
    }
    const d = await ml.dadosDoAnuncio(pid, s);
    if (!d) return null;
    if (d.disponivel === false) return { disponivel: false };
    return { deal: d };
  }
  // Amazon (página do produto), KaBuM! (catálogo da loja) e Magalu (página do produto na sua loja Magazine Você)
  if (['amazon', 'kabum', 'magalu'].includes(store.id) && pid) return getStore(store.id).lerProduto(pid, s);
  return null;
}

async function produtoNaPaginaML(url) {
  try {
    const res = await require('./net').safeGet(url, { maxContentLength: 4 * 1024 * 1024, timeout: 12000, responseType: 'text' });
    const html = String(res.data || '');
    const catalogo = /\/p\/(MLB\d{6,})/i.exec(html);
    if (catalogo) return { pid: catalogo[1].toUpperCase(), url: `https://www.mercadolivre.com.br/p/${catalogo[1].toUpperCase()}` };
    const item = /\b(MLB)-?(\d{8,})\b/i.exec(html);
    if (item) return { pid: `MLB${item[2]}`, url: `https://produto.mercadolivre.com.br/MLB-${item[2]}` };
  } catch (err) { log(`página do Mercado Livre: ${err.message}`); }
  return null;
}

// { o, store, chave } | { erro, store?, chave? } | { silencio: true } (não era oferta ou já foi tratada)
async function ofertaDaMensagem(cid, item) {
  const { storeFromUrl } = require('./stores');
  let achado = null;
  const idDe = (st, u) => (st?.productIdFromUrl ? st.productIdFromUrl(u) : null);
  for (const url of item.urls) {
    let final = url, store = storeFromUrl(url);
    // Link encurtado, ou da loja mas sem o código do produto (link de afiliado curto): segue até o endereço final
    if (!store || !idDe(store, url)) {
      try { const f = await resolver(url); const st = storeFromUrl(f); if (st) { final = f; store = st; } } catch { /* não abriu */ }
    }
    if (store && LOJAS.includes(store.id)) { achado = { store, final }; break; }
  }
  if (!achado) {
    item.link = item.urls[0];
    return { erro: 'O link da mensagem não é de uma loja atendida (Mercado Livre, Amazon, Shopee, Magalu, KaBuM!, AliExpress).' };
  }
  const { store } = achado;
  let limpo = limparLink(store, achado.final);
  item.link = limpo || achado.final;
  if (!limpo) return { erro: `Não consegui ler o endereço do produto da ${store.name}.`, store };
  let pid = idDe(store, achado.final) || idDe(store, limpo);
  // Página do Mercado Livre sem o código no endereço (perfil de afiliado, "social"): procura o produto dentro da página
  if (!pid && store.id === 'mercadolivre') {
    const doML = await produtoNaPaginaML(achado.final);
    if (doML) { pid = doML.pid; limpo = doML.url; item.link = limpo; }
  }
  const chave = `${store.id}:${pid || crypto.createHash('sha1').update(limpo).digest('hex').slice(0, 16)}`;
  const dono = cid ? Number(cid) : null;
  // A mesma oferta costuma aparecer em vários grupos: trata uma vez (e não reposta o que já saiu nas últimas 24 h)
  if (emAndamento.has(`${chaveDono(cid)}|${chave}`)
    || db.get(`SELECT 1 FROM repostar_registro WHERE cliente_id IS ? AND chave = ? AND (created_at >= datetime('now', ?) OR (situacao = 'postada' AND created_at >= datetime('now', '-24 hours'))) LIMIT 1`,
      dono, chave, `-${JA_VISTA_MIN} minutes`)) return { silencio: true };
  emAndamento.add(`${chaveDono(cid)}|${chave}`);
  item.chave = chave;

  const offers = require('./offers');
  const noSite = pid && db.get(`SELECT * FROM offers WHERE store_id = ? AND store_product_id = ? AND oculto = 0 ORDER BY last_seen_at DESC LIMIT 1`, store.id, pid);
  if (noSite && offers.isActive(noSite.id)) return { o: noSite, store, chave };

  let loja = null;
  try { loja = await lerNaLoja(store, limpo, pid); } catch (err) { log(`${store.name}: ${err.message}`); }
  if (loja?.disponivel === false) return { erro: `A ${store.name} informou que o produto não está disponível ou está sem desconto.`, store, chave };
  if (loja?.deal) {
    const deal = { ...loja.deal, original_url: limparLink(store, loja.deal.original_url) || limpo };
    const id = offers.saveDeal(store, deal, { fonte: 'auto', ignorarProibidas: true });
    if (!id) return { erro: `Na ${store.name}, o desconto está fora da faixa aceita (1% a 99%).`, store, chave };
    return { o: db.get('SELECT * FROM offers WHERE id = ?', id), store, chave, conferida: true };
  }
  // Sem API da loja: usa o nome e os preços escritos na mensagem (o preço é conferido de novo antes de postar, quando dá)
  const lido = require('./grupo-automacao').lerOfertaDoTexto(item.texto);
  const textoCompleto = lido.titulo && lido.anterior && lido.atual && lido.anterior > lido.atual;
  // Mercado Livre: o servidor não consegue ler o anúncio (a API nega e a página pede verificação). A extensão do Chrome
  // do administrador lê a página e devolve nome, foto e preços (src/leitor-ml.js).
  if (!textoCompleto && store.id === 'mercadolivre' && pid) {
    const leitor = require('./leitor-ml');
    const ml = await leitor.aguardar(pid, limpo);
    if (ml?.disponivel === false) return { erro: 'O Mercado Livre informou que o anúncio não está mais disponível.', store, chave };
    if (ml?.preco && ml.preco_anterior > ml.preco) {
      const id = offers.saveDeal(store, { store_product_id: pid, produto: ml.produto, preco_atual: ml.preco, preco_anterior: ml.preco_anterior,
        imagem: ml.imagem, original_url: limpo }, { fonte: 'auto', ignorarProibidas: true });
      if (!id) return { erro: 'No Mercado Livre, o desconto está fora da faixa aceita (1% a 99%).', store, chave };
      return { o: db.get('SELECT * FROM offers WHERE id = ?', id), store, chave, conferida: true };
    }
    if (ml?.preco) return { erro: 'No Mercado Livre, o anúncio está sem preço riscado (sem desconto).', store, chave };
    return { erro: leitor.ativa()
      ? 'A extensão do Chrome não conseguiu ler este anúncio do Mercado Livre a tempo, e a mensagem não traz os preços.'
      : 'Para ler anúncios do Mercado Livre, deixe o Chrome aberto com a extensão Ofertou! (o Mercado Livre não deixa o servidor ler). A mensagem também não traz os preços.', store, chave };
  }
  if (!textoCompleto) {
    return { erro: 'A mensagem não traz o nome e os preços "De R$ … Por R$ …" e o produto não está no site.', store, chave };
  }
  const expira = sqlAgora(Date.now() + 86400000);
  const id = offers.saveDeal(store, { store_product_id: pid || chave.split(':')[1], produto: lido.titulo, preco_atual: lido.atual,
    preco_anterior: lido.anterior, imagem: null, original_url: limpo }, { fonte: 'manual', expiresAt: expira });
  if (!id) return { erro: 'Os preços da mensagem não formam um desconto válido.', store, chave };
  return { o: db.get('SELECT * FROM offers WHERE id = ?', id), store, chave };
}

// Motivo para não repostar (ou null)
function barrar(cid, s, a, o) {
  const clientes = require('./clientes');
  const nome = { mercadolivre: 'Mercado Livre', amazon: 'Amazon', shopee: 'Shopee', magalu: 'Magalu', kabum: 'KaBuM!', aliexpress: 'AliExpress' }[o.store_id] || o.store_id;
  if (a.lojas.length && !a.lojas.includes(o.store_id)) return `A ${nome} não está entre as lojas escolhidas.`;
  if (!clientes.lojasComAfiliado(s).includes(o.store_id)) return `Seu link de afiliado da ${nome} não está configurado: a venda não renderia comissão.`;
  if (Number(o.desconto_pct) < a.desconto_min) return `Desconto de ${Math.round(o.desconto_pct)}%, abaixo do mínimo de ${a.desconto_min}%.`;
  // As palavras proibidas e as do agendamento não valem aqui: o que chega dos grupos de origem é repostado
  const rep = require('./agenda').regraDeRepeticao(cid);
  if (rep.porOferta(o) || rep.porProduto(o)) return 'Este produto já foi postado nos últimos 7 dias e o preço não caiu 10%.';
  return null;
}

// ── Fila de cada dono: uma oferta por vez ────────────────────────────────────
const filas = new Map();
const trabalhando = new Set();
const emAndamento = new Set();
const ultimaPostagem = new Map();

const vistas = new Map(); // "dono|grupo" → { total, ilegiveis, ultima }
function contar(cid, chat, campo) {
  const k = `${chaveDono(cid)}|${chat}`;
  const v = vistas.get(k) || { total: 0, ilegiveis: 0, ultima: null };
  v[campo]++;
  v.ultima = new Date().toISOString();
  vistas.set(k, v);
}
const ilegiveisAvisadas = new Set();
// O WhatsApp entregou a mensagem sem o conteúdo (a chave do grupo ainda não chegou para este número). Ele pede de novo
// sozinho; se o conteúdo chegar, a oferta é tratada normalmente.
function naoLida(cid, chat, waId) {
  try {
    const c = ajustesRapidos(cid);
    if (!c.ativo || !c.origens.has(chat)) return;
    contar(cid, chat, 'ilegiveis');
    const k = `${chaveDono(cid)}|${waId}`;
    if (ilegiveisAvisadas.has(k)) return;
    if (ilegiveisAvisadas.size > 2000) ilegiveisAvisadas.clear();
    ilegiveisAvisadas.add(k);
    registrar(cid, { origem: c.origens.get(chat) }, { situacao: 'ignorada',
      motivo: 'O WhatsApp entregou esta mensagem sem o conteúdo (o grupo ainda não liberou a leitura para este número). O site pediu de novo; se chegar, a oferta aparece aqui.' });
  } catch (err) { log(err.message); }
}

function receber(cid, m) {
  try {
    if (!m || m.de_mim || !String(m.chat || '').endsWith('@g.us')) return false;
    const c = ajustesRapidos(cid);
    if (!c.ativo || !c.origens.has(m.chat)) return false;
    contar(cid, m.chat, 'total');
    if (!m.texto) return false;
    const urls = linksDa(m.texto);
    if (!urls.length) return false;
    if (m.segundos && Date.now() / 1000 - m.segundos > IDADE_MAX_MENSAGEM_S) {
      registrar(cid, { origem: c.origens.get(m.chat), link: urls[0] }, { situacao: 'ignorada', motivo: 'A mensagem chegou atrasada (mais de 15 minutos depois de postada): a oferta pode ter acabado.' });
      return false;
    }
    const k = chaveDono(cid);
    if (!filas.has(k)) filas.set(k, []);
    const fila = filas.get(k);
    fila.push({ urls, texto: String(m.texto).slice(0, 4000), bruta: m.bruta || null, origem: c.origens.get(m.chat), grupo: m.chat, link: urls[0], chegou: Date.now() });
    while (fila.length > FILA_MAX) {
      const fora = fila.shift();
      registrar(cid, fora, { situacao: 'ignorada', motivo: 'Chegaram ofertas demais de uma vez: esta ficou de fora.' });
    }
    trabalhar(cid);
    return true;
  } catch (err) { log(err.message); return false; }
}

function trabalhar(cid) {
  const k = chaveDono(cid);
  if (trabalhando.has(k)) return;
  trabalhando.add(k);
  (async () => {
    try {
      let item;
      while ((item = filas.get(k)?.shift())) {
        try { await tratar(cid, item); } catch (err) {
          log(`${cid ? `cliente ${cid}` : 'site'}: ${err.message}`);
          registrar(cid, item, { chave: item.chave, situacao: 'erro', motivo: err.message });
        } finally { if (item.chave) emAndamento.delete(`${k}|${item.chave}`); }
      }
    } finally { trabalhando.delete(k); }
  })();
}

async function fotoDaMensagem(cid, item) {
  if (!item.bruta) return null;
  try {
    const proprio = require('./whatsapp-proprio');
    const arquivo = await proprio.baixarMidia(proprio.donoDe(cid), { bruta: item.bruta }, 5 * 1048576);
    if (!/^image\//.test(arquivo.mimetype || 'image/')) return null;
    return await proprio.prepararImagem(Buffer.from(arquivo.base64, 'base64'));
  } catch (err) { log(`foto da mensagem: ${err.message}`); return null; }
}

async function tratar(cid, item) {
  const s = configDe(cid);
  const a = ajustes(s);
  if (!a.ativo) return;
  if (Date.now() - item.chegou > VALIDADE_MS) return registrar(cid, item, { situacao: 'ignorada', motivo: 'Esperou demais na fila: a oferta pode ter acabado.' });
  const r = await ofertaDaMensagem(cid, item);
  if (r.silencio) return;
  const base = { chave: r.chave, store_id: r.store?.id, produto: r.o?.produto, offer_id: r.o?.id };
  if (r.erro) return registrar(cid, item, { ...base, situacao: 'ignorada', motivo: r.erro });
  const motivo = barrar(cid, s, a, r.o);
  if (motivo) return registrar(cid, item, { ...base, situacao: 'ignorada', motivo });

  const whatsapp = require('./whatsapp');
  const social = require('./social');
  // Só os destinos que recebem desta origem e que ainda estão em "Grupos de destino"
  const salvos = new Set(gruposDestino(s).map(g => g.id));
  const destinos = a.destinos.filter(d => salvos.has(d.id) && (!d.origens || d.origens.includes(item.grupo)));
  if (!destinos.length) return registrar(cid, item, { ...base, situacao: 'ignorada', motivo: 'Nenhum grupo de destino recebe ofertas deste grupo de origem.' });
  const sDestino = whatsapp.comDestinos(s, destinos, a.por_tipo);
  if (!whatsapp.gruposDaOferta(sDestino, r.o.categoria, r.o.store_id).length) {
    return registrar(cid, item, { ...base, situacao: 'ignorada', motivo: 'Nenhum grupo de destino recebe ofertas deste tipo e desta loja.' });
  }
  if (postadasNaUltimaHora(cid) >= a.por_hora) return registrar(cid, item, { ...base, situacao: 'ignorada', motivo: `Limite de ${a.por_hora} repostagens por hora atingido.` });
  // Intervalo mínimo entre as repostagens
  const ultima = ultimaPostagem.get(chaveDono(cid)) || 0;
  const espera = ultima + a.intervalo_min * 60000 - Date.now();
  if (espera > 0 && pausas) await sleep(espera);
  if (Date.now() - item.chegou > VALIDADE_MS) return registrar(cid, item, { ...base, situacao: 'ignorada', motivo: 'Esperou demais na fila: a oferta pode ter acabado.' });

  // Preço na hora (Mercado Livre e Shopee); a oferta lida agora na loja já está conferida
  if (!r.conferida) {
    const conferencia = await require('./preco-na-hora').conferir(r.o.id);
    if (conferencia.acao === 'pular') return registrar(cid, item, { ...base, situacao: 'ignorada', motivo: conferencia.motivo });
  }
  const o = db.get('SELECT * FROM offers WHERE id = ?', r.o.id);
  // Foto: a da loja; se a loja recusar (ou não houver), a da própria mensagem
  let foto = null;
  const endereco = social.postImage(o, s);
  if (endereco) { try { foto = await whatsapp.fotoParaEnvio(endereco); } catch (err) { log(`foto da loja recusada (${err.message})`); } }
  if (!foto) foto = await fotoDaMensagem(cid, item);
  if (!foto) return registrar(cid, item, { ...base, situacao: 'ignorada', motivo: 'Sem foto do produto: nem a loja nem a mensagem entregaram a imagem.' });

  const link = cid ? await require('./clientes').linkParaPostar(cid, o, s) : null;
  if (link) o.__link = link;
  o.__link = require('./encurtador').curto(social.postLink(o, s));
  const texto = social.textoPadrao(o, s);
  const resultados = await social.publicar(o.id, ['whatsapp'], texto, `repostagem (${item.origem || 'outro grupo'})`, { s: sDestino, foto, ...(cid ? { clienteId: cid, link } : {}) });
  const ok = resultados.some(x => x.ok);
  ultimaPostagem.set(chaveDono(cid), Date.now());
  registrar(cid, item, { ...base, produto: o.produto, offer_id: o.id, situacao: ok ? 'postada' : 'erro', motivo: resultados.map(x => x.mensagem).join(' | ') });
}

function iniciar() {
  limpar();
  require('./leitor-ml').limpar();
  setInterval(limpar, 6 * 3600000).unref?.();
}

// Só para os testes
const _paraTestes = ({ pausa, zerar } = {}) => {
  if (pausa !== undefined) pausas = pausa;
  if (zerar) { filas.clear(); trabalhando.clear(); emAndamento.clear(); ultimaPostagem.clear(); cacheAjustes.clear(); resolvidos.clear(); vistas.clear(); ilegiveisAvisadas.clear(); }
};
const ocupado = cid => trabalhando.has(chaveDono(cid));

module.exports = { CHAVES, receber, naoLida, salvar, painel, limparLink, linksDa, ajustes, iniciar, ocupado, _paraTestes };
