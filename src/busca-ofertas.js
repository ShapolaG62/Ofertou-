// Busca da página de ofertas feita no servidor: o navegador recebe só a página que está vendo (24 ofertas) e os
// números dos filtros, em vez de baixar todas as ~50 mil ofertas. As regras são as mesmas que a página usava:
// filtros por loja, categoria, tipo, preço e desconto; busca por palavras (sem acento e sem hífen); relevância;
// ordenações; agrupamento por tipo; contagens de cada loja/categoria/tipo ignorando o próprio filtro.
const offers = require('./offers');
const db = require('./db');
const { classifyCategory } = require('./categorize');

const CATEGORIAS = {
  informatica: 'Informática', celulares: 'Celulares, tablets e relógios', games: 'Games',
  audio_tv: 'TV, áudio e casa inteligente', eletrodomesticos: 'Eletrodomésticos', cozinha: 'Cozinha e eletroportáteis',
  casa: 'Casa, móveis e decoração', ferramentas: 'Ferramentas e construção', beleza: 'Beleza e cuidados pessoais',
  saude: 'Saúde e bem-estar', esporte: 'Esporte e fitness', moda: 'Moda e acessórios', brinquedos: 'Bebês e brinquedos',
  automotivo: 'Automotivo', pets: 'Pet shop', limpeza: 'Limpeza', alimentos: 'Alimentos e bebidas', outros: 'Outros',
};
const POR_PAGINA = 24;
const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
const normalizar = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/-/g, ' ').replace(/\s+/g, ' ');
const quando = s => (s ? Date.parse(`${String(s).replace(' ', 'T')}Z`) || 0 : 0);

// ── Lista em memória (refeita quando as ofertas mudam, no máximo a cada 60 s) ──
let CACHE = { sig: null, at: 0, lista: [], ordenadas: {}, resumo: null };
let HIST = { at: 0, m: new Map() };
let NOMES = new Map(); // id → { p: nome, n: nome normalizado }
// Respostas prontas das buscas sem login (a página inicial é igual para todos): valem até a lista mudar
const RESPOSTAS = new Map();
const assinatura = () => {
  const r = db.get('SELECT COUNT(*) AS n, MAX(updated_at) AS u, MAX(last_seen_at) AS s, SUM(oculto) AS h, COUNT(comissao_pct) AS c, TOTAL(comissao_extra_pct) AS e, COUNT(cupom_codigo) AS k FROM offers');
  return `${r.n}|${r.u}|${r.s}|${r.h}|${r.c}|${r.e}|${r.k}`;
};
// Quem visita nunca espera a lista ser refeita: recebe a lista pronta e a atualização roda logo depois, em segundo plano.
// Com 120 mil ofertas a montagem leva ~4 s de processamento: em segundo plano ela roda em fatias curtas, deixando o
// servidor atender os outros pedidos entre uma fatia e outra (de uma vez só, travava o site inteiro durante a montagem).
const FATIA_MS = 25;
const PASSO_ID = 10000; // ofertas lidas do banco por vez (faixa de ids)
const PASSO_LISTA = 2000; // ofertas processadas entre uma verificação de tempo e outra
let emAndamento = null; // { passos, promessa } da montagem em segundo plano
let ultimaMontagem = 0;
const logErro = e => console.error('[BUSCA]', e.message);
const drenar = passos => { let r; do r = passos.next(); while (!r.done); return r.value; };
function emPartes() {
  if (emAndamento) return emAndamento.promessa;
  const passos = montagem();
  const promessa = new Promise((ok, erro) => {
    const parte = () => {
      try {
        const fim = performance.now() + FATIA_MS;
        for (;;) {
          if (passos.next().done) return ok(CACHE);
          if (performance.now() >= fim) break;
        }
        setImmediate(parte);
      } catch (e) { erro(e); }
    };
    setImmediate(parte);
  }).finally(() => { emAndamento = null; });
  emAndamento = { passos, promessa };
  return promessa;
}
function lista() {
  // Primeira vez e quem chamou não pode esperar (código síncrono): termina a montagem aqui mesmo
  if (!CACHE.sig) { if (emAndamento) drenar(emAndamento.passos); else montar(); return CACHE; }
  if (Date.now() - CACHE.at >= 60000 && !emAndamento) emPartes().catch(logErro);
  return CACHE;
}
// Rotas: enquanto a primeira lista não fica pronta, o pedido espera sem travar o servidor.
const pronta = () => (CACHE.sig ? Promise.resolve(CACHE) : emPartes());
function aguardar(req, res, next) {
  if (CACHE.sig) return next();
  emPartes().catch(logErro).then(() => next());
}
// Depois de gravar ofertas: refaz sem travar, incluindo o que acabou de entrar (a montagem em andamento pode ser anterior).
async function atualizar() {
  if (emAndamento) await emAndamento.promessa.catch(logErro);
  return emPartes();
}
// Desconto suspeito: não some do site, mas não vira destaque e cai na ordem (o motivo aparece no Painel → Ofertas).
const FALSIFICADO = /\b(replica|primeira linha|1:1|similar ao original|tipo original|estilo original)\b/;
function suspeita(o, h, n) {
  const d = o.desconto_pct, p = o.preco_atual;
  if (o.fonte !== 'auto') return '';
  if (FALSIFICADO.test(n)) return 'Parece réplica';
  if (/\bfalso\b|nao funciona|para exibicao|\bdummy\b/.test(n)) return 'Produto de exibição';
  if ((n.match(/\biphone \d+/g) || []).length >= 2 && !ACESSORIO_BUSCA.test(n)) return 'Vários modelos no mesmo anúncio';
  if (d >= 85) return `Desconto de ${d}%`;
  if (p < 15 && d >= 70) return `${d}% em produto de R$ ${p.toFixed(2).replace('.', ',')}`;
  // "De" que nunca vimos: há 7 dias ou mais de leituras e o preço nunca chegou nem a 40% do "de"
  if (h && d >= 60 && Date.parse(`${String(h.desde).replace(' ', 'T')}Z`) <= Date.now() - 7 * 86400000 && h.max30 * 2.5 < o.preco_anterior) {
    return 'Preço "de" nunca visto em 7+ dias';
  }
  return '';
}
// Anúncios com o nome idêntico: todos aparecem; o mais barato (ou os empatados) ganha "Menor preço entre N anúncios"
function* marcarIguais(rows) {
  const grupos = new Map();
  for (let i = 0; i < rows.length; i++) {
    const o = rows[i];
    if (i % PASSO_LISTA === 0) yield;
    if (o.loja_slug || o._k.length < 16) continue;
    const g = grupos.get(o._k);
    if (!g) grupos.set(o._k, { n: 1, menor: o.preco_atual });
    else { g.n++; if (o.preco_atual < g.menor) g.menor = o.preco_atual; }
  }
  for (let i = 0; i < rows.length; i++) {
    const o = rows[i];
    if (i % PASSO_LISTA === 0) yield;
    const g = !o.loja_slug && grupos.get(o._k);
    if (g && g.n > 1 && o.preco_atual === g.menor) o.iguais = g.n;
  }
}

