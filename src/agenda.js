// Postagens agendadas: nos horários do painel (padrão 09:00, 14:00 e 20:00, horário de Brasília) publica
// algumas ofertas (padrão 5) nas redes escolhidas — primeiro as da fila, depois as melhores do momento.
// Cada dono tem a sua agenda: o site (admin, cid = null) e cada cliente da ferramenta (cid = id do cliente),
// com a própria fila, os próprios canais e os próprios links de afiliado.
const db = require('./db');
const settings = require('./settings');
const offers = require('./offers');
const social = require('./social');
const clientes = require('./clientes');
const whatsapp = require('./whatsapp');
const precoNaHora = require('./preco-na-hora');
const avisos = require('./envio-avisos');

// Grupos escolhidos para cada oferta da fila: { grupos, por_tipo } (vazio = os grupos salvos no painel)
if (!db.all('PRAGMA table_info(post_queue)').some(c => c.name === 'destino')) db.db.exec('ALTER TABLE post_queue ADD COLUMN destino TEXT');
const lerDestino = v => { try { return v ? JSON.parse(v) : null; } catch { return null; } };

let timer = null;
let pausaEntreOfertas = true; // os testes desligam a pausa
// Foto recusada pela loja: a oferta dá lugar a outra e só é tentada de novo depois de um tempo (a recusa pode passar)
const fotosRecusadas = new Map(); // oferta → até quando evitar
const ESPERA_FOTO_MS = 2 * 3600000;
// Foto que não vende: pequena demais (fica borrada no celular) ou em formato de faixa/banner (o produto some)
async function fotoRuim(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  let m;
  try { m = await require('sharp')(buffer).metadata(); } catch { return null; }
  const menor = Math.min(m.width || 0, m.height || 0), proporcao = (m.width || 1) / (m.height || 1);
  if (menor && menor < 300) return `foto pequena demais (${m.width}x${m.height})`;
  if (proporcao > 2 || proporcao < 0.45) return `foto em formato de faixa (${m.width}x${m.height})`;
  return null;
}
const fotoRecusada = id => { const ate = fotosRecusadas.get(id); if (ate && ate <= Date.now()) fotosRecusadas.delete(id); return Boolean(ate && ate > Date.now()); };
const rodando = new Set();          // donos com rodada em andamento ('site' ou id do cliente)
const ultimaExecucao = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = msg => console.log(`[AGENDA] ${msg}`);
const dono = cid => (cid ? Number(cid) : 'site');
const configDe = cid => (cid ? clientes.config(cid) : settings.getAll());

