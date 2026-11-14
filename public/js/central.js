// Central: todas as áreas do Ofertou! numa guia só. Cada área abre no seu quadro e continua carregada ao trocar de área.
// As páginas falam com esta tela por window.top.OfertouCentral (ver public/js/tema.js).
(() => {
  'use strict';
  if (window.top !== window) { window.top.location.href = '/central'; return; }

  const ICONES = {
    ofertas: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="8" cy="8" r="1.4"/>',
    postagens: '<path d="M21 3 10.5 13.5"/><path d="M21 3l-6.5 18-4-7.500L3 9.500z"/>',
    afiliado: '<path d="M10 14a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.2 1.2"/><path d="M14 10a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.2-1.2"/>',
    loja: '<path d="M4 9.5 5.5 4h13L20 9.5"/><path d="M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0"/><path d="M5.5 12.5V20h13v-7.5"/>',
    conta: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>',
    equipe: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.4a6.5 6.5 0 0 1 3.5 5.6"/>',
    admin: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
  };
  const ABAS_DA_LOJA = ['painel', 'loja', 'anuncios', 'vendas'];
  const menu = document.getElementById('central-menu');
  const caixa = document.getElementById('central-quadros');
  const quadros = {};
  let areas = [];
  let visualizar = [];
  let atual = null;

  const tem = id => areas.some(a => a.id === id);
  const caminhoDe = u => u.pathname + u.search + u.hash;

  // Links que continuam abrindo como antes: saída para as lojas, arquivos e downloads
  const foraDaCentral = p => /^\/(ir|oferta|o|g|api|uploads|images|css|js|extensao)(\/|$)/.test(p) || /\.[a-z0-9]+$/i.test(p);
  // Páginas que levam a pagamento ou login em outro site, que não abrem dentro de um quadro
  const guiaInteira = p => /^\/assinar(\/|$)/.test(p) || /^\/api\/conta\/google/.test(p);

  function secaoDe(u) {
    const p = u.pathname;
    if (/^\/postagens\/?$/.test(p) && !u.searchParams.has('embed') && tem('postagens')) return 'postagens';
    if (/^\/admin\/?$/.test(p)) return tem('admin') ? 'admin' : null;
    if (/^\/cliente\/?$/.test(p)) return tem('afiliado') ? 'afiliado' : null;
    if (/^\/(trabalho|moderacao|equipe)\/?$/.test(p)) return tem('equipe') ? 'equipe' : tem('admin') ? 'admin' : null;
    if (/^\/conta\/?$/.test(p)) {
      if (u.searchParams.has('voltar') || u.searchParams.has('erro')) return null; // tela de login
      if (tem('loja') && ABAS_DA_LOJA.includes(u.searchParams.get('aba'))) return 'loja';
      return tem('conta') ? 'conta' : tem('loja') ? 'loja' : null;
    }
    return tem('ofertas') ? 'ofertas' : null;
  }

  function desenharMenu() {
    const logo = '<img class="central-logo" src="/images/logo-ofertou.png" alt="Ofertou!">';
    // Tema (claro, escuro ou automático) no pé da barra, no computador; no celular ele fica no menu da conta
    const tema = '<div class="central-tema"><span>Tema</span><div data-tema-controle class="so-icones"></div></div>';
    menu.innerHTML = logo + areas.map(a => `<button type="button" data-area="${a.id}"${a.id === atual ? ' aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${ICONES[a.id] || ''}</svg>${a.nome}</button>`).join('') + tema;
  }

  function guardarEndereco() {
    const f = quadros[atual];
    if (!f) return;
    try {
      const l = f.contentWindow.location;
      if (l.href === 'about:blank') return;
      history.replaceState(null, '', `/central?a=${atual}&p=${encodeURIComponent(l.pathname + l.search + l.hash)}`);
      document.title = f.contentDocument.title || 'Ofertou!';
    } catch { /* quadro em outro site */ }
  }

  function criarQuadro(id) {
    const f = document.createElement('iframe');
    f.title = areas.find(a => a.id === id)?.nome || 'Ofertou!';
    f.hidden = true;
    f.dataset.area = id;
    f.addEventListener('load', () => aoCarregar(id, f));
    caixa.append(f);
    quadros[id] = f;
    return f;
  }

  // Produtos marcados na tela de ofertas: se mudaram enquanto Postagens estava fechada, ela abre de novo com a escolha nova
  const selecao = () => { try { return localStorage.getItem('gp_postagens') || ''; } catch { return ''; } };
  let selecaoVista = null;

  function ativar(id, caminho) {
    const area = areas.find(a => a.id === id);
    if (!area) return;
    if (atual === 'postagens' && id !== 'postagens') selecaoVista = selecao();
    atual = id;
    const f = quadros[id] || criarQuadro(id);
    let agora = null;
    try { const l = f.contentWindow.location; if (l.href !== 'about:blank') agora = caminhoDe(l); } catch { /* ainda sem página */ }
    const escolhaNova = id === 'postagens' && agora && selecaoVista !== null && selecaoVista !== selecao();
    if (caminho ? caminho !== agora || escolhaNova : !agora || escolhaNova) f.src = caminho || area.inicio;
    Object.entries(quadros).forEach(([k, q]) => { q.hidden = k !== id; });
    menu.querySelectorAll('button').forEach(b => {
      if (b.dataset.area === id) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    guardarEndereco();
  }

  async function lerAreas() {
    const r = await fetch('/api/central', { cache: 'no-store' });
    const d = await r.json();
    const mudou = d.areas.map(a => a.id).join() !== areas.map(a => a.id).join();
    areas = d.areas;
    visualizar = d.visualizar || [];
    if (mudou) desenharMenu();
    return d;
  }

  async function aoCarregar(id, f) {
    let u;
    try {
      const l = f.contentWindow.location;
      if (l.href === 'about:blank') return;
      u = new URL(l.href);
    } catch { return; }
    let d;
    try { d = await lerAreas(); } catch { return; }
    // Saiu da conta: sem área de trabalho, a página segue na guia inteira
    if (!d.trabalho) { location.href = caminhoDe(u); return; }
    if (guiaInteira(u.pathname)) { location.href = caminhoDe(u); return; }
    const destino = secaoDe(u);
    if (!destino) { location.href = caminhoDe(u); return; }
    // Minha loja e Minha conta são a mesma página (/conta), que tira o ?aba= do endereço depois de abrir
    const mesmaPagina = ['loja', 'conta'].includes(id) && ['loja', 'conta'].includes(destino);
    if (destino !== id && !mesmaPagina) {
      f.src = 'about:blank';
      ativar(destino, caminhoDe(u));
      return;
    }
    if (id === atual) guardarEndereco();
  }

  // Chamado pelas páginas quando alguém clica num link. Responde true quando a central cuidou dele.
  function abrir(href, alvo, origem) {
    let u;
    try { u = new URL(href); } catch { return false; }
    if (!/^https?:$/.test(u.protocol)) return false;
    const novaGuia = Boolean(alvo) && alvo !== '_self';
    if (u.origin !== location.origin) {
      if (novaGuia) return false;
      location.href = u.href; // sites de fora não abrem em quadro
      return true;
    }
    if (foraDaCentral(u.pathname) && !guiaInteira(u.pathname)) return false;
    if (guiaInteira(u.pathname)) { location.href = caminhoDe(u); return true; }
    const destino = secaoDe(u);
    if (!destino) { location.href = caminhoDe(u); return true; }
    const quadroPrincipal = Object.values(quadros).some(f => f.contentWindow === origem);
    if (!novaGuia && (!quadroPrincipal || quadros[destino]?.contentWindow === origem)) return false; // navega no próprio quadro
    ativar(destino, caminhoDe(u));
    return true;
  }
  window.OfertouCentral = { abrir, visualiza: id => visualizar.includes(id) };

  menu.addEventListener('click', e => {
    const b = e.target.closest('button[data-area]');
    if (b) ativar(b.dataset.area);
  });

  (async () => {
    const d = await lerAreas();
    const q = new URLSearchParams(location.search);
    let p = q.get('p') || '';
    if (!/^\/(?!\/)/.test(p)) p = '';
    if (!d.trabalho) { location.href = p || '/'; return; }
    p += p.includes('#') ? '' : location.hash;
    const u = p ? new URL(p, location.origin) : null;
    const destino = u ? secaoDe(u) : null;
    if (u && !destino) { location.href = p; return; }
    // Ao recarregar, /conta volta para a área em que estava
    const pedida = q.get('a');
    const certa = destino === 'conta' && pedida === 'loja' && tem('loja') ? 'loja' : destino;
    ativar(certa || areas[0].id, u ? (certa === 'loja' && u.pathname === '/conta' && !u.search ? '/conta?aba=painel' : p) : undefined);
  })().catch(() => { location.href = '/'; });
})();