// Monta a lista inteira, de uma vez. Para código que precisa dela já (a montagem em partes está em emPartes).
function montar() { return drenar(montagem()); }

// As etapas da montagem: cada "yield" é um ponto em que o servidor pode atender outros pedidos.
function* montagem() {
  const minha = ++ultimaMontagem;
  const sig = assinatura();
  if (sig === CACHE.sig) { CACHE.at = Date.now(); return CACHE; }
  yield;
  // Duas consultas simples juntadas aqui (a junção no SQL levava ~1,3 s com 100 mil ofertas e travava o servidor)
  const active = offers.activeClause();
  const maiorId = db.get('SELECT MAX(id) AS m FROM offers').m || 0;
  const brutas = [];
  for (let de = 0; de < maiorId; de += PASSO_ID) {
    brutas.push(...db.all(
      `SELECT o.id, o.store_id, o.plataforma, o.produto, o.preco_atual, o.preco_anterior, o.desconto_pct, o.categoria,
         o.subcategoria, o.link_clicks, o.fonte, o.created_at, o.last_seen_at, o.comissao_pct, o.comissao_extra_pct,
         o.cupom_codigo, o.cupom_texto, o.preco_sem_cupom, o.relampago_fim, o.relampago_tipo, o.relampago_fim_real, o.vendidos, o.avaliacao, l.slug AS loja_slug
       FROM offers o LEFT JOIN lojas l ON l.id = o.loja_id WHERE o.id > ? AND o.id <= ? AND ${active.sql}`, de, de + PASSO_ID, ...active.params));
    yield;
  }
  // Menor preço dos últimos 30 dias: refeito a cada 10 min (o selo não precisa ser ao segundo)
  if (Date.now() - HIST.at > 10 * 60 * 1000) {
    const m = new Map();
    for (let de = 0; de < maiorId; de += PASSO_ID) {
      for (const h of db.all(`SELECT offer_id, MIN(price) AS min30, MAX(price) AS max30, MIN(checked_at) AS desde, COUNT(*) AS n FROM price_history
                              WHERE offer_id > ? AND offer_id <= ? AND checked_at >= datetime('now', '-30 days') GROUP BY offer_id`, de, de + PASSO_ID)) m.set(h.offer_id, h);
      yield;
    }
    HIST = { at: Date.now(), m };
  }
  const hist = HIST.m;
  const seteDias = Date.now() - 7 * 86400000;
  const memo = new Map();
  const linha = o => {
    const h = hist.get(o.id);
    // O que depende só do nome e da data de entrada (nome normalizado, "em alta", acessório) é guardado e só
    // refeito quando o nome muda: era ~1 s de cada montagem
    let m = NOMES.get(o.id);
    if (!m || m.p !== o.produto || m.ca !== o.created_at) {
      const n = normalizar(o.produto);
      // k: chave das ordens por nome (só letras e números; nome só com símbolos ou letras decoradas vai para o fim)
      m = { p: o.produto, ca: o.created_at, n, k: n.replace(/[^a-z0-9 ]+/g, '').trim(), t: ` ${n.replace(/[^a-z0-9]+/g, ' ').trim()} `, c: quando(o.created_at),
        alta: EM_ALTA.some(k => n.includes(k)), acess: ACESSORIO.test(n.slice(0, 40)) };
    }
    memo.set(o.id, m);
    const n = m.n, c = m.c;
    return {
      id: o.id, store_id: o.store_id, plataforma: o.plataforma, produto: o.produto, preco_atual: o.preco_atual,
      preco_anterior: o.preco_anterior, desconto_pct: o.desconto_pct, categoria: o.categoria, subcategoria: o.subcategoria,
      link_clicks: o.link_clicks || 0, fonte: o.fonte, created_at: o.created_at, last_seen_at: o.last_seen_at,
      loja_slug: o.loja_slug || null,
      menor_preco_30d: h && h.n >= 2 && c <= seteDias && o.preco_atual <= h.min30 ? 1 : 0,
      comissao_pct: o.comissao_pct ?? null, comissao_extra_pct: o.comissao_extra_pct > 0 ? o.comissao_extra_pct : 0,
      ...(o.cupom_codigo ? { cupom: o.cupom_codigo, cupom_texto: o.cupom_texto, preco_sem_cupom: o.preco_sem_cupom } : {}),
      ...(o.relampago_fim ? { relampago_fim: o.relampago_fim, relampago_tipo: o.relampago_tipo, relampago_fim_real: o.relampago_fim_real } : {}),
      _n: n, _k: m.k, _t: m.t, _c: c, _alta: m.alta, _acess: m.acess, _susp: suspeita(o, h, n), _v: o.vendidos ?? null, _a: o.avaliacao ?? null,
    };
  };
  const rows = [];
  for (let i = 0; i < brutas.length; i++) {
    rows.push(linha(brutas[i]));
    if (i % PASSO_LISTA === 0) yield;
  }
  yield* marcarIguais(rows);
  rows.sort((a, b) => (b._c - a._c) || b.id - a.id); // mais novas primeiro (ordem base, como antes)
  yield;
  for (let i = 0; i < rows.length; i++) {
    rows[i]._s = atratividade(rows[i]);
    if (i % PASSO_LISTA === 0) yield;
  }
  // Resumo do topo da página: total, lojas, maior desconto, última conferência e a oferta de maior desconto
  let maior = 0, ultima = '', melhor = null;
  const lojas = new Set();
  for (let i = 0; i < rows.length; i++) {
    const o = rows[i];
    if (i % PASSO_LISTA === 0) yield;
    lojas.add(o.store_id);
    if (!o._susp && o.desconto_pct > maior) maior = o.desconto_pct;
    if (o.last_seen_at > ultima) ultima = o.last_seen_at; // mesmo formato de texto: compara direto
    if (!o._susp && o.desconto_pct >= 30 && o.preco_atual >= 40 && (LOJA_CONFIANCA[o.store_id] ?? 0) >= 6 && !o._acess
      && (!melhor || o.desconto_pct > melhor.desconto_pct)) melhor = o;
  }
  if (minha !== ultimaMontagem) return CACHE; // outra mais nova começou e terminou enquanto esta rodava: fica a mais nova
  NOMES = memo;
  RESPOSTAS.clear();
  CACHE = { sig, at: Date.now(), lista: rows, ordenadas: {}, resumo: {
    total: rows.length, lojas: lojas.size, maior_desconto: maior,
    ultima_conferencia: ultima || null,
    destaque: melhor ? semComissao(melhor) : null,
  } };
  return CACHE;
}
const publico = o => { const { _n, _k, _t, _c, _s, _alta, _acess, _susp, _v, _a, ...r } = o; return r; };
// Quem visita não vê a comissão de afiliado (só o admin e os afiliados com a ferramenta de postagem)
const semComissao = o => { const { comissao_pct, comissao_extra_pct, ...r } = publico(o); return r; };