// Data e hora em Brasília (UTC-3, sem horário de verão desde 2019).
function agoraBrasilia() {
  const d = new Date(Date.now() - 3 * 3600 * 1000);
  return { dia: d.toISOString().slice(0, 10), minutos: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

function horarios(s = settings.getAll()) {
  return String(s.agenda_horarios || '')
    .split(/[,;\s]+/)
    .map(h => h.match(/^(\d{1,2}):(\d{2})$/))
    .filter(m => m && Number(m[1]) < 24 && Number(m[2]) < 60)
    .map(m => `${m[1].padStart(2, '0')}:${m[2]}`)
    .filter((h, i, a) => a.indexOf(h) === i)
    .sort();
}

function redesAgenda(s = settings.getAll()) {
  try { const r = JSON.parse(s.agenda_redes || '[]'); return Array.isArray(r) ? r.filter(id => social.REDES[id]) : []; } catch { return []; }
}

// Horários que já rodaram hoje (do site em settings; de cada cliente em cliente_config).
function lerFeitas(cid) {
  const raw = cid ? db.get(`SELECT value FROM cliente_config WHERE cliente_id = ? AND key = 'agenda_ultimas'`, cid)?.value : settings.get('agenda_ultimas');
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}
function gravarFeitas(cid, feitas) {
  if (!cid) return settings.set('agenda_ultimas', JSON.stringify(feitas));
  db.run(`INSERT INTO cliente_config (cliente_id, key, value) VALUES (?, 'agenda_ultimas', ?)
          ON CONFLICT(cliente_id, key) DO UPDATE SET value = excluded.value`, cid, JSON.stringify(feitas));
}

// ── Fila ─────────────────────────────────────────────────────────────────────
function enfileirar(itens, autor, cid = null) {
  let n = 0;
  for (const it of itens.slice(0, 200)) {
    const id = Number(it.offer_id);
    if (!Number.isInteger(id) || id <= 0 || !db.get('SELECT 1 FROM offers WHERE id = ?', id)) continue;
    // Não duplica uma oferta que já está esperando: atualiza o texto.
    const ja = db.get(`SELECT id FROM post_queue WHERE offer_id = ? AND status = 'pendente' AND cliente_id IS ?`, id, cid);
    const texto = String(it.texto || '').trim().slice(0, 4000) || null;
    const destino = it.destino ? JSON.stringify(it.destino) : null;
    const prioridade = it.prioridade ? 1 : 0;
    // Pedida de novo: volta para a frente (vale como recém-chegada)
    if (ja) db.run(`UPDATE post_queue SET texto = ?, autor = ?, destino = ?, prioridade = MAX(prioridade, ?), created_at = datetime('now') WHERE id = ?`, texto, autor, destino, prioridade, ja.id);
    else db.run('INSERT INTO post_queue (offer_id, texto, autor, cliente_id, destino, prioridade) VALUES (?, ?, ?, ?, ?, ?)', id, texto, autor, cid, destino, prioridade);
    n++;
  }
  if (n) arrumarFila(cid);
  return n;
}

function listarFila(cid = null, limit = 200) {
  return db.all(
    `SELECT q.*, o.produto, o.preco_atual, o.desconto_pct, o.imagem, o.original_url FROM post_queue q LEFT JOIN offers o ON o.id = q.offer_id
     WHERE q.cliente_id IS ?
     ORDER BY CASE q.status WHEN 'pendente' THEN 0 ELSE 1 END, CASE q.status WHEN 'pendente' THEN -q.prioridade ELSE 0 END, CASE q.status WHEN 'pendente' THEN q.created_at END DESC, CASE q.status WHEN 'pendente' THEN q.id ELSE -q.id END LIMIT ?`, cid, limit);
}
const removerDaFila = (id, cid = null) => db.run(`DELETE FROM post_queue WHERE id = ? AND status = 'pendente' AND cliente_id IS ?`, id, cid);
const limparFila = (cid = null) => db.run(`DELETE FROM post_queue WHERE status = 'pendente' AND cliente_id IS ?`, cid).changes;
const pendentes = (cid = null) => db.get(`SELECT COUNT(*) AS n FROM post_queue WHERE status = 'pendente' AND cliente_id IS ?`, cid).n;

// Filtros das ofertas automáticas (Painel → Redes sociais → Agendamento): lojas escolhidas, palavras que nunca
// entram (ex.: capinha, película) e, se preenchidas, palavras obrigatórias (só entra o que tiver pelo menos uma).
const semAcento = v => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const listaPalavras = v => String(v || '').split(/[,;\n]+/).map(semAcento).map(x => x.trim()).filter(Boolean);
function filtroDoDono(s) {
  const lojas = String(s.agenda_lojas || '').split(/[,;\s]+/).filter(Boolean);
  const bloqueadas = listaPalavras(s.agenda_palavras_bloqueadas);
  const permitidas = listaPalavras(s.agenda_palavras_permitidas);
  return o => {
    if (lojas.length && !lojas.includes(o.store_id)) return false;
    const nome = semAcento(o.produto);
    if (bloqueadas.some(w => nome.includes(w))) return false;
    if (permitidas.length && !permitidas.some(w => nome.includes(w))) return false;
    return true;
  };
}

// Repetição: só produto novo vai para os grupos. O que já foi postado nos últimos 30 dias (mesmo por outro vendedor) não
// volta, nem com preço novo: a mudança de preço só atualiza a oferta no site.
const DIAS_SEM_REPETIR = 30;
const PALAVRAS_VAZIAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'com', 'para', 'por', 'em', 'a', 'o', 'as', 'os', 'kit', 'novo', 'original']);
// Mesmo produto com outro título ou vendedor: as 6 primeiras palavras que importam, em qualquer ordem
function impressaoDoProduto(nome) {
  const palavras = semAcento(nome).replace(/[^a-z0-9]+/g, ' ').split(' ').filter(p => p && !PALAVRAS_VAZIAS.has(p)).slice(0, 6);
  return [...new Set(palavras)].sort().join(' ');
}
function regraDeRepeticao(cid) {
  const porId = new Set(), porNome = new Set();
  for (const p of db.all(`SELECT offer_id, produto FROM social_posts WHERE ok = 1 AND cliente_id IS ? AND created_at > datetime('now', ?)`, cid, `-${DIAS_SEM_REPETIR} days`)) {
    porId.add(p.offer_id);
    porNome.add(impressaoDoProduto(p.produto));
  }
  return { porOferta: o => porId.has(o.id), porProduto: o => porNome.has(impressaoDoProduto(o.produto)) };
}

