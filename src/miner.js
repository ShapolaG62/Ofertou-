// Orquestra a mineração: percorre as lojas automáticas, grava as ofertas e registra o status de cada loja.
const db = require('./db');
const settings = require('./settings');
const offers = require('./offers');
const { STORES } = require('./stores');
const { sleep } = require('./util');

const DELAY_BETWEEN_QUERIES_MS = 2500;
// Gravar uma oferta segura o servidor por alguns milissegundos: a cada 20, deixa o site atender quem está esperando
const respirar = () => new Promise(r => setImmediate(r));

let running = null;
let runningSince = null; // quando a mineração em andamento começou (para a animação da Capi no site)
let lastRun = null;
// Parar a mineração em andamento (Painel → Mineração → Parar): cada loja confere antes de cada termo e durante a
// pausa entre as buscas, então para em poucos segundos, sem cortar uma oferta no meio da gravação.
let parar = false;
async function esperar(ms) {
  for (let t = 0; t < ms && !parar; t += 250) await sleep(Math.min(250, ms - t));
}
function pararMineracao() {
  if (!running) return { parando: false, motivo: 'Nenhuma mineração em andamento.' };
  parar = true;
  console.log('[MINER] Parada pedida pelo administrador.');
  return { parando: true };
}
let timer = null;

function setStatus(storeId, fields) {
  const cur = db.get('SELECT * FROM store_status WHERE store_id = ?', storeId) || {};
  const next = { ...cur, ...fields };
  db.run(
    `INSERT INTO store_status (store_id, status, message, found, saved, last_run_at, last_success_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(store_id) DO UPDATE SET status = excluded.status, message = excluded.message, found = excluded.found,
       saved = excluded.saved, last_run_at = excluded.last_run_at, last_success_at = excluded.last_success_at`,
    storeId, next.status || null, next.message || null, next.found || 0, next.saved || 0,
    next.last_run_at || null, next.last_success_at || null
  );
}

async function mineStore(store, terms, s, log, { varredura = false } = {}) {
  const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const ready = store.isReady(s);
  if (!ready.ready) {
    setStatus(store.id, { status: store.automatic ? 'not_configured' : 'manual', message: ready.reason, found: 0, saved: 0 });
    return { store: store.id, found: 0, saved: 0, status: 'skipped' };
  }

  setStatus(store.id, { status: 'running', message: 'Minerando...', last_run_at: now() });
  let found = 0, saved = 0, lastStatus = 'ok', lastMessage = '';
  for (let i = 0; i < terms.length; i++) {
    if (parar) { lastStatus = 'stopped'; lastMessage = `Parada pelo administrador (${i} de ${terms.length} termos)`; break; }
    const term = terms[i];
    let result;
    try {
      result = await store.search(term.query, s);
    } catch (err) {
      result = { status: 'error', message: err.message, deals: [] };
    }
    lastMessage = result.message || '';
    if (result.status === 'blocked') {
      lastStatus = 'blocked';
      log(`[${store.name}] bloqueado: ${result.message}`);
      break; // não insiste numa loja que está bloqueando
    }
    if (result.status === 'error') {
      lastStatus = 'error';
      log(`[${store.name}] "${term.query}": erro ${result.message}`);
    }
    for (const [n, deal] of result.deals.entries()) {
      if (n && n % 20 === 0) await respirar();
      found++;
      try {
        if (offers.saveDeal(store, deal, { settings: s, catHint: term.cat })) saved++;
      } catch (err) {
        log(`[${store.name}] falha ao gravar: ${err.message}`);
      }
    }
    if (i < terms.length - 1) await esperar(DELAY_BETWEEN_QUERIES_MS);
  }

  // Varredura extra da loja, além dos termos (Mercado Livre: mais vendidos das categorias, em rodízio)
  if (varredura && typeof store.varredura === 'function' && !parar && lastStatus !== 'blocked') {
    try {
      const r = await store.varredura(s, { parar: () => parar });
      for (const [n, deal] of r.deals.entries()) {
        if (n && n % 20 === 0) await respirar();
        found++;
        try { if (offers.saveDeal(store, deal, { settings: s })) saved++; } catch (err) { log(`[${store.name}] falha ao gravar: ${err.message}`); }
      }
      if (r.message) { lastMessage = lastMessage ? `${lastMessage} · ${r.message}` : r.message; log(`[${store.name}] ${r.message}`); }
    } catch (err) { log(`[${store.name}] varredura: erro ${err.message}`); }
  }

  const ok = lastStatus === 'ok' || saved > 0;
  setStatus(store.id, {
    status: lastStatus === 'stopped' ? 'stopped' : ok && lastStatus !== 'blocked' ? 'ok' : lastStatus,
    message: lastMessage || (ok ? '' : 'Nenhuma oferta encontrada'),
    found, saved,
    ...(saved > 0 ? { last_success_at: now() } : {}),
  });
  log(`[${store.name}] ${found} encontradas, ${saved} gravadas (${lastStatus})`);
  return { store: store.id, found, saved, status: lastStatus, message: lastMessage };
}