// ── Termos da busca: cada palavra casa com o INÍCIO de uma palavra do nome ("tv" não casa com "ativo", "lg" não casa
// com "algodão"), aceita sinônimos e plural; número precisa ser o número inteiro ("15" não casa com "150").
const PALAVRAS_VAZIAS = new Set(['de', 'da', 'do', 'das', 'dos', 'para', 'pra', 'com', 'e', 'a', 'o', 'em', 'p']);
const SINONIMOS = {
  tv: ['televisao', 'televisor'], televisao: ['tv', 'televisor'], celular: ['smartphone', 'iphone'], smartphone: ['celular'],
  geladeira: ['refrigerador'], refrigerador: ['geladeira'], notebook: ['laptop'], laptop: ['notebook'],
  ps5: ['playstation 5'], ps4: ['playstation 4'], fone: ['headphone', 'headset', 'earbud'], airfryer: ['air fryer'],
  microondas: ['micro ondas'], relogio: ['smartwatch'], camisa: ['camiseta'], tenis: ['sapatenis'],
};
function termosDe(q) {
  return normalizar(q).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w && !PALAVRAS_VAZIAS.has(w)).map(w => {
    const alts = [w, ...(SINONIMOS[w] || [])];
    if (w.length > 4 && w.endsWith('s')) alts.push(w.slice(0, -1)); // plural
    return alts;
  });
}
function temPalavra(t, w) {
  const alvo = ` ${w}`;
  let i = t.indexOf(alvo);
  if (!/\d$/.test(w)) return i >= 0;
  while (i >= 0) { // número: o caractere seguinte não pode ser outro dígito
    const c = t[i + alvo.length];
    if (!(c >= '0' && c <= '9')) return true;
    i = t.indexOf(alvo, i + 1);
  }
  return false;
}
const casaTodos = (o, termos) => termos.every(alts => alts.some(w => temPalavra(o._t, w)));
const quantosCasam = (o, termos) => termos.reduce((n, alts) => n + (alts.some(w => temPalavra(o._t, w)) ? 1 : 0), 0);

