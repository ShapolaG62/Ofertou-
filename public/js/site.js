/* Ofertou! — site público */
(() => {
  'use strict';

  const STORES = [
    { id: 'mercadolivre', name: 'Mercado Livre', color: '#ffe600' },
    { id: 'amazon', name: 'Amazon', color: '#ff9900' },
    { id: 'shopee', name: 'Shopee', color: '#ee4d2d' },
    { id: 'magalu', name: 'Magalu', color: '#0086ff' },
    { id: 'shein', name: 'Shein', color: '#222222' },
    { id: 'aliexpress', name: 'AliExpress', color: '#e62e04' },
    { id: 'kabum', name: 'KaBuM!', color: '#ff6500' },
    { id: 'temu', name: 'Temu', color: '#fb7701' },
  ];
  const STORE_BY_ID = Object.fromEntries(STORES.map(s => [s.id, s]));

  const CATEGORIES = {
    informatica: 'Informática', celulares: 'Celulares, tablets e relógios', games: 'Games',
    audio_tv: 'TV, áudio e casa inteligente', eletrodomesticos: 'Eletrodomésticos', cozinha: 'Cozinha e eletroportáteis',
    casa: 'Casa, móveis e decoração', ferramentas: 'Ferramentas e construção', beleza: 'Beleza e cuidados pessoais',
    saude: 'Saúde e bem-estar', esporte: 'Esporte e fitness', moda: 'Moda e acessórios', brinquedos: 'Bebês e brinquedos',
    automotivo: 'Automotivo', pets: 'Pet shop', limpeza: 'Limpeza', alimentos: 'Alimentos e bebidas', outros: 'Outros',
  };
  const DISCOUNTS = [10, 20, 30, 50];
  // Paradas do controle de preço: mais pontos nos valores baixos, onde está a maioria das ofertas
  const FAIXA_PRECO = [0, 25, 50, 75, 100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 4000, 5000];
  const PER_PAGE = 24;

  const $ = s => document.querySelector(s);
  const fmt = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const brl = v => fmt.format(Number(v) || 0);
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
  const parseDate = s => (s ? new Date(String(s).replace(' ', 'T') + 'Z') : null);

  function timeAgo(s) {
    const d = parseDate(s);
    if (!d || isNaN(d)) return '';
    const min = Math.max(0, Math.round((Date.now() - d) / 60000));
    if (min < 1) return 'agora';
    if (min < 60) return `há ${min} min`;
    const h = Math.round(min / 60);
    if (h < 24) return `há ${h} h`;
    const days = Math.round(h / 24);
    return `há ${days} dia${days > 1 ? 's' : ''}`;
  }

  const slug = o => `${String(o.produto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)}-${o.id}`;

  // ── Estado (espelhado na URL para links compartilháveis) ─────────────────
  const PAGINA_SEO = window.OFERTOU_PAGINA || null; // /ofertas/celulares etc. (src/paginas/ofertas-seo.js)
  const state = { loja: '', cat: '', tipo: '', q: '', min: null, max: null, desc: 0, com: '', cupom: '', rel: false, ordem: 'destaques', pagina: 1, vista: '' };
  let CUPONS = null; // lista de cupons ativos (a vista "Cupons" troca os produtos por ela)
  let cuponsVisiveis = 60; // quantos cupons aparecem ("Mostrar mais" soma mais 60)
  // Resposta do servidor para os filtros atuais: { total, pagina, paginas, itens, contagens, grupos, resumo }
  let DATA = { total: 0, pagina: 1, paginas: 1, itens: [], contagens: { lojas: {}, parceiros: 0, categorias: {}, categorias_total: 0, subcategorias: {} }, grupos: null, resumo: null };
  let carregou = false;
  let isAdmin = false;
  // Produtos escolhidos para postar: guardados no navegador e lidos pela tela /postagens.
  const SEL_KEY = 'gp_postagens';
  const selected = new Set((() => { try { return JSON.parse(localStorage.getItem(SEL_KEY)) || []; } catch { return []; } })());
  const saveSelection = () => { try { localStorage.setItem(SEL_KEY, JSON.stringify([...selected])); } catch { /* sem armazenamento */ } };

  function readUrl() {
    const p = new URLSearchParams(location.search);
    state.loja = p.get('loja') || '';
    state.cat = p.get('cat') || '';
    state.tipo = p.get('tipo') || '';
    state.q = p.get('q') || '';
    state.min = p.has('min') ? Number(p.get('min')) : null;
    state.max = p.has('max') ? Number(p.get('max')) : null;
    state.desc = Number(p.get('desc')) || 0;
    state.com = p.get('com') === 'extra' ? 'extra' : '';
    state.cupom = (p.get('cupom') || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30);
    state.rel = p.get('relampago') === '1';
    state.ordem = p.get('ordem') || 'destaques';
    state.pagina = Math.max(1, Number(p.get('pagina')) || 1);
    state.vista = location.pathname.replace(/\/+$/, '') === '/cupons' ? 'cupons' : '';
    if (PAGINA_SEO) for (const k of ['cat', 'tipo', 'q']) if (!p.has(k)) state[k] = PAGINA_SEO[k] || '';
  }

  function writeUrl() {
    const p = new URLSearchParams();
    // Na página de categoria/marca: enquanto os filtros dela não mudam, o endereço continua o dela
    const naPagina = PAGINA_SEO && ['cat', 'tipo', 'q'].every(k => (state[k] || '') === (PAGINA_SEO[k] || ''));
    for (const k of ['loja', 'cat', 'tipo', 'q']) if (state[k] && !(naPagina && k !== 'loja')) p.set(k, state[k]);
    if (state.min != null) p.set('min', state.min);
    if (state.max != null) p.set('max', state.max);
    if (state.desc) p.set('desc', state.desc);
    if (state.com) p.set('com', state.com);
    if (state.cupom) p.set('cupom', state.cupom);
    if (state.rel) p.set('relampago', '1');
    if (state.ordem !== 'destaques') p.set('ordem', state.ordem);
    if (state.pagina > 1) p.set('pagina', state.pagina);
    const qs = p.toString();
    const base = state.vista === 'cupons' ? '/cupons' : naPagina ? PAGINA_SEO.caminho : PAGINA_SEO || location.pathname.replace(/\/+$/, '') === '/cupons' ? '/' : location.pathname;
    history.replaceState(null, '', qs ? `${base}?${qs}` : base);
  }

  function setFilter(changes, { keepPage = false } = {}) {
    // Na vista de cupons só a loja continua valendo; qualquer outro filtro volta para os produtos
    if (state.vista && !('vista' in changes) && Object.keys(changes).some(k => k !== 'loja')) state.vista = '';
    Object.assign(state, changes);
    if ('cat' in changes && !('tipo' in changes)) state.tipo = '';
    if ('cat' in changes && !('rel' in changes)) state.rel = false; // é uma categoria como as outras: escolher outra sai dela
    if (!keepPage) state.pagina = 1;
    writeUrl();
    loadOffers();
  }

  // ── Filtragem e ordenação: feitas no servidor (/api/offers/busca) ─────────
  function subOrder(a, b) {
    if (a === b) return 0;
    if (a === 'Outros') return 1;
    if (b === 'Outros') return -1;
    return collator.compare(a || '', b || '');
  }

  // ── Renderização ─────────────────────────────────────────────────────────
  // Marca da loja (public/images/lojas): a logo já traz o nome; as outras têm ícone ou ponto colorido e o nome escrito
  // Sem fundo: acompanham o tema; as de texto escuro têm uma segunda versão clara para o tema escuro
  const LOJAS_COM_LOGO = { mercadolivre: 'webp', amazon: 'webp', shopee: 'svg', magalu: 'svg', aliexpress: 'webp', kabum: 'svg' };
  const LOGO_COM_VERSAO_CLARA = new Set(['mercadolivre', 'amazon', 'kabum']);
  const LOJAS_COM_ICONE = new Set(['shein', 'temu']);
  const lojaMarca = (id, nome, cor) => {
    const ext = LOJAS_COM_LOGO[id];
    if (ext) {
      const img = (arq, cl) => `<img class="store-marca marca-${id}${cl}" src="/images/lojas/${arq}.${ext}" alt="${esc(nome)}" title="${esc(nome)}" decoding="async">`;
      return LOGO_COM_VERSAO_CLARA.has(id) ? img(id, ' tema-claro') + img(`${id}-escuro`, ' tema-escuro') : img(id, '');
    }
    return `${LOJAS_COM_ICONE.has(id) ? `<img class="store-logo" src="/images/lojas/${id}.svg" alt="" width="18" height="18">` : `<span class="store-dot" style="background:${cor || '#999'}"></span>`}${esc(nome)}`;
  };

  function storeLabel(id, name, lojaSlug) {
    if (lojaSlug) return `<span class="store-dot" style="background:var(--brand)"></span>Loja parceira · ${esc(name)}`;
    const s = STORE_BY_ID[id];
    return lojaMarca(id, s ? s.name : name, s?.color);
  }

  let STORES_EXTRA = '';
  function renderStoreTabs() {
    const counts = DATA.contagens.lojas;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const tabs = [`<button class="store-tab" type="button" data-loja="" aria-pressed="${!state.loja}">Todas as lojas <span class="count">${total}</span></button>`];
    const partners = DATA.contagens.parceiros;
    // Lojas parceiras não aparecem nesta barra (só as lojas mineradas); o botão só volta se o filtro já estiver ativo
    if (state.loja === 'parceiros') {
      STORES_EXTRA = `<button class="store-tab" type="button" data-loja="parceiros" aria-pressed="${state.loja === 'parceiros'}">
        <span class="store-dot" style="background:var(--brand)"></span>Lojas parceiras <span class="count">${partners}</span></button>`;
    } else STORES_EXTRA = '';
    for (const s of STORES) {
      const n = counts[s.id] || 0;
      if (!n && state.loja !== s.id) continue; // só lojas com produtos minerados
      tabs.push(`<button class="store-tab" type="button" data-loja="${s.id}" aria-pressed="${state.loja === s.id}" ${n || state.loja === s.id ? '' : 'disabled'}>
        ${lojaMarca(s.id, s.name, s.color)} <span class="count">${n}</span></button>`);
    }
    $('#store-tabs').innerHTML = tabs.join('') + STORES_EXTRA;
  }

  // ── Barra lateral: categorias com ícone e seta, faixa de preço e desconto ──
  const RL_ICO = {
    informatica: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
    celulares: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18h2"/>',
    games: '<path d="M7 8h10a4 4 0 0 1 4 4l-1 5a2 2 0 0 1-3.6.8L15 16H9l-1.4 1.8A2 2 0 0 1 4 17l-1-5a4 4 0 0 1 4-4Z"/><path d="M8 11v3M6.5 12.5h3"/>',
    audio_tv: '<rect x="3" y="5" width="18" height="12" rx="1.5"/><path d="M8 20h8"/>',
    eletrodomesticos: '<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M6 9h12M9 6v1M9 12v3"/>',
    cozinha: '<path d="M6 3v7a2 2 0 0 0 4 0V3M8 12v9M16 3c-2 1-3 4-3 7h3v11"/>',
    casa: '<path d="M4 11l8-7 8 7v9H4z"/><path d="M10 20v-6h4v6"/>',
    ferramentas: '<path d="M14 6a4 4 0 0 0 5 5l-9 9a2.1 2.1 0 0 1-3-3l9-9a4 4 0 0 1-2-2Z"/>',
    beleza: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18 16l.8 2.2L21 19l-2.2.8L18 22"/>',
    saude: '<path d="M12 20s-7-4.6-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.4-7 10-7 10Z"/>',
    esporte: '<circle cx="12" cy="12" r="9"/><path d="M3.5 9.5c5 .5 12 .5 17 0M3.5 14.5c5-.5 12-.5 17 0"/>',
    moda: '<path d="M8 3l4 3 4-3 5 4-3 3-2-1v12H8V9l-2 1-3-3z"/>',
    brinquedos: '<circle cx="12" cy="9" r="5"/><path d="M8 13l-3 7M16 13l3 7M9 18h6"/>',
    automotivo: '<path d="M4 16v-4l2-5h12l2 5v4M3 16h18v3H3zM7 12h10"/>',
    pets: '<circle cx="8" cy="9" r="1.6"/><circle cx="16" cy="9" r="1.6"/><circle cx="5" cy="14" r="1.4"/><circle cx="19" cy="14" r="1.4"/><path d="M12 13c-2.5 0-4 2-4 4s2 2 4 2 4 0 4-2-1.5-4-4-4Z"/>',
    limpeza: '<path d="M9 3h6v5H9zM8 8h8l1 13H7zM12 12v5"/>',
    alimentos: '<path d="M12 7c-4-3-8 0-7 5 .6 3.6 3 8 5 8 1 0 1.3-.6 2-.6s1 .6 2 .6c2 0 4.4-4.4 5-8 1-5-3-8-7-5ZM12 7c0-2 1-3.5 3-4"/>',
    outros: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
    cupom: '<path d="M3 9a2 2 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a2 2 0 0 1 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1zM14 5v2M14 11v2M14 17v2"/>',
  };
  RL_ICO.relampago = '<path d="M13 2 4.5 13.5H11L10 22l8.500-11.500H12z"/>';
  const rlIco = k => `<svg class="rl-ico" viewBox="0 0 24 24" aria-hidden="true">${RL_ICO[k] || RL_ICO.outros}</svg>`;
  const RL_SETA = '<svg class="rl-seta" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
  const RL_VISIVEIS = 7; // categorias à mostra antes de "Ver todas"
  let catAberta = null, verTodasCats = false, cuponsAberto = false;
  const tiposGuardados = {};

  const tiposDe = c => (c === state.cat ? DATA.contagens.subcategorias : tiposGuardados[`${state.loja}|${c}`]);
  // A seta abre os tipos da categoria ali mesmo, sem filtrar a página
  async function abrirCategoria(c) {
    catAberta = catAberta === c ? '' : c;
    renderFilters();
    const k = `${state.loja}|${c}`;
    if (catAberta !== c || c === state.cat || tiposGuardados[k]) return;
    const qs = new URLSearchParams({ cat: c, por: 1 });
    if (state.loja) qs.set('loja', state.loja);
    try { tiposGuardados[k] = (await fetch(`/api/offers/busca?${qs}`).then(r => r.json())).contagens.subcategorias || {}; }
    catch { tiposGuardados[k] = {}; }
    if (catAberta === c) renderFilters();
  }

  function tiposHtml(c) {
    const subs = tiposDe(c);
    if (!subs) return '<p class="rl-vazio">Carregando…</p>';
    const nomes = Object.keys(subs).sort(subOrder);
    if (!nomes.length) return '<p class="rl-vazio">Nenhum tipo nesta categoria</p>';
    return `<ul class="rl-sub">${nomes.map(n => {
      const on = state.cat === c && state.tipo === n;
      return `<li><button class="rl-subop" type="button" data-sub-cat="${c}" data-sub-tipo="${esc(n)}" aria-pressed="${on}">${esc(n)}</button></li>`;
    }).join('')}</ul>`;
  }

  // Sempre a primeira da lista
  function relampagoCatHtml() {
    const n = DATA.contagens.relampago || 0;
    return `<li class="rl-item"><div class="rl-linha${state.rel ? ' is-ativa' : ''}">
      <button class="rl-nome rl-relampago" type="button" data-relampago aria-pressed="${state.rel}">${rlIco('relampago')}<span>Promoção relâmpago</span>${n ? `<span class="count">${n.toLocaleString('pt-BR')}</span>` : ''}</button></div></li>`;
  }
  function categoriasHtml() {
    const cats = DATA.contagens.categorias;
    if (catAberta === null) catAberta = state.cat;
    const todas = Object.keys(CATEGORIES).filter(c => cats[c] || state.cat === c).sort((a, b) => (cats[b] || 0) - (cats[a] || 0));
    const visiveis = verTodasCats ? todas : todas.filter((c, i) => i < RL_VISIVEIS || c === state.cat);
    return relampagoCatHtml() + visiveis.map(c => {
      const aberta = catAberta === c;
      return `<li class="rl-item">
        <div class="rl-linha${state.cat === c ? ' is-ativa' : ''}">
          <button class="rl-nome" type="button" data-cat="${c}" aria-pressed="${state.cat === c}">${rlIco(c)}<span>${esc(CATEGORIES[c])}</span></button>
          <button class="rl-abrir" type="button" data-abrir-cat="${c}" aria-expanded="${aberta}" aria-label="Ver os tipos de ${esc(CATEGORIES[c])}">${RL_SETA}</button>
        </div>${aberta ? tiposHtml(c) : ''}</li>`;
    }).join('') + cuponsHtml() + (todas.length > RL_VISIVEIS
      ? `<li><button class="rl-mais" type="button" data-ver-cats>${verTodasCats ? 'Ver menos categorias' : `Ver todas as ${todas.length} categorias`}</button></li>` : '');
  }

  const indicePreco = v => {
    let m = 0;
    FAIXA_PRECO.forEach((p, i) => { if (Math.abs(p - v) < Math.abs(FAIXA_PRECO[m] - v)) m = i; });
    return m;
  };
  const reais = v => `R$ ${Number(v).toLocaleString('pt-BR')}`;
  const textoPreco = (min, max) => `${reais(min || 0)} - ${max == null ? `${reais(FAIXA_PRECO[FAIXA_PRECO.length - 1])}+` : reais(max)}`;
  const estiloPreco = (a, b) => `--pa:${a / (FAIXA_PRECO.length - 1)};--pb:${b / (FAIXA_PRECO.length - 1)}`;

  function precoHtml() {
    const ultimo = FAIXA_PRECO.length - 1;
    const a = state.min == null ? 0 : indicePreco(state.min), b = state.max == null ? ultimo : indicePreco(state.max);
    return `<form class="rl-preco" data-price-form>
      <p class="rl-faixa num" data-preco-txt>${textoPreco(state.min, state.max)}</p>
      <div class="rl-slider" data-preco-slider style="${estiloPreco(a, b)}"><i></i>
        <input type="range" name="ra" min="0" max="${ultimo}" step="1" value="${a}" aria-label="Preço mínimo">
        <input type="range" name="rb" min="0" max="${ultimo}" step="1" value="${b}" aria-label="Preço máximo">
      </div>
      <div class="rl-campos">
        <input type="number" inputmode="numeric" min="0" placeholder="Mín." name="min" aria-label="Preço mínimo em reais" value="${state.min ?? ''}">
        <span>–</span>
        <input type="number" inputmode="numeric" min="0" placeholder="Máx." name="max" aria-label="Preço máximo em reais" value="${state.max ?? ''}">
        <button class="sr-only" type="submit">Aplicar</button>
      </div></form>`;
  }

  function filtersHtml() {
    const descontos = [0, ...DISCOUNTS].map(d => `<label><input type="radio" name="rl-desc" value="${d}"${state.desc === d ? ' checked' : ''}><span>${d ? `${d}% ou mais` : 'Qualquer desconto'}</span></label>`).join('');
    return `
      <div class="rl-bloco"><h3 class="rl-tit">Categorias</h3>
        <ul class="rl-lista">${state.cat || state.rel ? `<li><button class="rl-mais" type="button" data-cat="">Todas as categorias</button></li>` : ''}${categoriasHtml()}</ul></div>
      <div class="rl-bloco"><h3 class="rl-tit">Faixa de Preço</h3>${precoHtml()}</div>
      <div class="rl-bloco"><h3 class="rl-tit">Desconto</h3><form class="rl-radios">${descontos}</form></div>
      <div class="rl-bloco com-only"><h3 class="rl-tit">Comissão de afiliado</h3><ul class="filter-list">
        <li><button class="filter-option" type="button" data-com="" aria-pressed="${!state.com}"><span>Todas as comissões</span></button></li>
        <li><button class="filter-option" type="button" data-com="extra" aria-pressed="${state.com === 'extra'}"><span><i class="com-ponto"></i>Só comissão extra</span><span class="count">${DATA.contagens.comissao_extra ?? ''}</span></button></li></ul></div>`;
  }

  // Cupom do Mercado Livre não tem código: é ativado na central de cupons (o site guarda "ML" + nº da campanha)
  const cupomMl = c => /^ML\d+$/.test(String(c || ''));
  const CENTRAL_ML = 'https://www.mercadolivre.com.br/cupons';

  // Cupons de desconto encontrados pela mineração: todas, só com cupom e os códigos com mais ofertas
  function cuponsHtml() {
    const c = DATA.contagens.cupons;
    if (!c || (!c.total && !state.cupom)) return '';
    const codigos = c.codigos.map(k => `<li><button class="filter-option" type="button" data-cupom="${esc(k.codigo)}" aria-pressed="${state.cupom === k.codigo}">
      <span>${cupomMl(k.codigo) ? `<b>${esc(k.texto || 'Cupom')}</b> <small>Mercado Livre</small>` : `<b class="cupom-cod">${esc(k.codigo)}</b>${k.texto ? ` <small>${esc(k.texto)}</small>` : ''}`}</span><span class="count">${k.n}</span></button></li>`).join('');
    const aberto = cuponsAberto || Boolean(state.cupom);
    return `<li class="rl-item">
        <div class="rl-linha${state.cupom || state.vista ? ' is-ativa' : ''}">
          <button class="rl-nome" type="button" data-ver-cupons aria-pressed="${Boolean(state.vista)}">${rlIco('cupom')}<span>Cupons</span></button>
          <button class="rl-abrir" type="button" data-abrir-cupons aria-expanded="${aberto}" aria-label="Ver os cupons">${RL_SETA}</button>
        </div>${aberto ? `<ul class="filter-list cupons-list rl-sub">
        <li><button class="filter-option" type="button" data-cupom="" aria-pressed="${!state.cupom}"><span>Com ou sem cupom</span></button></li>
        <li><button class="filter-option" type="button" data-cupom="1" aria-pressed="${state.cupom === '1'}"><span>Só com cupom</span><span class="count">${c.total}</span></button></li>
        ${codigos}</ul>` : ''}</li>`;
  }

  // Refazer a barra não tira o foco de quem usa o teclado
  function seletorDoFoco() {
    const el = document.activeElement;
    if (!el || !el.closest?.('#filters, #filters-mobile')) return '';
    if (el.name) return el.type === 'radio' ? `[name="${el.name}"]:checked` : `[name="${el.name}"]`;
    if (el.dataset.relampago !== undefined) return '[data-relampago]';
    for (const k of ['cat', 'abrirCat', 'com', 'cupom']) {
      if (el.dataset[k] !== undefined) return `[data-${k.replace(/[A-Z]/g, l => `-${l.toLowerCase()}`)}="${CSS.escape(el.dataset[k])}"]`;
    }
    return '';
  }
  function renderFilters() {
    const foco = seletorDoFoco();
    const html = filtersHtml();
    $('#filters').innerHTML = html;
    const noDialogo = $('#filters-dialog').open;
    if (noDialogo) $('#filters-mobile').innerHTML = html;
    if (foco) (noDialogo ? $('#filters-mobile') : $('#filters')).querySelector(foco)?.focus({ preventScroll: true });
  }

  function renderSubChips() {
    const box = $('#sub-chips');
    if (!state.cat) { box.hidden = true; return; }
    const subs = DATA.contagens.subcategorias;
    const names = Object.keys(subs).sort(subOrder);
    if (names.length < 2 && !state.tipo) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = [`<button class="chip" type="button" data-tipo="" aria-pressed="${!state.tipo}">Todos</button>`,
      ...names.map(n => `<button class="chip" type="button" data-tipo="${esc(n)}" aria-pressed="${state.tipo === n}">${esc(n)} <span class="count">${subs[n]}</span></button>`)].join('');
  }

  function renderActiveFilters() {
    const items = [];
    if (state.q) items.push(['q', `Busca: “${state.q}”`]);
    if (state.min != null || state.max != null) {
      items.push(['preco', state.max == null ? `Acima de R$ ${state.min}` : `R$ ${state.min ?? 0} a ${state.max}`]);
    }
    if (state.desc) items.push(['desc', `${state.desc}% ou mais`]);
    if (state.rel) items.push(['rel', 'Promoção relâmpago']);
    if (state.com) items.push(['com', 'Comissão extra']);
    if (state.vista) items.push(['vista', 'Cupons ativos']);
    if (state.cupom) items.push(['cupom', state.cupom === '1' ? 'Com cupom' : cupomMl(state.cupom) ? 'Cupom do Mercado Livre' : `Cupom ${state.cupom}`]);
    const any = items.length || state.loja || state.cat;
    $('#active-filters').innerHTML = items.map(([k, label]) =>
      `<button class="chip" type="button" data-remove="${k}">${esc(label)}<svg><use href="#i-x"/></svg></button>`).join('')
      + (any ? '<button class="link-btn" type="button" data-clear>Limpar filtros</button>' : '');
  }

  // Selo azul de comissão extra (só admin, equipe e afiliados)
  const pctTxt = v => `${String(Math.round(Number(v) * 10) / 10).replace('.', ',')}%`;
  function comissaoHtml(o) {
    if (!('comissao_pct' in o)) return '';
    if (o.comissao_extra_pct > 0) {
      return `<span class="card-com extra com-only" title="Comissão extra de ${pctTxt(o.comissao_extra_pct)}${o.comissao_pct ? ` (total de ${pctTxt(o.comissao_pct)})` : ''}">Extra +${pctTxt(o.comissao_extra_pct)}</span>`;
    }
    return '';
  }

  // Selo da oferta relâmpago: com contagem regressiva só quando a loja informa a hora do fim
  const doisDig = n => String(n).padStart(2, '0');
  const faltaTxt = fim => {
    const s = Math.floor((Date.parse(`${String(fim).replace(' ', 'T')}Z`) - Date.now()) / 1000);
    if (s <= 0) return 'terminou';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${doisDig(h)}:${doisDig(m)}:${doisDig(s % 60)}`;
  };
  function relampagoHtml(o) {
    if (!o.relampago_fim || Date.parse(`${String(o.relampago_fim).replace(' ', 'T')}Z`) <= Date.now()) return '';
    if (o.relampago_tipo !== 'loja') return `<span class="card-relampago queda${o.cupom ? ' com-cupom' : ''}">🚨 Preço caiu agora</span>`;
    return `<span class="card-relampago${o.cupom ? ' com-cupom' : ''}"${o.relampago_fim_real ? ` data-relampago-fim="${esc(o.relampago_fim)}"` : ''}>⚡ ${o.relampago_fim_real ? `<span class="rel-acaba">Acaba em </span><b>${faltaTxt(o.relampago_fim)}</b>` : 'Relâmpago'}</span>`;
  }
  setInterval(() => {
    document.querySelectorAll('[data-relampago-fim] b').forEach(b => {
      const txt = faltaTxt(b.parentElement.dataset.relampagoFim);
      if (txt === 'terminou') b.closest('.card, article')?.remove(); // acabou: sai da tela na hora
      else b.textContent = txt;
    });
  }, 1000);

  // pos: posição na página. As fotos dos 4 primeiros cartões aparecem sem rolar: carregam na hora (as 2 primeiras na frente)
  function cardHtml(o, pos = 99) {
    const isSel = selected.has(o.id);
    const carregar = pos < 4 ? `loading="eager"${pos < 2 ? ' fetchpriority="high"' : ''}` : 'loading="lazy"';
    const minerada = !o.loja_slug && o.fonte !== 'manual' && o.fonte !== 'empresa'; // preço conferido pela mineração
    // Anúncios criados pelas empresas abrem a página do anúncio; o resto vai direto para a loja.
    const link = o.fonte === 'empresa' ? `href="/anuncio/${o.id}"` : `href="/oferta/${slug(o)}" target="_blank" rel="noopener sponsored"`;
    return `<a class="card${isSel ? ' is-selected' : ''}" ${link} data-id="${o.id}">
      <div class="card-media">
        <img src="/img/p/${o.id}.webp" alt="" ${carregar} decoding="async" onerror="this.onerror=null;this.src='/images/pet-capi-head.png';this.style.opacity='.35'">
        ${relampagoHtml(o)}
        <div class="card-tags"><span class="card-off">-${Math.round(o.desconto_pct)}%</span>${Number(o.menor_preco_30d) === 1 ? '<span class="badge-low" title="Menor preço em 30 dias">Menor preço</span>' : ''}${comissaoHtml(o)}</div>
        <button class="card-select poster-only" type="button" data-select="${o.id}" aria-label="Escolher para postar"><svg><use href="#i-check"/></svg></button>
        ${o.cupom ? (cupomMl(o.cupom)
          ? `<button class="card-cupom card-cupom-ml" type="button" data-cupom-ml="${esc(o.cupom_texto || '')}" title="${esc(o.cupom_texto || 'Cupom')}: ative em Cupons no app do Mercado Livre"><b>${esc(o.cupom_texto || 'Cupom')}</b> <span>ative em Cupons</span></button>`
          : `<button class="card-cupom" type="button" data-copiar-cupom="${esc(o.cupom)}" title="Copiar o cupom ${esc(o.cupom)}${o.cupom_texto ? ` (${esc(o.cupom_texto)})` : ''}"><i class="cupom-rot">Cupom</i> <b>${esc(o.cupom)}</b>${o.cupom_texto ? ` <span>${esc(o.cupom_texto)}</span>` : ''}</button>`) : ''}
      </div>
      <div class="card-body">
        <div class="card-store">${storeLabel(o.store_id, o.plataforma, o.loja_slug)}${minerada && !o.cupom ? `<span class="card-verif" title="Conferido ${timeAgo(o.last_seen_at)}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#16a34a"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>Preço verificado</span>` : ''}</div>
        <h3 class="card-title" title="${esc(o.produto)}">${esc(o.produto)}</h3>
        ${o.iguais > 1 ? `<span class="badge-iguais">Menor preço entre ${o.iguais} anúncios</span>` : ''}
        <div class="card-prices">
          <div class="card-old num">R$ ${brl(o.preco_anterior)}</div>
          <div class="card-price num"><small>R$</small>${brl(o.preco_atual)}</div>
        </div>
        ${o.cupom ? `<div class="card-sem-cupom num">ou R$ ${brl(o.preco_sem_cupom)} sem cupom</div>` : ''}
        ${minerada ? '' : `<div class="card-foot"><span>${o.loja_slug ? 'Publicado pela loja' : 'Oferta selecionada'}</span></div>`}
        <span class="card-ver">Ver oferta</span>
        <button class="card-enviar poster-only" type="button" data-enviar="${o.id}"><svg><use href="#i-enviar"/></svg>Enviar para os grupos</button>
      </div>
    </a>`;
  }

  function emptyHtml() {
    const hasFilters = state.q || state.loja || state.cat || state.min != null || state.max != null || state.desc || state.com || state.cupom || state.rel;
    return `<div class="empty"><img src="/images/pet-capi.png" alt="" width="120">
      <h3>${state.rel && !state.q ? 'Nenhuma promoção relâmpago no ar agora' : minaTermo && !$('#mina-aviso').hidden && $('#mina-aviso').classList.contains('mina-minerando') ? 'Procurando nas lojas…' : DATA.resumo?.total ? 'Nenhuma oferta com esses filtros' : 'Ainda não há ofertas no ar'}</h3>
      <p>${state.rel && !state.q ? 'As lojas abrem novas promoções ao longo do dia. Volte em breve.' : DATA.resumo?.total ? 'Tente outra busca ou remova alguns filtros.' : 'O minerador está procurando descontos reais nas lojas. Volte em alguns minutos.'}</p>
      ${hasFilters ? '<button class="btn" type="button" data-clear>Limpar filtros</button>' : ''}</div>`;
  }

  // Vista "Cupons": os cupons ativos no lugar dos produtos, separados por loja
  function cupomHtml(c) {
    const nome = c.ml ? (c.texto || 'Cupom') : c.codigo;
    const det = c.ml ? `${c.minimo ? `Acima de R$ ${Number(c.minimo).toLocaleString('pt-BR')}. ` : ''}Sem código: ative em Cupons, no Mercado Livre` : `${c.texto ? `${c.texto}. ` : ''}Use no pagamento da loja`;
    const principal = c.ml
      ? `<button class="btn btn-primary" type="button" data-cupom-ml="${esc(c.texto || '')}">Ativar cupom</button>`
      : `<button class="btn btn-primary" type="button" data-copiar-cupom="${esc(c.codigo)}">Copiar cupom</button>`;
    const ofertas = c.ofertas ? `<button class="btn" type="button" data-ver-ofertas-cupom="${esc(c.codigo)}">Ver ${c.ofertas === 1 ? '1 oferta' : `${Number(c.ofertas).toLocaleString('pt-BR')} ofertas`}</button>` : '';
    return `<article class="cupom-cartao"><b class="cupom-nome">${esc(nome)}</b><p>${esc(det)}</p><div class="cupom-botoes">${principal}${ofertas}</div></article>`;
  }
  async function carregarCupons() {
    try {
      const r = await fetch('/api/cupons');
      if (!r.ok) throw new Error(String(r.status));
      CUPONS = (await r.json()).cupons;
    } catch { CUPONS = []; }
    if (state.vista) renderCupons();
  }
  function renderCupons() {
    $('#results-title').textContent = state.loja && STORE_BY_ID[state.loja] ? `Cupons da ${STORE_BY_ID[state.loja].name}` : 'Cupons ativos';
    $('#pagination').innerHTML = '';
    if (!CUPONS) {
      $('#results-count').textContent = '';
      $('#grid').innerHTML = Array.from({ length: 8 }, () => '<div class="skeleton"></div>').join('');
      return carregarCupons();
    }
    const lista = CUPONS.filter(c => !state.loja || c.store_id === state.loja);
    $('#results-count').textContent = `${lista.length} cupo${lista.length === 1 ? 'm' : 'ns'} · regras e validade na própria loja`;
    if (!lista.length) {
      $('#grid').innerHTML = `<div class="empty"><img src="/images/pet-capi.png" alt="" width="120"><h3>Nenhum cupom ativo${state.loja ? ' nesta loja' : ''} agora</h3><p>A lista é atualizada várias vezes por dia. Volte mais tarde.</p><button class="btn" type="button" data-clear>Ver as ofertas</button></div>`;
      return;
    }
    const total = new Map();
    for (const c of lista) total.set(c.loja, (total.get(c.loja) || 0) + 1);
    const visiveis = lista.slice(0, cuponsVisiveis);
    const lojas = new Map();
    for (const c of visiveis) { if (!lojas.has(c.loja)) lojas.set(c.loja, []); lojas.get(c.loja).push(c); }
    const resto = lista.length - visiveis.length;
    $('#grid').innerHTML = [...lojas.entries()].map(([loja, itens]) => `<div class="group-title">${esc(loja)} <span>${total.get(loja)} cupo${total.get(loja) === 1 ? 'm' : 'ns'}</span></div>${itens.map(cupomHtml).join('')}`).join('')
      + (resto > 0 ? `<div class="cupons-mais"><button class="btn" type="button" data-mais-cupons>Mostrar mais cupons (${resto.toLocaleString('pt-BR')} restantes)</button></div>` : '');
  }
  document.addEventListener('click', e => {
    if (!e.target.closest('[data-mais-cupons]')) return;
    cuponsVisiveis += 60;
    renderCupons();
  });

  function renderGrid() {
    $('#sort').hidden = Boolean(state.vista);
    if (state.vista) return renderCupons();
    const pages = DATA.paginas;
    state.pagina = DATA.pagina;
    const pageItems = DATA.itens;

    const title = state.rel ? 'Promoção relâmpago' : state.tipo || (state.cat ? CATEGORIES[state.cat] : state.loja === 'parceiros' ? 'Lojas parceiras' : state.loja ? STORE_BY_ID[state.loja]?.name : 'Todas as ofertas');
    $('#results-title').textContent = !state.q ? title : DATA.aproximado ? `Nada exato para “${state.q}”: veja parecidos` : `Resultados para “${state.q}”`;
    $('#results-count').textContent = `${DATA.total.toLocaleString('pt-BR')} oferta${DATA.total === 1 ? '' : 's'}${DATA.resumo?.ultima_conferencia ? ` · preços conferidos ${timeAgo(DATA.resumo.ultima_conferencia)}` : ''}`;

    if (!pageItems.length) {
      $('#grid').innerHTML = emptyHtml();
    } else if (state.ordem === 'tipo') {
      // Agrupa pelo tipo de produto, com título de seção
      const html = [];
      let lastKey = null;
      const groupCount = DATA.grupos || {};
      let pos = 0;
      for (const o of pageItems) {
        const key = `${o.categoria}|${o.subcategoria}`;
        if (key !== lastKey) {
          const label = state.cat ? o.subcategoria : `${CATEGORIES[o.categoria] || 'Outros'} · ${o.subcategoria}`;
          html.push(`<div class="group-title">${esc(label)} <span>${groupCount[key]} oferta${groupCount[key] === 1 ? '' : 's'}</span></div>`);
          lastKey = key;
        }
        html.push(cardHtml(o, pos++));
      }
      $('#grid').innerHTML = html.join('');
    } else {
      $('#grid').innerHTML = pageItems.map((o, i) => cardHtml(o, i)).join('');
    }
    // Espaço de publicidade no meio da lista (depois da 8ª oferta da página)
    const cards = $('#grid').querySelectorAll('.card');
    if (cards.length > 8) {
      cards[7].insertAdjacentHTML('afterend', '<div class="ad-slot ad-wide ad-in-grid" data-espaco="meio" hidden></div>');
      window.GPAds?.fill($('#grid'));
    }
    renderPagination(pages);
  }

  function renderPagination(pages) {
    const cur = state.pagina;
    if (pages <= 1) { $('#pagination').innerHTML = ''; return; }
    const nums = new Set([1, pages, cur - 1, cur, cur + 1].filter(n => n >= 1 && n <= pages));
    const sorted = [...nums].sort((a, b) => a - b);
    const parts = [`<button class="page-btn" type="button" data-page="${cur - 1}" ${cur === 1 ? 'disabled' : ''} aria-label="Página anterior">‹</button>`];
    sorted.forEach((n, i) => {
      if (i && n - sorted[i - 1] > 1) parts.push('<span class="page-gap">…</span>');
      parts.push(`<button class="page-btn" type="button" data-page="${n}" ${n === cur ? 'aria-current="page"' : ''}>${n}</button>`);
    });
    parts.push(`<button class="page-btn" type="button" data-page="${cur + 1}" ${cur === pages ? 'disabled' : ''} aria-label="Próxima página">›</button>`);
    $('#pagination').innerHTML = parts.join('');
  }

  // Vitrine do topo: carrossel com um produto por vez (TV, notebook, console, celular, geladeira…), com a foto
  // inteira da loja num cartão branco com o selo do site, trocando sozinho com transição suave. A lista é renovada a cada 10 min. Se não houver produtos,
  // aparece o mascote (ele não pisca antes: começa escondido).
  const VIT = { itens: [], i: 0, timer: null, pausa: false };
  const VIT_MS = 5000;
  const vitImg = o => `/img/recorte/${o.id}.webp?c=3`; // ?c=3: cartão sem o selo do site (não usa a imagem antiga guardada no navegador)
  const preCarregar = o => new Promise(r => { const im = new Image(); im.onload = im.onerror = () => r(); im.src = vitImg(o); });

  function vitItem(o, ativo) {
    const nome = String(o.produto || '').replace(/\s+/g, ' ').trim();
    return `<a class="vitrine-item${ativo ? ' is-ativo' : ''}" href="/oferta/${slug(o)}" target="_blank" rel="noopener sponsored"
        title="${esc(nome)}" aria-label="${esc(o.nome)}: ${esc(nome)}, por R$ ${brl(o.preco_atual)}">
      <span class="vitrine-foto"><img src="${vitImg(o)}" alt="" decoding="async"></span>
      <span class="vitrine-preco"><b>-${Math.round(o.desconto_pct)}%</b>R$ ${brl(o.preco_atual)}</span>
      <span class="vitrine-nome"><small>${esc(o.nome)}</small>${esc(nome.length > 60 ? `${nome.slice(0, 58)}…` : nome)}</span>
    </a>`;
  }

  function vitIr(passo) {
    if (VIT.itens.length < 2) return;
    VIT.i = (VIT.i + passo + VIT.itens.length) % VIT.itens.length;
    const o = VIT.itens[VIT.i];
    preCarregar(o).then(() => {
      const palco = $('#vitrine-palco');
      const antigo = palco.querySelector('.vitrine-item.is-ativo');
      palco.insertAdjacentHTML('beforeend', vitItem(o, false));
      const novo = palco.lastElementChild;
      novo.classList.toggle('vem-da-esquerda', passo < 0);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        novo.classList.add('is-ativo');
        if (antigo) {
          antigo.classList.remove('is-ativo');
          antigo.classList.add(passo < 0 ? 'sai-direita' : 'sai-esquerda');
          setTimeout(() => antigo.remove(), 1200);
        }
      }));
      // Prepara a próxima foto enquanto esta aparece
      preCarregar(VIT.itens[(VIT.i + 1) % VIT.itens.length]);
    });
    vitAgendar();
  }

  function vitAgendar() {
    clearTimeout(VIT.timer);
    if (VIT.pausa || document.hidden || VIT.itens.length < 2) return;
    VIT.timer = setTimeout(() => vitIr(1), VIT_MS);
  }

  async function loadVitrine() {
    const v = $('#vitrine');
    if (getComputedStyle(v.parentElement).display === 'none') return; // tela sem a vitrine: nada a buscar
    try {
      const itens = await fetch('/api/vitrine', { cache: 'no-store' }).then(r => (r.ok ? r.json() : []));
      if (!Array.isArray(itens) || !itens.length) throw new Error('sem itens');
      const atual = VIT.itens[VIT.i];
      VIT.itens = itens;
      if (!$('#vitrine-palco').children.length) {
        // Primeira vez: começa num produto aleatório e só mostra depois que a foto carregou (sem piscar).
        VIT.i = Math.floor(Math.random() * itens.length);
        await preCarregar(itens[VIT.i]);
        $('#vitrine-palco').innerHTML = vitItem(itens[VIT.i], true);
        v.classList.remove('is-carregando');
        $('#vitrine-ctrl').hidden = itens.length < 2;
        preCarregar(itens[(VIT.i + 1) % itens.length]);
        vitAgendar();
      } else {
        // Lista renovada: continua de onde estava (se o produto atual ainda estiver na lista)
        const pos = atual ? itens.findIndex(x => x.id === atual.id) : -1;
        VIT.i = pos >= 0 ? pos : 0;
        $('#vitrine-ctrl').hidden = itens.length < 2;
      }
      $('#hero-pet').hidden = true;
      v.hidden = false;
    } catch {
      if (!VIT.itens.length) { v.hidden = true; $('#hero-pet').hidden = false; }
    }
  }

  $('#vitrine-ctrl').addEventListener('click', e => {
    const b = e.target.closest('[data-vit]');
    if (b) vitIr(Number(b.dataset.vit));
  });
  // Pausa enquanto o mouse está em cima (ou a aba está escondida); arrastar com o dedo troca de produto
  $('#vitrine').addEventListener('mouseenter', () => { VIT.pausa = true; vitAgendar(); });
  $('#vitrine').addEventListener('mouseleave', () => { VIT.pausa = false; vitAgendar(); });
  document.addEventListener('visibilitychange', vitAgendar);
  let toqueX = null;
  $('#vitrine').addEventListener('touchstart', e => { toqueX = e.touches[0].clientX; }, { passive: true });
  $('#vitrine').addEventListener('touchend', e => {
    if (toqueX === null) return;
    const dx = e.changedTouches[0].clientX - toqueX;
    toqueX = null;
    if (Math.abs(dx) > 40) vitIr(dx < 0 ? 1 : -1);
  });
  setInterval(loadVitrine, 10 * 60 * 1000);

  function renderHero() {
    const R = DATA.resumo || { total: 0, lojas: 0, maior_desconto: 0, ultima_conferencia: null, destaque: null };
    const stores = R.lojas, maxDisc = R.maior_desconto;
    $('#updated-at').textContent = R.total && R.ultima_conferencia ? `Preços conferidos ${timeAgo(R.ultima_conferencia)}` : 'Buscando ofertas nas lojas';
    $('#hero-stats').innerHTML = `
      <div class="hero-stat"><strong class="num">${R.total.toLocaleString('pt-BR')}</strong><span>ofertas no ar</span></div>
      <div class="hero-stat"><strong class="num">${stores}</strong><span>${stores === 1 ? 'loja' : 'lojas'} com ofertas</span></div>
      <div class="hero-stat"><strong class="num">${maxDisc ? `${Math.round(maxDisc)}%` : '—'}</strong><span>maior desconto</span></div>`;

    const best = R.destaque;
    const el = $('#featured');
    if (!best) { el.hidden = true; return; }
    el.href = `/oferta/${slug(best)}`;
    el.innerHTML = `<img src="/img/o/${best.id}.jpg" alt="">
      <div class="featured-body">
        <div class="featured-label">Destaque agora · -${Math.round(best.desconto_pct)}%</div>
        <div class="featured-title">${esc(best.produto)}</div>
        <div class="featured-price num">de <s>R$ ${brl(best.preco_anterior)}</s> por <b>R$ ${brl(best.preco_atual)}</b> · ${esc(STORE_BY_ID[best.store_id]?.name || best.plataforma)}</div>
      </div><svg width="20" height="20"><use href="#i-arrow"/></svg>`;
    el.hidden = false;
  }

  function render() {
    // Não mexe no campo enquanto a pessoa digita (a resposta do servidor chega depois e apagaria o que foi digitado)
    if (document.activeElement !== $('#q')) $('#q').value = state.q;
    $('#sort').value = state.ordem;
    renderStoreTabs();
    renderFilters();
    renderSubChips();
    renderActiveFilters();
    renderGrid();
    updateSelection();
  }

  // ── Eventos ──────────────────────────────────────────────────────────────
  function handleFilterClick(e) {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.loja !== undefined) return setFilter({ loja: t.dataset.loja });
    if (t.dataset.abrirCat !== undefined) return abrirCategoria(t.dataset.abrirCat);
    if (t.dataset.abrirCupons !== undefined) { cuponsAberto = !(cuponsAberto || state.cupom); return renderFilters(); }
    if (t.dataset.relampago !== undefined) {
      if ($('#filters-dialog').open) $('#filters-dialog').close();
      setFilter({ rel: !state.rel, cat: '', tipo: '' });
      $('#ofertas').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (t.dataset.verCupons !== undefined) {
      if ($('#filters-dialog').open) $('#filters-dialog').close();
      setFilter({ vista: 'cupons', rel: false, cat: '', tipo: '', q: '', min: null, max: null, desc: 0, com: '', cupom: '', loja: STORE_BY_ID[state.loja] ? state.loja : '' });
      $('#ofertas').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (t.dataset.verCats !== undefined) { verTodasCats = !verTodasCats; return renderFilters(); }
    if (t.dataset.subCat !== undefined) {
      const mesmo = state.cat === t.dataset.subCat && state.tipo === t.dataset.subTipo;
      return setFilter({ cat: t.dataset.subCat, tipo: mesmo ? '' : t.dataset.subTipo });
    }
    if (t.dataset.cat !== undefined) {
      const cat = t.dataset.cat === state.cat ? '' : t.dataset.cat; // tocar de novo na categoria escolhida tira o filtro
      catAberta = cat;
      return setFilter({ cat });
    }
    if (t.dataset.tipo !== undefined) return setFilter({ tipo: t.dataset.tipo });
    if (t.dataset.desc !== undefined) return setFilter({ desc: Number(t.dataset.desc) });
    if (t.dataset.com !== undefined) return setFilter({ com: t.dataset.com });
    if (t.dataset.cupom !== undefined) return setFilter({ cupom: t.dataset.cupom });
    if (t.dataset.remove) {
      const k = t.dataset.remove;
      return setFilter(k === 'preco' ? { min: null, max: null } : { [k]: k === 'desc' ? 0 : '' });
    }
    if (t.dataset.clear !== undefined) {
      return setFilter({ loja: '', cat: '', tipo: '', q: '', min: null, max: null, desc: 0, com: '', cupom: '', rel: false, vista: '' });
    }
  }

  function handlePriceSubmit(e) {
    const form = e.target.closest('[data-price-form]');
    if (!form) return;
    e.preventDefault();
    // Controle deslizante: vale a parada escolhida; a última significa "sem limite"
    if (e.target.name === 'ra' || e.target.name === 'rb') {
      const a = Number(form.ra.value), b = Number(form.rb.value);
      return setFilter({ min: a ? FAIXA_PRECO[a] : null, max: b === FAIXA_PRECO.length - 1 ? null : FAIXA_PRECO[b] });
    }
    const val = n => (form[n].value === '' ? null : Math.max(0, Number(form[n].value)));
    setFilter({ min: val('min'), max: val('max') });
  }

  // Enquanto arrasta: as bolinhas não se cruzam e o valor acompanha (a busca só roda ao soltar)
  function arrastarPreco(e) {
    if (e.target.name !== 'ra' && e.target.name !== 'rb') return;
    const form = e.target.closest('[data-price-form]');
    let a = Number(form.ra.value), b = Number(form.rb.value);
    if (a >= b) {
      if (e.target.name === 'ra') { a = b - 1; form.ra.value = a; } else { b = a + 1; form.rb.value = b; }
    }
    const ultimo = FAIXA_PRECO.length - 1;
    const min = a ? FAIXA_PRECO[a] : null, max = b === ultimo ? null : FAIXA_PRECO[b];
    form.querySelector('[data-preco-slider]').style.cssText = estiloPreco(a, b);
    form.querySelector('[data-preco-txt]').textContent = textoPreco(min, max);
    form.min.value = min ?? '';
    form.max.value = max ?? '';
  }

  for (const sel of ['#store-tabs', '#filters', '#filters-mobile', '#sub-chips', '#active-filters', '#grid']) {
    $(sel).addEventListener('click', handleFilterClick);
  }
  for (const sel of ['#filters', '#filters-mobile']) {
    $(sel).addEventListener('submit', handlePriceSubmit);
    $(sel).addEventListener('input', arrastarPreco);
    $(sel).addEventListener('change', e => {
      if (e.target.closest('[data-price-form]')) return handlePriceSubmit(e);
      if (e.target.name === 'rl-desc') setFilter({ desc: Number(e.target.value) });
    });
  }

  $('#pagination').addEventListener('click', e => {
    const b = e.target.closest('[data-page]');
    if (!b || b.disabled) return;
    setFilter({ pagina: Number(b.dataset.page) }, { keepPage: true });
    $('#ofertas').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('#sort').addEventListener('change', e => setFilter({ ordem: e.target.value }));

  let searchTimer;
  // Texto começando com # pesquisa perfis da comunidade (não filtra as ofertas).
  const buscaPerfil = v => v.trim().startsWith('#') && window.Comunidade;
  $('#q').addEventListener('input', e => {
    clearTimeout(searchTimer);
    if (buscaPerfil(e.target.value)) { window.Comunidade.buscar(e.target.value.trim()); return; }
    window.Comunidade?.fecharSugestoes();
    searchTimer = setTimeout(() => setFilter({ q: e.target.value.trim() }), 200);
  });
  // Celular: o teclado fecha ao confirmar uma pesquisa (qualquer formulário da página) e ao tocar fora do campo
  const digitando = el => el && (el.matches?.('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea') || el.isContentEditable);
  document.addEventListener('submit', () => { if (digitando(document.activeElement)) document.activeElement.blur(); }, true);
  document.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch' || !digitando(document.activeElement)) return;
    // tocar em outro campo (ou no próprio) não fecha: o teclado continua para ele
    if (digitando(e.target) || e.target.closest?.('label, select, [contenteditable]')) return;
    document.activeElement.blur();
  }, true);

  // ── Termo novo vira mineração: avisa enquanto as lojas são consultadas e quando as ofertas ficam prontas ──
  let minaTermo = '', minaTimer = null, minaAuto = null, minaTentativas = 0;
  const minaJaPedidos = new Set();
  function mostrarMina(tipo, termo, gravadas = 0) {
    const el = $('#mina-aviso');
    el.className = `mina-aviso mina-${tipo}`;
    el.hidden = false;
    if (tipo === 'minerando') {
      el.innerHTML = `<span class="mina-roda" aria-hidden="true"></span><div><b>Aguarde, a sua oferta está sendo minerada agora.</b><br>Iremos te avisar para recarregar a página quando suas ofertas de “${esc(termo)}” estiverem prontas!</div>`;
    } else if (tipo === 'pronto') {
      el.innerHTML = `<div><b>Suas ofertas de “${esc(termo)}” estão prontas!</b><br>${gravadas.toLocaleString('pt-BR')} oferta${gravadas === 1 ? '' : 's'} encontrada${gravadas === 1 ? '' : 's'} nas lojas.</div><button class="btn btn-primary" type="button" id="mina-recarregar">Recarregar a página</button>`;
      $('#mina-recarregar').addEventListener('click', () => location.reload());
      document.title = `✓ Ofertas prontas | ${document.title.replace(/^✓ Ofertas prontas \| /, '')}`;
    } else if (tipo === 'sem') {
      el.innerHTML = `<div><b>As lojas não têm “${esc(termo)}” com desconto agora.</b><br>Confira se está escrito certo ou tente outras palavras.</div>`;
    } else {
      el.innerHTML = '<div><b>Muitas buscas novas agora.</b><br>Tente de novo em alguns minutos para minerarmos essa oferta.</div>';
    }
    if (DATA.total === 0 && state.q) renderGrid();
  }
  function esconderMina() { clearTimeout(minaTimer); minaTermo = ''; $('#mina-aviso').hidden = true; }
  function tratarMina(r, termo) {
    if (termo !== minaTermo) return;
    if (r.status === 'minerando') {
      mostrarMina('minerando', termo);
      if (++minaTentativas > 60) return esconderMina(); // 5 minutos: não fica perguntando para sempre
      minaTimer = setTimeout(() => fetch(`/api/offers/termo?q=${encodeURIComponent(termo)}`).then(x => x.json()).then(d => tratarMina(d, termo)).catch(() => {}), 5000);
    } else if (r.status === 'pronto') { mostrarMina('pronto', termo, r.gravadas); toast(`Suas ofertas de “${termo}” estão prontas! Recarregue a página.`); }
    else if (r.status === 'sem_ofertas') mostrarMina('sem', termo);
    else if (r.status === 'limite') mostrarMina('limite', termo);
    else esconderMina();
  }
  // Busca confirmada: conta nos mais pesquisados e, se o termo é novo, começa a minerar
  function pedirMineracao(q) {
    q = String(q || '').trim();
    clearTimeout(minaAuto);
    if (!q || q.startsWith('#') || minaJaPedidos.has(q.toLowerCase())) return;
    minaJaPedidos.add(q.toLowerCase());
    clearTimeout(minaTimer);
    minaTermo = q; minaTentativas = 0;
    fetch('/api/offers/termo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q }) })
      .then(r => r.json()).then(d => tratarMina(d, q)).catch(() => {});
  }

  $('#search-form').addEventListener('submit', e => {
    e.preventDefault();
    if (buscaPerfil($('#q').value)) { window.Comunidade.buscar($('#q').value.trim(), true); return; }
    setFilter({ q: $('#q').value.trim() });
    pedirMineracao($('#q').value);
    $('#ofertas').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Gaveta de filtros (celular)
  $('#open-filters').addEventListener('click', () => {
    $('#filters-mobile').innerHTML = filtersHtml();
    $('#filters-dialog').showModal();
  });
  // Celular: a folha de filtros acompanha o dedo; arrastar para baixo fecha (na lista, só com a lista já no topo)
  (() => {
    const dlg = $('#filters-dialog'), folha = dlg.querySelector('.drawer'), lista = $('#filters-mobile');
    const celular = matchMedia('(max-width: 720px)');
    let inicioY = null, inicioT = 0, dy = 0, arrastando = false;
    const soltar = (voltar = true) => {
      folha.style.transition = voltar ? 'transform .18s ease-out' : '';
      folha.style.transform = '';
      inicioY = null; dy = 0; arrastando = false;
    };
    folha.addEventListener('touchstart', e => {
      if (!celular.matches || e.touches.length !== 1 || e.target.closest('input, select, textarea, .modal-foot')) { inicioY = null; return; }
      inicioY = e.touches[0].clientY; inicioT = Date.now(); dy = 0; arrastando = false;
      folha.style.transition = 'none';
    }, { passive: true });
    folha.addEventListener('touchmove', e => {
      if (inicioY === null) return;
      dy = e.touches[0].clientY - inicioY;
      if (!arrastando) {
        if (dy < 6) { if (dy < -6) inicioY = null; return; } // subindo: é rolagem da lista
        if (lista.contains(e.target) && lista.scrollTop > 0) { inicioY = null; return; }
        arrastando = true;
      }
      e.preventDefault();
      folha.style.transform = `translateY(${Math.max(0, dy)}px)`;
    }, { passive: false });
    const fim = () => {
      if (inicioY === null || !arrastando) { inicioY = null; folha.style.transition = ''; return; }
      const rapido = dy > 40 && dy / Math.max(1, Date.now() - inicioT) > 0.5;
      if (dy > 90 || rapido) {
        folha.style.transition = 'transform .16s ease-in';
        folha.style.transform = 'translateY(100%)';
        inicioY = null; arrastando = false;
        setTimeout(() => { dlg.close(); soltar(false); }, 160);
      } else soltar();
    };
    folha.addEventListener('touchend', fim);
    folha.addEventListener('touchcancel', fim);
  })();
  document.querySelectorAll('dialog').forEach(d => {
    d.addEventListener('click', e => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
  });

  // ── Escolha de produtos para postar (admin e usuários liberados) ──────────
  // Escolher não sai da página: os produtos ficam guardados e aparecem todos na tela de postagens.
  function updateSelection() {
    const n = selected.size;
    saveSelection();
    $('#sel-count').textContent = `${n} selecionada${n === 1 ? '' : 's'}`;
    $('#sel-count').classList.toggle('has-items', n > 0);
    $('#posts-dock').hidden = !n || !document.body.classList.contains('can-post');
    $('#dock-count').textContent = n;
    $('#dock-label').textContent = n === 1 ? 'produto escolhido' : 'produtos escolhidos';
  }

  $('#grid').addEventListener('click', e => {
    const b = e.target.closest('[data-select]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const id = Number(b.dataset.select);
    selected.has(id) ? selected.delete(id) : selected.add(id);
    b.closest('.card').classList.toggle('is-selected', selected.has(id));
    updateSelection();
  });

  // Cupom: tocar no código copia; tocar no cartão também copia e já abre a loja (é só colar no carrinho)
  async function copiarCupom(codigo) {
    try { await navigator.clipboard.writeText(codigo); toast(`Cupom ${codigo} copiado! Cole no carrinho da loja.`); }
    catch { toast(`Use o cupom ${codigo} no carrinho da loja.`); }
  }
  $('#grid').addEventListener('click', e => {
    if (e.target.closest('[data-select], [data-enviar]')) return;
    const verOfertas = e.target.closest('[data-ver-ofertas-cupom]');
    if (verOfertas) {
      setFilter({ vista: '', cupom: verOfertas.dataset.verOfertasCupom, loja: '' });
      $('#ofertas').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const b = e.target.closest('[data-copiar-cupom]');
    if (b) { e.preventDefault(); e.stopPropagation(); return copiarCupom(b.dataset.copiarCupom); }
    // Cupom do Mercado Livre: o botão abre a central de cupons (lá a pessoa toca em "Aplicar"); o cartão só avisa
    const ml = e.target.closest('[data-cupom-ml]');
    if (ml) { e.preventDefault(); e.stopPropagation(); window.open(CENTRAL_ML, '_blank', 'noopener'); return toast(`Ative o cupom “${ml.dataset.cupomMl}” em Cupons do Mercado Livre antes de comprar.`); }
    const mlCard = e.target.closest('.card')?.querySelector('[data-cupom-ml]');
    if (mlCard) toast(`Antes de pagar, ative o cupom “${mlCard.dataset.cupomMl}” em Cupons no Mercado Livre.`);
    const card = e.target.closest('.card');
    const cod = card?.querySelector('[data-copiar-cupom]')?.dataset.copiarCupom;
    if (cod) copiarCupom(cod);
  });

  // Botão "Enviar para os grupos" do cartão: todos os grupos de WhatsApp escolhidos no painel ou um deles
  $('#grid').addEventListener('click', async e => {
    const b = e.target.closest('[data-enviar]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    if (b.disabled) return;
    const UI = window.OfertouUI;
    let d;
    try { d = await (await fetch('/api/postagens/grupos', { cache: 'no-store' })).json(); } catch { return toast('Sem conexão. Tente de novo.'); }
    if (d.error || d.erro) return UI.avisar(d.error || d.erro, { titulo: 'WhatsApp não está pronto' });
    if (!d.grupos?.length) return UI.avisar('Escolha os grupos de destino no painel (WhatsApp) para enviar as ofertas direto daqui.', { titulo: 'Nenhum grupo escolhido' });
    const nome = b.closest('.card')?.querySelector('.card-title')?.textContent || 'esta oferta';
    const opcoes = [{ valor: 'todos', nome: `Todos os grupos (${d.grupos.length})` }, ...d.grupos.map(g => ({ valor: g.id, nome: g.nome }))];
    const grupo = d.grupos.length === 1 ? (await UI.confirmar(`Enviar “${nome}” para o grupo ${d.grupos[0].nome}?`, { titulo: 'Enviar para o grupo', ok: 'Enviar' }) ? 'todos' : null)
      : await UI.escolher(`Para onde enviar “${nome}”? A mensagem sai com o seu modelo de mensagem e o seu link de afiliado.`, opcoes, { titulo: 'Enviar para os grupos', ok: 'Enviar' });
    if (!grupo) return;
    b.disabled = true;
    try {
      const r = await fetch('/api/postagens/enviar-grupos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ offer_id: Number(b.dataset.enviar), grupo }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return UI.avisar(j.error || 'Não foi possível enviar.', { titulo: 'Não enviou' });
      b.classList.add('is-enviado');
      b.lastChild.textContent = 'Enviando…';
      toast(j.grupos > 1 ? `Enviando para ${j.grupos} grupos (com uma pausa entre eles).` : 'Enviando para o grupo.');
      setTimeout(() => { b.lastChild.textContent = 'Enviado'; }, 4000);
    } catch { toast('Sem conexão. Tente de novo.'); }
    finally { setTimeout(() => { b.disabled = false; }, 4000); }
  });

  $('#sel-page').addEventListener('click', () => {
    const page = DATA.itens;
    const antes = selected.size;
    page.forEach(o => selected.add(o.id));
    renderGrid(); updateSelection();
    toast(`${selected.size - antes} produto(s) da página adicionados.`);
  });
  $('#sel-clear').addEventListener('click', () => { selected.clear(); renderGrid(); updateSelection(); toast('Seleção limpa.'); });

  $('#sel-mix').addEventListener('click', async () => {
    let ids = [];
    try { ids = (await fetch(`/api/offers/mix?loja=${encodeURIComponent(state.loja)}`).then(r => r.json())).ids || []; } catch { return toast('Não foi possível escolher agora.'); }
    const novos = ids.filter(id => !selected.has(id)).length;
    ids.forEach(id => selected.add(id));
    renderGrid(); updateSelection();
    toast(`${novos} produto(s) adicionados: o melhor de cada categoria (${ids.length} categorias).`);
  });

  // Busca um termo nas lojas na hora (útil para produtos que não estão na lista de mineração automática).
  // O campo fica na própria barra de postagens: digita e aperta Enter.
  $('#mine-form').addEventListener('submit', async e => {
    e.preventDefault();
    const inp = $('#mine-q');
    const q = inp.value.trim();
    if (!q) { inp.focus(); return toast('Digite o produto que quer procurar nas lojas e aperte Enter.'); }
    if (inp.readOnly) return;
    inp.readOnly = true;
    $('#mine-form').classList.add('is-busy');
    toast(`Buscando “${q}” nas lojas…`);
    try {
      const r = await fetch('/api/admin/mine', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }),
      });
      const res = await r.json().catch(() => ({}));
      if (!r.ok || res.error) throw new Error(res.error || `Erro ${r.status}`);
      const saved = (res.results || []).reduce((a, x) => a + (x.saved || 0), 0);
      const lojas = (res.results || []).filter(x => x.saved).map(x => `${STORE_BY_ID[x.store]?.name || x.store} ${x.saved}`).join(', ');
      await loadOffers();
      if (saved) { // mostra na lista o que foi encontrado
        $('#q').value = q;
        setFilter({ q });
      }
      toast(saved ? `${saved} ofertas com desconto real (${lojas}). A lista abaixo já mostra o resultado.` : 'As lojas não têm esse produto com desconto real agora.');
    } catch (err) {
      toast(err.message === 'Failed to fetch' ? 'Erro de conexão com o servidor.' : err.message);
    } finally {
      inp.readOnly = false;
      $('#mine-form').classList.remove('is-busy');
    }
  });

  // ── Utilidades ───────────────────────────────────────────────────────────
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }

  function applySettings(s) {
    const https = u => (/^https:\/\//i.test(u || '') ? u : '');
    const wa = https(s.whatsapp_link);
    const tgRaw = (s.telegram_link || '').trim();
    const tg = tgRaw ? https(tgRaw.startsWith('http') ? tgRaw : `https://t.me/${tgRaw.replace('@', '')}`) : '';
    const ig = (s.instagram_user || '').replace(/^@/, '').replace(/[^\w.]/g, '');
    if (wa) {
      $('#wa-header').href = wa; $('#wa-header').hidden = false;
      $('#wa-faixa').href = wa; $('#wa-faixa').hidden = false;
      $('#wa-community').href = wa; $('#community').hidden = false;
    }
    const links = [];
    if (wa) links.push(`<a href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>`);
    if (tg) links.push(`<a href="${esc(tg)}" target="_blank" rel="noopener">Telegram</a>`);
    if (ig) links.push(`<a href="https://instagram.com/${esc(ig)}" target="_blank" rel="noopener">Instagram</a>`);
    $('#footer-links').innerHTML = links.join('');

    // Google Analytics só com o aceite no aviso de cookies (agora ou quando a pessoa aceitar)
    const ligarGA = () => {
      if (!/^G-[A-Z0-9]{4,20}$/.test(s.ga_id || '') || window.gtag || window.OfertouCookies?.aceitou() !== true) return;
      const sc = document.createElement('script');
      sc.async = true; sc.src = `https://www.googletagmanager.com/gtag/js?id=${s.ga_id}`;
      document.head.appendChild(sc);
      window.dataLayer = window.dataLayer || [];
      window.gtag = function () { window.dataLayer.push(arguments); };
      window.gtag('js', new Date()); window.gtag('config', s.ga_id);
    };
    ligarGA();
    window.addEventListener('ofertou:cookies', ligarGA);
  }

  // Pede ao servidor só a página atual (com os filtros da URL). Pedidos antigos são cancelados.
  let pedidoAtual = null;
  const SEMENTE = Math.random().toString(36).slice(2, 10);
  async function loadOffers() {
    pedidoAtual?.abort();
    const ctrl = pedidoAtual = new AbortController();
    const p = new URLSearchParams();
    for (const k of ['loja', 'cat', 'tipo', 'q', 'ordem']) if (state[k]) p.set(k, state[k]);
    if (state.min != null) p.set('min', state.min);
    if (state.max != null) p.set('max', state.max);
    if (state.desc) p.set('desc', state.desc);
    if (state.com) p.set('com', state.com);
    if (state.cupom) p.set('cupom', state.cupom);
    if (state.rel) p.set('relampago', '1');
    p.set('pagina', state.pagina);
    p.set('por', PER_PAGE);
    p.set('sem', SEMENTE); // embaralha a comissão extra a cada visita (mesma ordem nas páginas seguintes)
    if (carregou) $('#grid').classList.add('is-loading');
    try {
      const r = await fetch(`/api/offers/busca?${p}`, { signal: ctrl.signal });
      if (!r.ok) throw new Error(String(r.status));
      DATA = await r.json();
    } catch (err) {
      if (err.name === 'AbortError') return;
    } finally {
      if (pedidoAtual === ctrl) $('#grid').classList.remove('is-loading');
    }
    if (pedidoAtual !== ctrl) return;
    carregou = true;
    // Busca sem resultado: se a pessoa parou de digitar, já minera (sem esperar ela confirmar)
    clearTimeout(minaAuto);
    if (state.q && !PAGINA_SEO && (!DATA.total || DATA.aproximado)) { const q = state.q; minaAuto = setTimeout(() => { if (state.q === q) pedirMineracao(q); }, 1500); }
    if (minaTermo && state.q.toLowerCase() !== minaTermo.toLowerCase()) esconderMina();
    if (state.pagina !== DATA.pagina) { state.pagina = DATA.pagina; writeUrl(); }
    renderHero();
    render();
  }

  // ── Início ───────────────────────────────────────────────────────────────
  $('#year').textContent = new Date().getFullYear();
  readUrl();
  if (state.q && !PAGINA_SEO) setTimeout(() => pedirMineracao(state.q), 300); // abriu um link de busca
  // Mais pesquisados e mais clicados, no fim da página
  if (new URLSearchParams(location.search).has('expirada')) {
    $('#expired-notice').hidden = false;
    history.replaceState(null, '', location.pathname);
  }
  if (state.vista) setTimeout(() => $('#ofertas')?.scrollIntoView({ block: 'start' }), 0); // veio do "Ver mais" da lista de cupons
  if (!$('#grid').children.length) $('#grid').innerHTML = Array.from({ length: 8 }, () => '<div class="skeleton"></div>').join(''); // (a página de categoria já vem com as ofertas)

  fetch('/api/settings/public').then(r => r.json()).then(applySettings).catch(() => {});
  // Perfil + Minha conta + Sair num botão só (com a foto e o nome do perfil), para qualquer pessoa logada:
  // conta do site, cliente da ferramenta ou admin. Sem login, fica o "Entrar".
  const mostrarConta = () => { $('#account-link').hidden = true; $('#conta-btn').hidden = false; };
  window.ofertouSessao().then(logado => (logado ? fetch('/api/perfil', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)) : null)).then(p => {
    if (!p) return;
    mostrarConta();
    if (p.nome) $('#conta-nome').textContent = p.nome.split(' ')[0].slice(0, 16);
    if (p.avatar) { $('#perfil-link-img').src = p.avatar; $('#perfil-link-img').hidden = false; }
    if (p.slug) $('#perfil-link-img').dataset.mini = p.slug; // passar o mouse na foto mostra a prévia do perfil (comunidade.js)
  }).catch(() => {});
  fetch('/api/conta/me').then(r => r.json()).then(d => { if (d.user) mostrarConta(); }).catch(() => {});
  // Menu da conta (fica fora da barra do topo para não ser cortado no celular)
  const contaPop = $('#conta-pop');
  function fecharConta() { contaPop.hidden = true; $('#conta-btn').setAttribute('aria-expanded', 'false'); }
  $('#conta-btn').addEventListener('click', e => {
    e.stopPropagation();
    if (!contaPop.hidden) return fecharConta();
    const r = e.currentTarget.getBoundingClientRect();
    contaPop.style.top = `${Math.round(r.bottom + 8)}px`;
    contaPop.style.right = `${Math.max(8, Math.round(document.documentElement.clientWidth - r.right))}px`;
    contaPop.hidden = false;
    $('#conta-btn').setAttribute('aria-expanded', 'true');
  });
  document.addEventListener('click', e => { if (!contaPop.hidden && !e.target.closest('#conta-pop')) fecharConta(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') fecharConta(); });
  window.addEventListener('scroll', fecharConta, { passive: true });
  window.addEventListener('resize', fecharConta);
  $('#logout-site').addEventListener('click', async () => {
    await fetch('/api/conta/sair', { method: 'POST' });
    await fetch('/api/admin/logout', { method: 'POST' });
    await fetch('/api/cliente/sair', { method: 'POST' });
    location.href = '/conta';
  });
  fetch('/api/admin/session').then(r => r.json()).then(s => {
    isAdmin = Boolean(s.loggedIn);
    document.body.classList.toggle('is-admin', isAdmin);
    if (isAdmin) {
      mostrarConta();
      $('#conta-link').href = '/admin';
      $('#conta-perfil-link').hidden = false; // admin não tem "Minha conta": o perfil fica em /perfil
      $('#conta-link-txt').textContent = 'Painel do administrador';
      $('#conta-link-sub').textContent = 'Ofertas, usuários, planos e configurações';
    }
  }).catch(() => {});
  // Ferramentas de postagem: admin ou usuário liberado pelo admin.
  fetch('/api/postagens/permissao').then(r => r.json()).then(p => {
    document.body.classList.toggle('can-post', Boolean(p.pode));
    // Admin, equipe e afiliados: selos de comissão, filtro e a ordem "Comissão extra"
    document.body.classList.toggle('ve-comissao', Boolean(p.comissao));
    if (p.comissao && !$('#sort option[value=comissao]')) {
      $('#sort option[value=destaques]').insertAdjacentHTML('afterend', '<option value="comissao">Comissão extra primeiro</option>');
      $('#sort').value = state.ordem;
    }
    if (p.pode) updateSelection();
    if (p.cliente) { // cliente da ferramenta: atalho para o painel dele
      mostrarConta();
      $('#conta-link').href = '/cliente';
      $('#conta-perfil-link').hidden = false;
      $('#conta-link-txt').textContent = 'Meu painel de afiliado';
      $('#conta-link-sub').textContent = 'Links, redes e postagens';
    }
  }).catch(() => {});

  loadOffers();
  loadVitrine();
  setInterval(loadOffers, 5 * 60 * 1000);
})();