// ── Fila sempre curta e atual ────────────────────────────────────────────────
// Oferta que espera demais pode ter mudado ou acabado, e uma fila enorme atrasa as novas. Então: sai da fila o que
// esperou mais que agenda_fila_horas e, passando de agenda_fila_max, saem as mais antigas. A fila anda das mais novas
// para as mais antigas (relâmpago sempre na frente).
const numeroEntre = (v, pad, min, max) => { const n = parseInt(v, 10); return Math.min(Math.max(Number.isFinite(n) ? n : pad, min), max); };
function arrumarFila(cid = null, s = configDe(cid)) {
  const horas = numeroEntre(s.agenda_fila_horas, 6, 1, 72);
  const max = numeroEntre(s.agenda_fila_max, 20, 1, 200);
  let saiu = db.run(`UPDATE post_queue SET status = 'expirado', resultado = ? WHERE status = 'pendente' AND cliente_id IS ? AND created_at < datetime('now', ?)`,
    `Esperou mais de ${horas} h na fila: saiu para dar lugar a ofertas mais novas.`, cid, `-${horas} hours`).changes;
  const sobra = db.all(`SELECT id FROM post_queue WHERE status = 'pendente' AND cliente_id IS ? ORDER BY prioridade DESC, created_at DESC, id LIMIT -1 OFFSET ?`, cid, max);
  for (const q of sobra) db.run(`UPDATE post_queue SET status = 'expirado', resultado = ? WHERE id = ?`, `A fila passou de ${max} ofertas: saíram as mais antigas.`, q.id);
  saiu += sobra.length;
  return saiu;
}