// ── Filtros ──
function ler(q) {
  const num = v => (v === undefined || v === '' || v === null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    loja: String(q.loja || ''), cat: String(q.cat || ''), tipo: String(q.tipo || ''), q: String(q.q || '').slice(0, 120),
    min: num(q.min), max: num(q.max), desc: Number(q.desc) || 0, extra: q.com === 'extra',
    rel: q.relampago === '1', cupom: String(q.cupom || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30), ordem: String(q.ordem || 'destaques'),
    sem: String(q.sem || '').replace(/[^a-z0-9]/gi, '').slice(0, 12),
    pagina: Math.max(1, parseInt(q.pagina, 10) || 1), por: Math.min(Math.max(parseInt(q.por, 10) || POR_PAGINA, 1), 96),
  };
}
// Categoria "Promoção relâmpago": só o que a própria loja marcou. A queda de preço ("Preço caiu agora") não tem hora para acabar.
const agoraSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const ehRelampago = (o, agora = agoraSql()) => o.relampago_tipo === 'loja' && o.relampago_fim > agora && !o._susp;
// A promoção da loja acabou: não aparece mais, mesmo antes da limpeza de cada minuto
const relampagoAcabou = (o, agora) => o.relampago_tipo === 'loja' && o.relampago_fim && o.relampago_fim <= agora;
function filtro(f, pular = '') {
  const termos = f.q ? termosDe(f.q) : [];
  const agora = agoraSql();
  return o => {
    if (relampagoAcabou(o, agora)) return false;
    if (pular !== 'loja' && f.loja && (f.loja === 'parceiros' ? !o.loja_slug : o.store_id !== f.loja)) return false;
    if (f.rel && !ehRelampago(o)) return false;
    if (pular !== 'cat' && f.cat && o.categoria !== f.cat) return false;
    if (pular !== 'tipo' && f.tipo && o.subcategoria !== f.tipo) return false;
    if (termos.length && !casaTodos(o, termos)) return false;
    if (f.min != null && o.preco_atual < f.min) return false;
    if (f.max != null && o.preco_atual > f.max) return false;
    if (f.desc && o.desconto_pct < f.desc) return false;
    if (pular !== 'extra' && f.extra && !(o.comissao_extra_pct > 0)) return false;
    if (pular !== 'cupom' && f.cupom && !temCupom(o, f.cupom)) return false;
    return true;
  };
}
// cupom=1: qualquer cupom; cupom=CODIGO: só esse cupom
const temCupom = (o, c) => Boolean(o.cupom) && (c === '1' || o.cupom === c);

