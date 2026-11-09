// Repostar ofertas de outros grupos: o número das postagens participa de grupos de ofertas de outras pessoas (os
// "grupos de origem" escolhidos no painel). Quando chega neles uma oferta com link de loja, o site:
//  1. acha o produto (no site, pela API oficial da loja quando dá, ou pelos preços escritos na mensagem);
//  2. limpa o link (sai o código de afiliado de quem postou) e aplica os filtros, a lista de palavras e a regra de repetição;
//  3. confere o preço na loja (Mercado Livre e Shopee) e posta nos grupos de destino escolhidos, com o link de afiliado
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

const CHAVES = ['repost_ativo', 'repost_origens', 'repost_destinos', 'repost_por_tipo', 'repost_por_hora', 'repost_intervalo_min',
  'repost_desconto_min', 'repost_lojas', 'repost_inicio', 'repost_fim'];
const MAX_ORIGENS = 40;
const FILA_MAX = 15;                    // ofertas esperando a vez, por dono
const VALIDADE_MS = 30 * 60000;         // esperou mais que isso na fila: a oferta pode ter acabado
const IDADE_MAX_MENSAGEM_S = 300;       // mensagem antiga (o site estava fora do ar) não é repostada
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
    destinos: lerLista(s.repost_destinos),
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

function dentroDoHorario(a) {
  const d = new Date(Date.now() - 3 * 3600000);
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  const ini = hhmm(a.inicio), fim = hhmm(a.fim);
  return ini <= fim ? min >= ini && min < fim : min >= ini || min < fim;
}

// Salva o que veio do painel. Os grupos são conferidos com o número conectado: destino só nos grupos deste número
// (em que ele é administrador); origem em qualquer grupo em que ele esteja, menos os de destino.
async function salvar(cid, corpo = {}) {
  const s = configDe(cid);
  const proprio = require('./whatsapp-proprio');
  const dono = proprio.donoDe(cid);
  const valores = {};
  const mesmos = (lista, salvos) => !(lista === undefined) && JSON.stringify([...new Set((Array.isArray(lista) ? lista : []).map(g => String(g?.id || g)))].sort())
    === JSON.stringify(lerLista(salvos).map(g => g.id).sort());
  const mudouGrupos = ('origens' in corpo && !mesmos(corpo.origens, s.repost_origens)) || ('destinos' in corpo && !mesmos(corpo.destinos, s.repost_destinos));
  if (mudouGrupos) {
    const todos = await proprio.carregarGrupos(dono, { todos: true });
    const porId = new Map(todos.map(g => [g.id, g]));
    const ids = l => [...new Set((Array.isArray(l) ? l : []).map(g => String(g?.id || g)))];
    const destinos = ids(corpo.destinos);
    const origens = ids(corpo.origens);
    const naoMeu = destinos.find(id => !porId.get(id)?.meu);
    if (naoMeu) throw Object.assign(new Error('Grupo de destino precisa ser um grupo em que este número é administrador.'), { status: 400 });
    const fora = origens.find(id => !porId.has(id));
    if (fora) throw Object.assign(new Error('Um dos grupos de origem não está mais neste número. Carregue os grupos de novo.'), { status: 400 });
    if (origens.some(id => destinos.includes(id))) throw Object.assign(new Error('Um grupo não pode ser origem e destino ao mesmo tempo.'), { status: 400 });
    const controle = String(s.wa_grupo_controle || '').trim();
    if (controle && (origens.includes(controle) || destinos.includes(controle))) throw Object.assign(new Error('O grupo de automação não pode ser usado aqui.'), { status: 400 });
    if (origens.length > MAX_ORIGENS) throw Object.assign(new Error(`Escolha no máximo ${MAX_ORIGENS} grupos de origem.`), { status: 400 });
    valores.repost_origens = JSON.stringify(origens.map(id => ({ id, nome: porId.get(id).nome })));
    valores.repost_destinos = JSON.stringify(destinos.map(id => ({ id, nome: porId.get(id).nome })));
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
    throw Object.assign(new Error('Para ligar, escolha pelo menos um grupo de origem e um grupo de destino.'), { status: 400 });
  }
  if (cid) require('./clientes').salvarConfig(cid, valores);
  else for (const [k, v] of Object.entries(valores)) settings.set(k, v);
  cacheAjustes.delete(chaveDono(cid));
  return painel(cid);
}