// Melhores ofertas do momento: as de maior nota (chance de venda + comissão extra, sem descontos suspeitos), categorias
// variadas, sem repetir produto (regra acima), respeitando os filtros do dono. Para o afiliado, só das lojas em que ele já
// tem link de afiliado (postar das outras não rende comissão).
// Grupos por tipo e loja: cada grupo com escolha tem a vez de receber a melhor oferta dele. soTemas: nada que nenhum grupo
// receba (quando o WhatsApp é a única rede). girar: passa a vez para o próximo grupo.
const vezDoTema = new Map();
function melhoresOfertas(qtd, excluir, cid = null, s = configDe(cid), { soTemas = false, girar = false } = {}) {
  const passa = filtroDoDono(s);
  const repeticao = regraDeRepeticao(cid);
  const grupos = whatsapp.gruposEscolhidos(s);
  const comTema = grupos.filter(g => g.categorias.length || g.lojas.length);
  const soDosGrupos = soTemas && grupos.length && comTema.length === grupos.length;
  const pagas = cid ? new Set(clientes.lojasComAfiliado(s)) : null;
  const limite = Date.now() - 12 * 3600000;
  // Só produto novo: encontrado pela primeira vez nas últimas agenda_novas_horas (0 = qualquer um ainda não postado)
  const horasNovas = numeroEntre(s.agenda_novas_horas, 24, 0, 720);
  const desde = horasNovas ? Date.now() - horasNovas * 3600000 : 0;
  const quando = v => Date.parse(`${String(v).replace(' ', 'T')}Z`) || 0;
  let rows = require('./busca-ofertas').paraPostar(o => !repeticao.porOferta(o) && !excluir.has(o.id) && passa(o)
    && (!soDosGrupos || grupos.some(g => whatsapp.grupoRecebe(g, o.categoria, o.store_id))) && quando(o.last_seen_at) > limite
    && quando(o.created_at) >= desde && (!pagas?.size || pagas.has(o.store_id)));
  // Só produto com cara de viral (src/nota-grupos.js): nota mínima do painel; as de nota maior vão primeiro
  const notas = require('./nota-grupos');
  const ctx = notas.contexto(cid);
  const minima = numeroEntre(s.agenda_nota_minima, 60, 0, 100);
  rows = rows.map(o => ({ o, nota: notas.notaGrupo(o, ctx).nota })).filter(x => x.nota >= minima - 4) // foto ainda não conta
    .sort((a, b) => b.nota - a.nota).slice(0, 1500).map(x => x.o);
  // Só com foto pública (a postagem sai com a imagem); a loja da foto entra na nota
  const fotos = new Map();
  for (let i = 0; i < rows.length; i += 500) {
    const ids = rows.slice(i, i + 500).map(r => r.id);
    for (const r of db.all(`SELECT id, imagem FROM offers WHERE id IN (${ids.map(() => '?').join(',')}) AND imagem LIKE 'https://%'`, ...ids)) fotos.set(r.id, r.imagem);
  }
  rows = rows.filter(r => fotos.has(r.id)).map(o => ({ o, nota: notas.notaGrupo({ ...o, imagem: fotos.get(o.id) }, ctx).nota }))
    .filter(x => x.nota >= minima).sort((a, b) => b.nota - a.nota).map(x => x.o);
  const vistos = new Set(); // o mesmo produto de vendedores diferentes entra uma vez só
  rows = rows.filter(r => {
    const k = impressaoDoProduto(r.produto);
    if (vistos.has(k) || repeticao.porProduto(r)) return false;
    vistos.add(k);
    return true;
  });
  const out = [], cats = new Set();
  if (comTema.length) {             // cada grupo com tema, na sua vez
    const inicio = vezDoTema.get(dono(cid)) || 0;
    if (girar) vezDoTema.set(dono(cid), inicio + 1);
    for (let i = 0; i < comTema.length && out.length < qtd; i++) {
      const g = comTema[(inicio + i) % comTema.length];
      const r = rows.find(x => whatsapp.grupoRecebe(g, x.categoria, x.store_id) && !out.includes(x.id) && offers.isActive(x.id));
      if (r) { out.push(r.id); cats.add(r.categoria); }
    }
  }
  for (const r of rows) {           // primeiro uma por categoria
    if (out.length >= qtd) break;
    if (cats.has(r.categoria) || out.includes(r.id) || !offers.isActive(r.id)) continue;
    cats.add(r.categoria); out.push(r.id);
  }
  for (const r of rows) {           // completa se faltar
    if (out.length >= qtd) break;
    if (!out.includes(r.id) && offers.isActive(r.id)) out.push(r.id);
  }
  return out;
}