function ordemSub(a, b) {
  if (a === b) return 0;
  if (a === 'Outros') return 1;
  if (b === 'Outros') return -1;
  return collator.compare(a || '', b || '');
}
const cmpTexto = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const semNome = (a, b) => (!a._k && b._k ? 1 : a._k && !b._k ? -1 : 0); // nome sem letras comuns: sempre no fim
// Posição de cada categoria em ordem alfabética do nome (calculada uma vez)
const RANK_CAT = Object.fromEntries(Object.keys(CATEGORIAS).sort((a, b) => collator.compare(CATEGORIAS[a], CATEGORIAS[b])).map((k, i) => [k, i + 1]));
const rankCat = c => RANK_CAT[c] || 0;
// Posição de cada tipo de produto ("Outros" por último), refeita quando aparece um tipo novo
let RANK_SUB = new Map();
function rankSub(s) {
  let r = RANK_SUB.get(s);
  if (r !== undefined) return r;
  const nomes = [...new Set([...RANK_SUB.keys(), ...CACHE.lista.map(o => o.subcategoria), s])].sort(ordemSub);
  RANK_SUB = new Map(nomes.map((n, i) => [n, i]));
  return RANK_SUB.get(s);
}
const ORDENS = {
  destaques: (a, b) => (b._s - a._s) || (b._c - a._c),
  recentes: (a, b) => (b._c - a._c) || b.id - a.id,
  desconto: (a, b) => (a._susp ? 1 : 0) - (b._susp ? 1 : 0) || b.desconto_pct - a.desconto_pct,
  'menor-preco': (a, b) => a.preco_atual - b.preco_atual,
  'maior-preco': (a, b) => b.preco_atual - a.preco_atual,
  // Nome: compara o nome já normalizado (sem acento, minúsculo); o comparador de idioma levava ~1 s com 100 mil ofertas
  nome: (a, b) => semNome(a, b) || cmpTexto(a._k, b._k) || a.id - b.id,
  'nome-desc': (a, b) => semNome(a, b) || cmpTexto(b._k, a._k) || b.id - a.id,
  comissao: (a, b) => (b.comissao_extra_pct - a.comissao_extra_pct) || ((b.comissao_pct || 0) - (a.comissao_pct || 0)) || (b._s - a._s),
  populares: (a, b) => (b.link_clicks || 0) - (a.link_clicks || 0),
  tipo: (a, b) => (rankCat(a.categoria) - rankCat(b.categoria)) || (rankSub(a.subcategoria) - rankSub(b.subcategoria)) || cmpTexto(a._k, b._k) || a.id - b.id,
};
// Relevância na busca: primeiro o produto cujo nome começa com o termo, depois quem traz o termo logo no início,
// por último acessórios ("Organizador de geladeira").
const ACESSORIO_BUSCA = /\b(capa|capinha|case|cover|pelicula|suporte|cabo|adesivo|organizador|refil|peca|pecas|reposicao|carregador|skin|protetor|plate|base|prateleira|forro|borracha|painel|rack|tampa|placa frontal|controle remoto)\b/;
const BRINQUEDO = /\b(brinquedo|miniatura|boneca|infantil|de brincar|capsulas?)\b/;
const CONSOLE = /\bconsole\b/;
function relevancia(o, frase, palavras, contexto) {
  const t = o._n;
  const i = t.indexOf(frase);
  let s = i === 0 ? 100 : i > 0 && i <= 30 ? 60 : i > 0 ? 30 : 10;
  if (i > 0 && /\b(para|de|do|da|p\/)\s$/.test(t.slice(Math.max(0, i - 5), i))) s -= 25;
  const primeira = t.split(' ')[0];
  if (primeira === palavras[0] || `${primeira}s` === palavras[0]) s += 20;
  // A busca é pelo produto, não pelo que acompanha: quem pede "geladeira" quer geladeira, não brinquedo nem peça
  if (contexto.intencao && o.categoria === contexto.intencao) s += 25;
  if (!contexto.querAcessorio && ACESSORIO_BUSCA.test(t)) s -= 70;
  if (o._susp) s -= 35;
  if (!contexto.querBrinquedo && (o.categoria === 'brinquedos' || BRINQUEDO.test(t))) s -= 45;
  if (contexto.intencao === 'games' && CONSOLE.test(t)) s += 40;
  return s;
}
function contextoDaBusca(frase) {
  const c = /\b(ps[345]|playstation|xbox|nintendo|switch)\b/.test(frase) ? 'games' : classifyCategory(frase);
  return {
    intencao: c && c !== 'outros' ? c : null,
    querAcessorio: ACESSORIO_BUSCA.test(frase),
    querBrinquedo: BRINQUEDO.test(frase) || c === 'brinquedos',
  };
}
// Variações do mesmo produto (cor, tamanho): no máximo uma por página nas primeiras páginas da busca
function espalhar(l, por) {
  const LIMITE = por * 5;
  const saida = [];
  let fila = l.slice(0, LIMITE);
  while (fila.length) {
    const vistos = new Set(), pagina = [], adiadas = [];
    for (const o of fila) {
      const k = o._n.slice(0, 26);
      if (pagina.length < por && !vistos.has(k)) { pagina.push(o); vistos.add(k); } else adiadas.push(o);
    }
    if (pagina.length < por) pagina.push(...adiadas.splice(0, por - pagina.length));
    saida.push(...pagina);
    fila = adiadas;
  }
  return saida.concat(l.slice(LIMITE));
}