// Um termo pedido pela busca do site, na hora: não depende da rodada automática nem mexe na situação das lojas no painel.
async function minerarTermo(query) {
  const s = settings.getAll();
  const ligadas = settings.getEnabledStores();
  const cat = (settings.getSearchTerms().find(t => t.query === query) || {}).cat || null;
  const lojas = STORES.filter(st => st.automatic && ligadas[st.id] !== false && st.isReady(s).ready);
  // Anúncios comuns do Mercado Livre (a API só lê o catálogo): a extensão do Chrome busca o termo no próximo minuto
  if (ligadas.mercadolivre !== false) require('./mineracao-ml-chrome').priorizar(query);
  const r = await Promise.all(lojas.map(async store => {
    try {
      const espera = new Promise((_, nao) => setTimeout(() => nao(new Error('demorou demais')), 90 * 1000).unref?.());
      const res = await Promise.race([store.search(query, s), espera]);
      if (res.status !== 'ok') return { encontradas: 0, gravadas: 0, falhou: 1 };
      let gravadas = 0;
      for (const [n, deal] of res.deals.entries()) {
        if (n && n % 20 === 0) await respirar();
        try { if (offers.saveDeal(store, deal, { settings: s, catHint: cat })) gravadas++; } catch { /* oferta com problema: segue */ }
      }
      return { encontradas: res.deals.length, gravadas, falhou: 0 };
    } catch (err) {
      console.error(`[MINER] termo "${query}" em ${store.name}: ${err.message}`);
      return { encontradas: 0, gravadas: 0, falhou: 1 };
    }
  }));
  const soma = k => r.reduce((a, x) => a + x[k], 0);
  console.log(`[MINER] termo da busca "${query}": ${soma('gravadas')} gravadas`);
  return { encontradas: soma('encontradas'), gravadas: soma('gravadas'), falhas: soma('falhou') };
}

// Com centenas de termos, cada rodada busca só um lote e a próxima continua de onde esta parou.
// Assim a lista inteira é percorrida várias vezes por dia sem disparar centenas de buscas de uma vez.
function nextBatch(all) {
  const size = Math.min(Math.max(Math.round(settings.getNumber('mining_terms_per_run', 60)), 5), 500);
  if (all.length <= size) return all;
  const start = (Number(settings.get('mining_cursor')) || 0) % all.length;
  const batch = Array.from({ length: size }, (_, i) => all[(start + i) % all.length]);
  settings.set('mining_cursor', String((start + size) % all.length));
  return batch;
}

// options.query: busca um termo específico; options.storeIds: limita às lojas indicadas.
// options.escolhidas: na busca pontual, as lojas marcadas são mineradas mesmo se estiverem desligadas na automática.
async function runMining(options = {}) {
  if (running) return { alreadyRunning: true };
  parar = false;
  const s = settings.getAll();
  const enabled = settings.getEnabledStores();
  const terms = options.query ? [{ query: options.query, cat: null }] : nextBatch(settings.getSearchTerms());
  const stores = STORES.filter(st => !options.storeIds || options.storeIds.includes(st.id));
  const log = msg => console.log(`[MINER] ${msg}`);

  runningSince = new Date().toISOString();
  running = (async () => {
    const startedAt = runningSince;
    log(`Iniciando mineração (${options.query ? `termo "${options.query}"` : `${terms.length} termos`})`);
    const results = await Promise.all(stores.map(store => {
      if (store.automatic && enabled[store.id] === false && !options.escolhidas) {
        setStatus(store.id, { status: 'disabled', message: 'Desativada no painel', found: 0, saved: 0 });
        return { store: store.id, status: 'disabled', found: 0, saved: 0 };
      }
      return mineStore(store, terms, s, log, { varredura: !options.query });
    }));
    const purged = offers.purgeOld();
    lastRun = { startedAt, finishedAt: new Date().toISOString(), results, purged, query: options.query || null, parada: parar };
    log(`Mineração ${parar ? 'parada pelo administrador' : 'concluída'}. ${results.reduce((a, r) => a + r.saved, 0)} ofertas gravadas.`);
    return lastRun;
  })();

  try {
    return await running;
  } finally {
    running = null;
    runningSince = null;
    parar = false;
  }
}

// Situação resumida e pública: só diz se está minerando agora (usada pela animação da Capi)
const statusPublico = () => {
  const intervalo = Math.round(Math.min(3600, Math.max(3, Number(settings.get('capi_intervalo_seg')) || 10)));
  return { minerando: Boolean(running), desde: runningSince, capi: { so_mineracao: settings.get('capi_so_mineracao') === '1', intervalo } };
};

function getState() {
  return {
    running: Boolean(running),
    parando: Boolean(running) && parar,
    lastRun,
    stores: STORES.map(st => ({
      id: st.id,
      name: st.name,
      method: st.method,
      automatic: st.automatic,
      ...(db.get('SELECT status, message, found, saved, last_run_at, last_success_at FROM store_status WHERE store_id = ?', st.id) || {}),
    })),
  };
}

// Agenda execuções periódicas; o intervalo é relido do painel a cada ciclo.
function startScheduler() {
  const schedule = delayMs => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try { await runMining(); } catch (err) { console.error('[MINER] erro inesperado:', err); }
      try { await require('./lojas').syncAllFeeds(); } catch (err) { console.error('[LOJAS] erro ao sincronizar feeds:', err); }
      schedule(Math.max(15, settings.getNumber('mining_interval_min', 120)) * 60 * 1000);
    }, delayMs);
  };
  schedule(10 * 1000);
}

module.exports = {
  minerarTermo, statusPublico, runMining, pararMineracao, getState, startScheduler };