// ── Execução ─────────────────────────────────────────────────────────────────
async function executar(motivo = 'agendado', cid = null, qtdForcada = null, { soRelampago = false } = {}) {
  const d = dono(cid);
  if (rodando.has(d)) return { erro: 'Já existe uma postagem agendada em andamento.' };
  const s = configDe(cid);
  const prontas = redesAgenda(s).filter(id => !social.REDES[id].pronta(s));
  if (!prontas.length) {
    const erro = 'Nenhuma rede do agendamento está configurada.';
    if (motivo !== 'manual') avisos.avisar(cid, { tipo: 'sem-rede', titulo: 'As postagens agendadas não saíram', texto: `${erro} Confira as redes e os grupos no painel.` });
    return { erro };
  }
  rodando.add(d);
  const qtd = qtdForcada || Math.min(Math.max(parseInt(s.agenda_qtd, 10) || 5, 1), 20);
  const intervalo = prontas.includes('whatsapp') ? Math.min(Math.max(Number(s.whatsapp_intervalo_s) || 90, 20), 900) * 1000 : 5000;
  const feitos = [];
  let conferidos = 0;
  const pulados = [];
  const quem = cid ? `cliente ${cid}` : 'site';
  const soWhatsapp = prontas.length === 1 && prontas[0] === 'whatsapp';
  try {
    // 1) fila, das mais novas para as mais antigas (pula ofertas que saíram do ar); 2) completa com as melhores ofertas novas
    arrumarFila(cid, s);
    const fila = db.all(`SELECT * FROM post_queue WHERE status = 'pendente' AND cliente_id IS ? ${soRelampago ? 'AND prioridade = 1' : ''} ORDER BY prioridade DESC, created_at DESC, id`, cid);
    const usadas = new Set(fila.map(q => q.offer_id));
    for (const id of [...fotosRecusadas.keys()]) if (fotoRecusada(id)) usadas.add(id);
    let posFila = 0;
    let candidatas = null;
    let recargas = 0, fotosNestaLeva = 0;
    const proxima = () => {
      while (posFila < fila.length) {
        const q = fila[posFila++];
        if (q.prioridade && !require('./relampago').estaAtiva(q.offer_id)) {
          db.run(`UPDATE post_queue SET status = 'expirado', resultado = 'A oferta relâmpago terminou antes de ser postada.' WHERE id = ?`, q.id);
          continue;
        }
        if (!offers.isActive(q.offer_id)) {
          db.run(`UPDATE post_queue SET status = 'expirado', resultado = 'Oferta saiu do ar antes de ser postada.' WHERE id = ?`, q.id);
          continue;
        }
        // Antes de postar: oferta automática precisa ter o preço conferido na loja nas últimas 24 h
        const v = db.get("SELECT fonte, last_seen_at < datetime('now', '-24 hours') AS velha FROM offers WHERE id = ?", q.offer_id);
        if (v && v.fonte === 'auto' && v.velha) {
          db.run(`UPDATE post_queue SET status = 'expirado', resultado = 'Preço não conferido na loja nas últimas 24 h (pode ter mudado).' WHERE id = ?`, q.id);
          continue;
        }
        return { fila: q.id, offer_id: q.offer_id, texto: q.texto, destino: lerDestino(q.destino), relampago: Boolean(q.prioridade) };
      }
      if (soRelampago || s.agenda_completar === '0') return null;
      // Pega algumas a mais: as que tiverem mudado de preço na loja dão lugar à seguinte
      // Acabaram as candidatas porque as lojas recusaram as fotos: busca mais, até duas vezes
      if (candidatas && !candidatas.length && fotosNestaLeva && recargas < 2) { recargas++; fotosNestaLeva = 0; candidatas = null; }
      if (!candidatas) {
        const faltam = qtd - feitos.length;
        candidatas = melhoresOfertas(faltam * 3 + 5, usadas, cid, s, { soTemas: soWhatsapp, girar: true }).map(id => ({ offer_id: id, texto: null }));
      }
      const c = candidatas.shift() || null;
      if (c) usadas.add(c.offer_id);
      return c;
    };
    const temMais = () => posFila < fila.length || (!soRelampago && s.agenda_completar !== '0' && (candidatas === null || candidatas.length > 0));
    const descartar = (it, motivoPulo) => {
      if (it.fila) db.run(`UPDATE post_queue SET status = 'expirado', resultado = ? WHERE id = ?`, motivoPulo, it.fila);
      pulados.push({ offer_id: it.offer_id, motivo: motivoPulo });
    };
    log(`${quem} — ${motivo}: até ${qtd} oferta(s) em ${prontas.join(', ')}`);

    let it;
    while (feitos.length < qtd && (it = proxima())) {
      const alvo = db.get('SELECT categoria, store_id FROM offers WHERE id = ?', it.offer_id) || {};
      const sItem = it.destino?.grupos?.length ? whatsapp.comDestinos(s, it.destino.grupos, it.destino.por_tipo !== false) : s;
      const redes = prontas.filter(id => id !== 'whatsapp' || whatsapp.gruposDaOferta(sItem, alvo.categoria, alvo.store_id).length);
      if (!redes.length) { descartar(it, 'Nenhum grupo de destino recebe ofertas deste tipo e desta loja.'); continue; }
      // WhatsApp: a mensagem sai com a foto. Se a loja não entregar, nada vai ao grupo e entra a oferta seguinte.
      let foto = null;
      if (redes.includes('whatsapp')) {
        const motivoFoto = 'A loja recusou a foto: entrou outra oferta no lugar.';
        const endereco = social.postImage(db.get('SELECT imagem FROM offers WHERE id = ?', it.offer_id) || {}, s);
        if (endereco && fotoRecusada(it.offer_id)) { descartar(it, motivoFoto); fotosNestaLeva++; pulados[pulados.length - 1].foto = true; continue; }
        if (endereco) {
          try {
            foto = await whatsapp.fotoParaEnvio(endereco);
          } catch (err) {
            log(`${quem}: foto da oferta ${it.offer_id} recusada (${err.message})`);
            fotosRecusadas.set(it.offer_id, Date.now() + ESPERA_FOTO_MS);
            descartar(it, motivoFoto); fotosNestaLeva++; pulados[pulados.length - 1].foto = true;
            continue;
          }
          // Foto que não vende (pequena ou em faixa): a oferta não vai, e não volta a ser escolhida por uma semana
          const ruim = await fotoRuim(foto);
          if (ruim) {
            fotosRecusadas.set(it.offer_id, Date.now() + 7 * 86400000);
            descartar(it, `Foto ruim para o grupo (${ruim}): entrou outra oferta no lugar.`); fotosNestaLeva++;
            foto = null;
            continue;
          }
        }
      }
      const conferencia = await precoNaHora.conferir(it.offer_id);
      if (conferencia.acao === 'pular') { descartar(it, conferencia.motivo); continue; }
      if (conferencia.situacao !== 'sem_checagem') conferidos++;
      const o = db.get('SELECT * FROM offers WHERE id = ?', it.offer_id);
      // Texto da fila com o preço antigo: refaz pelo modelo, com o preço de agora
      if (it.texto && conferencia.precoAntigo && it.texto.includes(Number(conferencia.precoAntigo).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))) it.texto = null;
      const link = cid ? await clientes.linkParaPostar(cid, o, s) : null; // cliente: link de afiliado dele
      if (link) o.__link = link;
      if (!it.texto) o.__link = await require('./encurtador').curto(social.postLink(o, s)); // link curto no post
      const texto = it.texto || (it.relampago ? require('./relampago').textoDaPostagem(o, s) : social.textoPadrao(o, s));
      let resultados;
      try { resultados = await social.publicar(it.offer_id, redes, texto, `agenda (${motivo})`, { s: sItem, foto, ...(cid ? { clienteId: cid, link } : {}) }); }
      catch (err) { resultados = [{ rede: '-', ok: false, mensagem: err.message }]; }
      const ok = resultados.some(r => r.ok);
      const resumo = resultados.map(r => `${social.REDES[r.rede]?.nome || r.rede}: ${r.ok ? 'ok' : r.mensagem}`).join(' | ');
      if (it.fila) db.run(`UPDATE post_queue SET status = ?, resultado = ?, posted_at = datetime('now') WHERE id = ?`, ok ? 'postado' : 'erro', resumo, it.fila);
      feitos.push({ offer_id: it.offer_id, produto: o.produto, ok, resumo });
      if (pausaEntreOfertas && feitos.length < qtd && temMais()) await sleep(intervalo);
    }
  } finally {
    rodando.delete(d);
  }
  const r = { em: new Date().toISOString(), motivo, feitos, conferidos, pulados };
  ultimaExecucao.set(d, r);
  log(`${quem} — concluído: ${feitos.filter(f => f.ok).length} de ${feitos.length} publicadas, ${conferidos} com preço conferido na hora, ${pulados.length} puladas`);
  avisos.avaliarRodada(cid, feitos);
  if (!feitos.length && pulados.some(p => p.foto)) {
    avisos.avisar(cid, { tipo: 'foto', titulo: 'As lojas recusaram as fotos desta rodada', texto: `${pulados.filter(p => p.foto).length} oferta(s) foram trocadas e não sobrou outra para postar. Nada foi enviado aos grupos.` });
  } else if (!feitos.length && motivo !== 'manual' && !soRelampago) {
    avisos.avisar(cid, { tipo: 'sem-ofertas', titulo: 'Rodada de postagens sem nenhuma oferta', texto: 'Nenhuma oferta passou pelos filtros, temas e pela regra de repetição. Confira o agendamento no painel.' });
  }
  return r;
}