// Lista inteira já ordenada (feita uma vez por montagem): filtrar uma lista ordenada mantém a ordem, então cada
// busca só filtra, sem ordenar 100 mil ofertas de novo.
function ordenada(nome, cmp) {
  const c = CACHE.ordenadas;
  if (!c[nome]) c[nome] = CACHE.lista.slice().sort(cmp);
  return c[nome];
}
const porComissao = (a, b) => (notaComissao(b) - notaComissao(a)) || (b._c - a._c);
// Ordem com os produtos de comissão extra embaralhados (semente sorteada pela página a cada visita): cada visita mostra
// outros no topo, e as páginas seguintes da mesma visita continuam a mesma ordem (sem repetir produto).
// Só os de comissão extra ganham o sorteio (0 a 40 pontos); continuam acima dos demais e misturados aos mais atrativos.
function sorteio(sem, id) { // número de 0 a 1 fixo para a dupla semente + produto (FNV-1a)
  let h = 2166136261;
  for (const ch of `${sem}:${id}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}
function ordenadaComissao(sem) {
  if (!sem) return ordenada('comissao-destaques', porComissao);
  const c = CACHE.ordenadas, nome = `comissao-destaques:${sem}`;
  if (!c[nome]) {
    // guarda só as ordens das visitas mais recentes
    const antigas = Object.keys(c).filter(k => k.startsWith('comissao-destaques:'));
    if (antigas.length >= 30) delete c[antigas[0]];
    const nota = new Map(CACHE.lista.map(o => [o.id, notaComissao(o) + (o.comissao_extra_pct > 0 ? sorteio(sem, o.id) * 40 : 0)]));
    c[nome] = CACHE.lista.slice().sort((a, b) => (nota.get(b.id) - nota.get(a.id)) || (b._c - a._c));
  }
  return c[nome];
}

// comissao: true para o admin e os afiliados (veem a comissão e podem filtrar pela comissão extra)
// Ofertas relâmpago no ar abrem a primeira página, as marcadas pela loja na frente e as que acabam antes primeiro.
// No máximo metade da página, para não esconder o resto. Busca por palavra e outras ordens continuam como estão.
function relampagosPrimeiro(l, f) {
  if (f.ordem !== 'destaques' || f.q) return l;
  // Na categoria: as que têm hora para acabar primeiro, começando pelas que acabam antes
  if (f.rel) return [...l].sort((a, b) => (b.relampago_fim_real ? 1 : 0) - (a.relampago_fim_real ? 1 : 0) || String(a.relampago_fim).localeCompare(String(b.relampago_fim)));
  const agora = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const ativas = l.filter(o => o.relampago_fim && o.relampago_fim > agora && !o._susp);
  if (!ativas.length) return l;
  const peso = o => (o.relampago_tipo === 'loja' ? 0 : 1);
  const fixas = ativas.sort((a, b) => peso(a) - peso(b) || String(a.relampago_fim).localeCompare(String(b.relampago_fim))).slice(0, Math.max(1, Math.floor(f.por / 2)));
  const ids = new Set(fixas.map(o => o.id));
  return [...fixas, ...l.filter(o => !ids.has(o.id))];
}

function buscar(query, { comissao = false } = {}) {
  const f = ler(query);
  if (!comissao) { f.extra = false; f.sem = ''; if (f.ordem === 'comissao') f.ordem = 'destaques'; } // sem sorteio para visitantes (resposta pronta igual para todos)
  const { lista: todas, resumo } = lista();
  // Mesma busca de antes (ex.: a página inicial, igual para todos): devolve a resposta pronta
  const chaveResp = comissao ? null : JSON.stringify(f);
  if (chaveResp && RESPOSTAS.has(chaveResp)) return RESPOSTAS.get(chaveResp);

  let l, aproximado = false;
  const termos = f.q ? termosDe(f.q) : [];
  const doTermo = termos.length ? todas.filter(o => casaTodos(o, termos)) : todas;
  const semTermo = filtro({ ...f, q: '' });
  if (f.q && (f.ordem === 'recentes' || f.ordem === 'destaques')) {
    // Busca: primeiro o que mais combina com o termo; empate → a mais atrativa (ou a mais nova)
    l = doTermo.filter(semTermo);
    const frase = normalizar(f.q).trim().replace(/\s+/g, ' ');
    const palavras = frase.split(' ');
    // Sem nada com todas as palavras ("tênis nike"): mostra o que tem parte delas, avisando que são parecidas
    if (!l.length && termos.length > 1) {
      l = todas.filter(o => semTermo(o) && quantosCasam(o, termos) > 0);
      aproximado = l.length > 0;
    }
    const contexto = contextoDaBusca(frase);
    const nota = new Map(l.map(o => [o.id, relevancia(o, frase, palavras, contexto) + (aproximado ? 60 * quantosCasam(o, termos) : 0)]));
    l.sort((a, b) => nota.get(b.id) - nota.get(a.id) || ORDENS[f.ordem](a, b));
    if (f.ordem === 'destaques') l = espalhar(l, f.por);
  } else if (comissao && f.ordem === 'destaques') {
    // Admin, equipe e afiliados: as de comissão extra vêm primeiro, junto das mais atrativas
    l = variar(ordenadaComissao(f.sem).filter(filtro(f)), f.por);
  } else {
    const ordem = ORDENS[f.ordem] ? f.ordem : 'destaques';
    l = ordenada(ordem, ORDENS[ordem]);
    const ids = termos.length ? new Set(doTermo.map(o => o.id)) : null;
    l = l.filter(o => (!ids || ids.has(o.id)) && semTermo(o));
    if (ordem === 'destaques') l = variar(l, f.por);
  }

  l = relampagosPrimeiro(l, f);
  const paginas = Math.max(1, Math.ceil(l.length / f.por));
  const pagina = Math.min(f.pagina, paginas);
  const itens = l.slice((pagina - 1) * f.por, pagina * f.por);

  // Números dos filtros (cada um ignora o próprio filtro), numa passada só pela lista
  const lojas = {}, categorias = {}, subcategorias = {};
  let parceiros = 0, categoriasTotal = 0, comissaoExtra = 0, comCupom = 0, relampagos = 0;
  const agoraRel = agoraSql();
  const codigos = {};
  for (const o of aproximado ? todas : doTermo) {
    // Filtros comuns a todas as contagens
    if (relampagoAcabou(o, agoraRel)) continue;
    if (aproximado && !quantosCasam(o, termos)) continue;
    if (f.min != null && o.preco_atual < f.min) continue;
    if (f.max != null && o.preco_atual > f.max) continue;
    if (f.desc && o.desconto_pct < f.desc) continue;
    const okLoja = !f.loja || (f.loja === 'parceiros' ? Boolean(o.loja_slug) : o.store_id === f.loja);
    const okCat = !f.cat || o.categoria === f.cat;
    const okTipo = !f.tipo || o.subcategoria === f.tipo;
    const okExtra = (!f.extra || o.comissao_extra_pct > 0) && (!f.cupom || temCupom(o, f.cupom));
    const rel = ehRelampago(o, agoraRel);
    if (rel && okLoja && okExtra) relampagos++; // conta em qualquer categoria: a relâmpago fica fora das outras
    if (f.rel && !rel) continue;
    if (okLoja && okCat && okTipo && (!f.extra || o.comissao_extra_pct > 0) && o.cupom) { comCupom++; codigos[o.cupom] = (codigos[o.cupom] || 0) + 1; }
    if (okCat && okTipo && okExtra) { lojas[o.store_id] = (lojas[o.store_id] || 0) + 1; if (o.loja_slug) parceiros++; }
    if (okLoja && okTipo && okExtra) { categorias[o.categoria] = (categorias[o.categoria] || 0) + 1; categoriasTotal++; }
    if (f.cat && okLoja && okCat && okExtra) subcategorias[o.subcategoria] = (subcategorias[o.subcategoria] || 0) + 1;
    if (comissao && okLoja && okCat && okTipo && o.comissao_extra_pct > 0) comissaoExtra++;
  }
  // Cupons: total e os 8 códigos com mais ofertas (filtro "Cupons de desconto")
  const cupons = { total: comCupom, codigos: Object.entries(codigos).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([codigo, n]) => ({ codigo, n, texto: (todas.find(o => o.cupom === codigo) || {}).cupom_texto || '' })) };
  const contagens = { lojas, parceiros, categorias, categorias_total: categoriasTotal, subcategorias, cupons, relampago: relampagos };
  if (comissao) contagens.comissao_extra = comissaoExtra;
  // Ordem "por tipo": quantas ofertas cada grupo tem na lista inteira
  let grupos = null;
  if (f.ordem === 'tipo') {
    grupos = {};
    for (const o of l) { const k = `${o.categoria}|${o.subcategoria}`; grupos[k] = (grupos[k] || 0) + 1; }
  }
  const resp = { total: l.length, aproximado, pagina, paginas, por: f.por, itens: itens.map(comissao ? publico : semComissao), contagens, grupos, resumo };
  if (chaveResp) {
    if (RESPOSTAS.size >= 300) RESPOSTAS.delete(RESPOSTAS.keys().next().value);
    RESPOSTAS.set(chaveResp, resp);
  }
  return resp;
}

// ── "Mais atrativas" (ordem padrão da página de ofertas) ──
// Nota de cada oferta: a chance de venda (pontuacao, abaixo) + produto muito procurado/viral + interesse no site
// (cliques) + novidade. Assim a 1ª página mostra o que mais chama atenção, e não só o que entrou por último.
// Produtos em alta no Brasil (muita busca e muita venda): sobem na lista
const EM_ALTA = [
  'iphone', 'galaxy', 'redmi', 'xiaomi', 'poco ', 'motorola', 'airpods', 'fone bluetooth', 'fone de ouvido', 'jbl', 'caixa de som',
  'smart tv', 'televisao', 'tv 4k', 'tv 50', 'tv 55', 'fire tv', 'chromecast', 'echo dot', 'alexa', 'kindle', 'smartwatch', 'apple watch',
  'notebook', 'macbook', 'ssd', 'monitor', 'mouse gamer', 'teclado mecanico', 'headset', 'playstation', 'ps5', 'xbox', 'nintendo switch',
  'air fryer', 'airfryer', 'fritadeira', 'cafeteira', 'nespresso', 'dolce gusto', 'liquidificador', 'robo aspirador', 'aspirador',
  'geladeira', 'micro-ondas', 'microondas', 'maquina de lavar', 'lava e seca', 'ar condicionado', 'ventilador', 'climatizador',
  'perfume', 'protetor solar', 'secador', 'chapinha', 'barbeador', 'tenis', 'nike', 'adidas', 'whey', 'creatina',
  'mochila', 'colchao', 'jogo de panelas', 'panela eletrica', 'lego', 'boneca', 'carrinho de bebe', 'fralda',
];
const ACESSORIO = /\b(capa|capinha|pelicula|suporte|cabo|adesivo|organizador|refil|peca|reposicao|kit \d+ pecas de reposicao)\b/;
const notaComissao = o => o._s + (o.comissao_extra_pct > 0 ? 45 + 2 * Math.min(o.comissao_extra_pct, 15) : 0);
function atratividade(o) {
  let s = pontuacao(o);
  const n = o._n;
  if (o._alta ?? EM_ALTA.some(k => n.includes(k))) s += 18; // procurado/viral
  s += LOJA_CONFIANCA[o.store_id] ?? 2;                      // loja conhecida pesa de novo (confiança de quem compra)
  if (o._acess ?? ACESSORIO.test(n.slice(0, 40))) s -= 12;               // acessório no começo do nome chama menos atenção
  if (o.desconto_pct > 85 || o.desconto_pct < 5) s -= 20;    // desconto suspeito ou pequeno demais
  else if (o.desconto_pct >= 30) s += 6;
  const idadeH = (Date.now() - (o._c || 0)) / 3600000;
  s += idadeH < 24 ? 8 : idadeH < 72 ? 4 : 0;                // novidade
  if (o.loja_slug) s += 4;                                   // loja parceira do site
  return Math.round(s * 10) / 10;
}
// Não deixa uma página inteira de uma categoria só: nas primeiras páginas, no máximo 1/4 da página por categoria,
// metade por loja e um só de cada produto (variações de cor/tamanho do mesmo item). O resto vem logo depois.
function variar(l, por) {
  const LIMITE = por * 5;
  const topo = l.slice(0, LIMITE), resto = l.slice(LIMITE);
  const saida = [];
  let fila = topo;
  while (fila.length) {
    const cat = {}, loja = {}, tipo = {}, tema = {}, vistos = new Set(), adiadas = [];
    const pagina = [];
    for (const o of fila) {
      const chave = o._n.slice(0, 28);
      // Também no máximo 2 do mesmo tema (1ª palavra: "berço", "smartwatch") e 3 do mesmo tipo de produto por página
      const palavra = o._k.split(' ')[0], sub = o.subcategoria !== 'Outros' ? `${o.categoria}|${o.subcategoria}` : o.id;
      if (pagina.length < por && !vistos.has(chave) && (cat[o.categoria] || 0) < Math.ceil(por / 4) && (loja[o.store_id] || 0) < Math.ceil(por / 2)
        && (tema[palavra] || 0) < 2 && (tipo[sub] || 0) < 3) {
        pagina.push(o); vistos.add(chave); cat[o.categoria] = (cat[o.categoria] || 0) + 1; loja[o.store_id] = (loja[o.store_id] || 0) + 1;
        tema[palavra] = (tema[palavra] || 0) + 1; tipo[sub] = (tipo[sub] || 0) + 1;
      } else adiadas.push(o);
    }
    if (!pagina.length) { saida.push(...adiadas); break; }
    if (pagina.length < por) { // poucas categorias/lojas: completa a página com as melhores que sobraram
      const falta = por - pagina.length;
      pagina.push(...adiadas.splice(0, falta));
    }
    saida.push(...pagina);
    fila = adiadas;
  }
  return saida.concat(resto);
}

// "Mix" das postagens: a oferta com mais chance de venda de cada categoria (mesma pontuação de antes)
const LOJA_CONFIANCA = { amazon: 10, mercadolivre: 10, kabum: 9, magalu: 8, shopee: 6, aliexpress: 4, shein: 4, temu: 3 };
function pontuacao(o) {
  const d = o.desconto_pct;
  const p = o.preco_atual;
  let s = Math.min(d, 70);
  if (o._susp) s -= 40; // desconto suspeito: não entra nos destaques nem nas postagens automáticas
  s += 12 * Math.log2(1 + (o.link_clicks || 0));
  if (o.menor_preco_30d) s += 15;
  s += LOJA_CONFIANCA[o.store_id] ?? 2;
  s += p >= 40 && p <= 800 ? 10 : p > 800 && p <= 2500 ? 5 : p < 15 ? -10 : p > 5000 ? -5 : 0;
  s += Math.min(15, (o.preco_anterior - p) / 20);
  const visto = quando(o.last_seen_at);
  if (visto && Date.now() - visto < 6 * 3600 * 1000) s += 5;
  if (o.subcategoria && o.subcategoria !== 'Outros') s += 3;
  return s;
}
function mix(loja = '') {
  const chave = `mix|${loja}`;
  if (RESPOSTAS.has(chave)) return RESPOSTAS.get(chave); // pronto até a lista mudar
  const melhor = {};
  for (const o of lista().lista) {
    if (o.categoria === 'outros' || o.desconto_pct > 85) continue;
    if (loja && (loja === 'parceiros' ? !o.loja_slug : o.store_id !== loja)) continue;
    const sc = pontuacao(o);
    if (!melhor[o.categoria] || sc > melhor[o.categoria].sc) melhor[o.categoria] = { o, sc };
  }
  const ids = Object.values(melhor).map(b => b.o.id);
  RESPOSTAS.set(chave, ids);
  return ids;
}

// Deixa a lista pronta assim que o servidor liga
function aquecer() { setTimeout(() => { emPartes().catch(logErro); }, 3000); }

// Ofertas no ar (lista em memória), para outras partes do site que precisam varrer todas (ex.: a vitrine)
const ativas = () => lista().lista;
// Candidatas a postagem: sem desconto suspeito, ordenadas pela nota (chance de venda + comissão extra)
function paraPostar(passa = () => true) {
  return ativas().filter(o => !o._susp && o.fonte === 'auto' && o.desconto_pct >= 15 && o.desconto_pct <= 80 && passa(o))
    .sort((a, b) => notaComissao(b) - notaComissao(a));
}
// Ofertas com desconto suspeito, para o Painel conferir (as maiores primeiro)
function suspeitas(limite = 200) {
  const l = ativas().filter(o => o._susp);
  return { total: l.length, itens: l.sort((a, b) => b.desconto_pct - a.desconto_pct).slice(0, limite).map(o => ({ ...publico(o), motivo: o._susp })) };
}

module.exports = { CATEGORIAS, EM_ALTA, ACESSORIO, LOJA_CONFIANCA, buscar, mix, aquecer, montar, pronta, aguardar, atualizar, ativas, suspeitas, paraPostar, POR_PAGINA };