// ── Registro (o que aparece no painel) ───────────────────────────────────────
function registrar(cid, item, dados) {
  db.run(`INSERT INTO repostar_registro (cliente_id, origem, chave, produto, store_id, offer_id, situacao, motivo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    cid ? Number(cid) : null, item?.origem || null, dados.chave || null, dados.produto ? String(dados.produto).slice(0, 200) : null,
    dados.store_id || null, dados.offer_id || null, dados.situacao, dados.motivo ? String(dados.motivo).slice(0, 300) : null);
}
function painel(cid) {
  const s = configDe(cid);
  const a = ajustes(s);
  const dono = cid ? Number(cid) : null;
  const registro = db.all(`SELECT r.id, r.origem, r.produto, r.store_id, r.offer_id, r.situacao, r.motivo, r.created_at FROM repostar_registro r
    WHERE r.cliente_id IS ? ORDER BY r.id DESC LIMIT 40`, dono);
  const hoje = db.get(`SELECT SUM(situacao = 'postada') AS postadas, SUM(situacao = 'ignorada') AS ignoradas, SUM(situacao = 'erro') AS erros
    FROM repostar_registro WHERE cliente_id IS ? AND created_at >= datetime('now', '-24 hours')`, dono) || {};
  const semAfiliado = require('./clientes').lojasSemAfiliado(s);
  return {
    ajustes: a, registro, fila: (filas.get(chaveDono(cid)) || []).length,
    resumo: { postadas: hoje.postadas || 0, ignoradas: hoje.ignoradas || 0, erros: hoje.erros || 0, ultima_hora: postadasNaUltimaHora(cid) },
    sem_afiliado: semAfiliado, lojas: LOJAS,
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
  return null;
}

// { o, store, chave } | { erro, store?, chave? } | { silencio: true } (não era oferta ou já foi tratada)
async function ofertaDaMensagem(cid, item) {
  const { storeFromUrl } = require('./stores');
  let achado = null;
  for (const url of item.urls) {
    let final = url, store = storeFromUrl(url);
    if (!store) { try { final = await resolver(url); store = storeFromUrl(final); } catch { /* não abriu */ } }
    if (store && LOJAS.includes(store.id)) { achado = { store, final }; break; }
  }
  if (!achado) return /r\$\s*\d/i.test(item.texto) ? { erro: 'O link não é de uma loja atendida (Mercado Livre, Amazon, Shopee, Magalu, KaBuM!, AliExpress).' } : { silencio: true };
  const { store } = achado;
  const limpo = limparLink(store, achado.final);
  if (!limpo) return { erro: `Não consegui ler o endereço do produto da ${store.name}.`, store };
  const pid = store.productIdFromUrl ? store.productIdFromUrl(achado.final) || store.productIdFromUrl(limpo) : null;
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
    const id = offers.saveDeal(store, deal, { fonte: 'auto' });
    if (!id) return { erro: `Na ${store.name}, o desconto está fora da faixa aceita ou o produto tem palavra proibida.`, store, chave };
    return { o: db.get('SELECT * FROM offers WHERE id = ?', id), store, chave, conferida: true };
  }
  // Sem API da loja: usa o nome e os preços escritos na mensagem (o preço é conferido de novo antes de postar, quando dá)
  const lido = require('./grupo-automacao').lerOfertaDoTexto(item.texto);
  if (!lido.titulo || !lido.anterior || !lido.atual || lido.anterior <= lido.atual) {
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
  if (require('./palavras-proibidas').bloqueia(o.produto)) return 'O produto tem uma palavra da lista de proibidas.';
  const agenda = require('./agenda');
  if (!agenda.filtroDoDono({ ...s, agenda_lojas: '' })(o)) return 'O produto bateu nas palavras bloqueadas (ou não tem as obrigatórias) do agendamento.';
  const rep = agenda.regraDeRepeticao(cid);
  if (rep.porOferta(o) || rep.porProduto(o)) return 'Este produto já foi postado nos últimos 7 dias e o preço não caiu 10%.';
  return null;
}

// ── Fila de cada dono: uma oferta por vez ────────────────────────────────────
const filas = new Map();
const trabalhando = new Set();
const emAndamento = new Set();
const ultimaPostagem = new Map();

function receber(cid, m) {
  try {
    if (!m || m.de_mim || !String(m.chat || '').endsWith('@g.us') || !m.texto) return false;
    if (m.segundos && Date.now() / 1000 - m.segundos > IDADE_MAX_MENSAGEM_S) return false;
    const c = ajustesRapidos(cid);
    if (!c.ativo || !c.origens.has(m.chat)) return false;
    const urls = linksDa(m.texto);
    if (!urls.length) return false;
    const k = chaveDono(cid);
    if (!filas.has(k)) filas.set(k, []);
    const fila = filas.get(k);
    fila.push({ urls, texto: String(m.texto).slice(0, 4000), bruta: m.bruta || null, origem: c.origens.get(m.chat), chegou: Date.now() });
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
  if (!dentroDoHorario(a)) return registrar(cid, item, { ...base, situacao: 'ignorada', motivo: `Fora do horário de postagem (${a.inicio} às ${a.fim}).` });
  const motivo = barrar(cid, s, a, r.o);
  if (motivo) return registrar(cid, item, { ...base, situacao: 'ignorada', motivo });

  const whatsapp = require('./whatsapp');
  const social = require('./social');
  const sDestino = whatsapp.comDestinos(s, a.destinos, a.por_tipo);
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
  setInterval(limpar, 6 * 3600000).unref?.();
}

// Só para os testes
const _paraTestes = ({ pausa, zerar } = {}) => {
  if (pausa !== undefined) pausas = pausa;
  if (zerar) { filas.clear(); trabalhando.clear(); emAndamento.clear(); ultimaPostagem.clear(); cacheAjustes.clear(); resolvidos.clear(); }
};
const ocupado = cid => trabalhando.has(chaveDono(cid));

module.exports = { CHAVES, receber, salvar, painel, limparLink, linksDa, ajustes, iniciar, ocupado, _paraTestes };