// Confere a cada minuto se chegou a hora de cada dono (site e clientes com acesso válido); cada horário roda
// uma vez por dia (até 2 horas de atraso, caso o computador estivesse desligado na hora).
// Modo contínuo: entre o início e o fim do dia, uma rodada pequena (agenda_por_vez) a cada X a Y minutos, com
// intervalo sorteado a cada vez (ritmo de gente, não de robô).
const proximoContinuo = new Map(); // dono → hora (ms) do próximo envio
const hhmm = v => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
function sortearIntervalo(s) {
  const a = Math.min(Math.max(parseInt(s.agenda_intervalo_min, 10) || 20, 5), 720);
  const b = Math.max(a, Math.min(parseInt(s.agenda_intervalo_max, 10) || a, 720));
  return (a + Math.random() * (b - a)) * 60000;
}
function verificarContinuo(cid, s) {
  const { minutos } = agoraBrasilia();
  const ini = hhmm(s.agenda_inicio) ?? 8 * 60, fim = hhmm(s.agenda_fim) ?? 22 * 60;
  const dentro = ini <= fim ? minutos >= ini && minutos < fim : minutos >= ini || minutos < fim; // fim depois da meia-noite
  const d = dono(cid);
  if (!dentro) { proximoContinuo.delete(d); return; }
  const prox = proximoContinuo.get(d);
  if (prox === undefined) { proximoContinuo.set(d, Date.now() + Math.random() * 60000); return; } // começa no 1º minuto
  if (Date.now() < prox) return;
  proximoContinuo.set(d, Date.now() + sortearIntervalo(s));
  const porVez = Math.min(Math.max(parseInt(s.agenda_por_vez, 10) || 1, 1), 5);
  executar('modo contínuo', cid, porVez).catch(err => log(`erro: ${err.message}`));
}

// Lista de cupons: cada horário roda uma vez por dia, ligada ou não ao agendamento das ofertas
function verificarCupons(cid, s) {
  if (s.agenda_cupons_ativa !== '1') return;
  const { dia, minutos } = agoraBrasilia();
  const feitas = lerFeitas(cid);
  for (const h of horarios({ agenda_horarios: s.agenda_cupons_horarios })) {
    const [hh, mm] = h.split(':').map(Number);
    const alvo = hh * 60 + mm, chave = `cupons ${h}`;
    if (minutos < alvo || minutos > alvo + 120 || feitas[chave] === dia) continue;
    feitas[chave] = dia;
    gravarFeitas(cid, feitas);
    require('./lista-cupons').postar(cid, `horário ${h}`).then(r => {
      log(`cupons (${cid ? `cliente ${cid}` : 'site'}): ${r.enviados} grupo(s), ${r.falhas.length} com falha`);
      if (r.falhas.length) avisos.avisar(cid, { tipo: 'cupons', titulo: 'A lista de cupons falhou em alguns grupos', texto: r.falhas.map(f => `${f.grupo}: ${f.erro}`).join('; ').slice(0, 500) });
    }).catch(err => {
      log(`cupons: ${err.message}`);
      avisos.avisar(cid, { tipo: 'cupons', titulo: 'A lista de cupons não saiu', texto: err.message });
    });
    break;
  }
}

function verificarDono(cid) {
  const s = configDe(cid);
  arrumarFila(cid, s);
  verificarCupons(cid, s);
  if (s.agenda_ativa !== '1' || rodando.has(dono(cid))) return;
  if (s.agenda_modo === 'continuo') return verificarContinuo(cid, s);
  const { dia, minutos } = agoraBrasilia();
  const feitas = lerFeitas(cid);
  for (const h of horarios(s)) {
    const [hh, mm] = h.split(':').map(Number);
    const alvo = hh * 60 + mm;
    if (minutos < alvo || minutos > alvo + 120 || feitas[h] === dia) continue;
    feitas[h] = dia;
    gravarFeitas(cid, feitas);
    executar(`horário ${h}`, cid).catch(err => log(`erro: ${err.message}`));
    break;
  }
}

function verificar() {
  verificarDono(null);
  for (const c of db.all(`SELECT id FROM clientes WHERE status = 'ativo' AND validade >= datetime('now')`)) verificarDono(c.id);
}

function iniciar() {
  require('./envio-grupos').iniciar();
  avisos.iniciar();
  clearInterval(timer);
  timer = setInterval(verificar, 60 * 1000);
  setTimeout(verificar, 15 * 1000);
}

function estado(cid = null) {
  const s = configDe(cid);
  const { dia, minutos } = agoraBrasilia();
  const feitas = lerFeitas(cid);
  const lista = horarios(s);
  const proximo = lista.find(h => { const [a, b] = h.split(':').map(Number); return a * 60 + b > minutos && feitas[h] !== dia; }) || lista[0] || null;
  const continuo = s.agenda_modo === 'continuo';
  const prox = proximoContinuo.get(dono(cid));
  const proxTxt = prox ? new Date(prox - 3 * 3600 * 1000).toISOString().slice(11, 16) : null;
  return {
    ativa: s.agenda_ativa === '1', modo: continuo ? 'continuo' : 'horarios',
    horarios: continuo ? [`${s.agenda_inicio || '08:00'}–${s.agenda_fim || '22:00'}, a cada ${s.agenda_intervalo_min || 20}–${s.agenda_intervalo_max || 40} min`] : lista,
    proximo: continuo ? proxTxt : proximo, rodando: rodando.has(dono(cid)), pendentes: pendentes(cid),
    ultimaExecucao: ultimaExecucao.get(dono(cid)) || null, redes: redesAgenda(s), problema: avisos.problema(cid),
  };
}

// Só para os testes
const _paraTestes = ({ pausa, limparFotos } = {}) => { if (pausa !== undefined) pausaEntreOfertas = pausa; if (limparFotos) fotosRecusadas.clear(); };

module.exports = { regraDeRepeticao, arrumarFila, redesAgenda, _paraTestes, impressaoDoProduto, enfileirar, listarFila, removerDaFila, limparFila, pendentes, executar, iniciar, estado, horarios, melhoresOfertas, filtroDoDono };
