// A Capi minerando ofertas: animações feitas a partir dos vídeos da Capi (recortados em video/capi/recortar.js)
// e tocadas quadro a quadro a partir de uma folha WebP (public/images/capi-anim/).
// Quando aparece é configurado no painel (Mineração → Capi minerando) e chega por /api/mineracao/status:
//   capi.so_mineracao: só enquanto a mineração está rodando (ou o tempo todo);
//   capi.intervalo: segundos entre o fim de um clipe e o começo do próximo.
// Para ver na hora, em qualquer página: acrescente ?capi=teste ao endereço.
(() => {
  if (window.CapiMinerando || window.top !== window) return;
  const CONSULTA_MS = 30000;          // de quanto em quanto tempo confere a configuração e se está minerando
  const TESTE = /[?&]capi=teste\b/.test(location.search);
  const PASTA = '/images/capi-anim/';
  const ORDEM = ['capi3', 'capi2']; // capi3: sentada cavando · capi2: vídeo 2
  const reduzido = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const css = document.createElement('style');
  css.textContent = `
  .cm { position: fixed; z-index: 2147483000; left: calc(12px + env(safe-area-inset-left, 0px)); bottom: calc(12px + env(safe-area-inset-bottom, 0px));
    width: 240px; pointer-events: none; font-family: Figtree, system-ui, sans-serif; display: grid; justify-items: start;
    animation: cm-entra .5s cubic-bezier(.2,1.4,.4,1) both; }
  .cm.saindo { animation: cm-sai .45s ease-in forwards; }
  .cm-balao { position: relative; margin: 0 0 6px 26px; background: #fff; color: #161b18; border-radius: 14px; padding: 7px 11px;
    font-size: 13px; font-weight: 700; line-height: 1.25; box-shadow: 0 6px 20px -6px rgba(0,0,0,.4); transform-origin: 15% 100%;
    animation: cm-pop .35s .35s cubic-bezier(.2,1.6,.4,1) both; white-space: nowrap; }
  .cm-balao::after { content: ""; position: absolute; left: 22px; bottom: -7px; border: 8px solid transparent; border-top-color: #fff; border-bottom: 0; }
  .cm-balao b { color: #0a7a43; }
  .cm-balao.troca { animation: cm-pop .35s cubic-bezier(.2,1.6,.4,1) both; }
  .cm-quadro { position: relative; width: 210px; height: 210px; }
  .cm-quadro canvas { width: 100%; height: 100%; display: block; }
  .cm.recorte canvas { filter: drop-shadow(0 6px 8px rgba(0,0,0,.35)); }
  .cm.cenario .cm-quadro { width: 150px; height: 150px; border-radius: 22px; overflow: hidden; border: 3px solid #fff;
    box-shadow: 0 10px 28px -8px rgba(0,0,0,.55); background: #2a2116; }
  @keyframes cm-entra { from { transform: translateY(120%) scale(.85); opacity: 0; } to { transform: none; opacity: 1; } }
  @keyframes cm-sai { to { transform: translateY(120%) scale(.85); opacity: 0; } }
  @keyframes cm-pop { from { transform: scale(0); opacity: 0; } to { transform: none; opacity: 1; } }
  @media (max-width: 480px) { .cm { width: 170px; } .cm-quadro { width: 120px; height: 120px; } .cm.cenario .cm-quadro { width: 96px; height: 96px; } .cm-balao { font-size: 12px; padding: 5px 9px; margin-left: 14px; } }
  @media (prefers-reduced-motion: reduce) { .cm, .cm * { animation-duration: 1ms !important; } }`;
  document.head.appendChild(css);

  // Folhas de quadros: carregadas só na primeira vez que forem usadas
  let meta = null;
  const folhas = {};
  async function carregar(nome) {
    meta ||= await fetch(`${PASTA}animacoes.json?v=20261332`).then(r => r.json());
    const m = meta[nome];
    if (!folhas[nome]) {
      const img = new Image();
      img.src = PASTA + m.arquivo + '?v=20261332';
      // onload em vez de img.decode(): o decode() pode ficar pendurado em alguns navegadores
      folhas[nome] = new Promise((ok, erro) => {
        img.onload = () => ok(img);
        img.onerror = () => { delete folhas[nome]; erro(new Error('imagem')); };
        if (img.complete && img.naturalWidth) ok(img);
      });
    }
    return { m, img: await folhas[nome] };
  }

  let aberto = null, vez = 0;
  async function mostrar(nome) {
    if (aberto || document.hidden) return false;
    nome ||= ORDEM[vez++ % ORDEM.length];
    aberto = true;
    let anim;
    try { // se demorar demais para carregar, desiste desta vez (não trava as próximas)
      anim = await Promise.race([carregar(nome), new Promise((_, erro) => setTimeout(() => erro(new Error('demorou')), 15000))]);
    } catch { aberto = null; return false; }
    const { m, img } = anim;
    const el = document.createElement('div');
    el.className = `cm ${m.recorte ? 'recorte' : 'cenario'}`;
    el.setAttribute('role', 'status');
    el.innerHTML = `<div class="cm-balao">Minerando <b>ofertas</b>… ⛏️</div>
      <div class="cm-quadro"><canvas width="${m.lado}" height="${m.lado}" aria-label="Capi minerando ofertas"></canvas></div>`;
    document.body.appendChild(el);
    aberto = el;
    const g = el.querySelector('canvas').getContext('2d');
    const duracao = m.quadros / m.fps * 1000;
    const desenha = k => {
      g.clearRect(0, 0, m.lado, m.lado);
      g.drawImage(img, (k % m.colunas) * m.lado, Math.floor(k / m.colunas) * m.lado, m.lado, m.lado, 0, 0, m.lado, m.lado);
    };
    let inicio = null, raf = 0, trocou = false;
    const passo = t => {
      inicio ??= t;
      const k = Math.min(m.quadros - 1, Math.floor((t - inicio) / 1000 * m.fps));
      desenha(reduzido ? 0 : k);
      if (!trocou && t - inicio > duracao * .62) {
        trocou = true;
        const b = el.querySelector('.cm-balao');
        b.innerHTML = 'Achei <b>promoções</b>! 🎉'; b.classList.add('troca');
      }
      if (t - inicio < duracao + 500) raf = requestAnimationFrame(passo); else fechar();
    };
    raf = requestAnimationFrame(passo);
    const trava = setTimeout(() => fechar(), duracao + 1500); // sai da tela mesmo se a aba ficar em segundo plano
    let terminou;
    const fim = new Promise(ok => { terminou = ok; });
    function fechar() {
      cancelAnimationFrame(raf); clearTimeout(trava);
      if (el.classList.contains("saindo")) return;
      el.classList.add('saindo');
      setTimeout(() => { el.remove(); if (aberto === el) aberto = null; terminou(true); }, 450);
    }
    return fim;
  }

  window.CapiMinerando = { mostrar };

  // ── Quando aparece ──
  let cfg = { so_mineracao: false, intervalo: 10 }, minerando = false, carregou = false, proxima = null, rodando = false;
  // Nunca na tela de entrar/criar conta (Minha conta sem login)
  const naTelaDeLogin = () => { const v = document.getElementById('view-login'); return Boolean(v && !v.hidden); };
  const pode = () => !naTelaDeLogin() && (TESTE || !cfg.so_mineracao || minerando);

  // Um clipe por vez; o intervalo conta do fim de um até o começo do próximo
  async function ciclo() {
    if (rodando) return;
    rodando = true;
    clearTimeout(proxima);
    if (pode() && !document.hidden) await mostrar();
    rodando = false;
    proxima = setTimeout(ciclo, (document.hidden ? 3 : cfg.intervalo) * 1000);
  }

  async function consultar() {
    try {
      const r = await fetch('/api/mineracao/status', { cache: 'no-store' }).then(x => x.json());
      if (r.capi) cfg = r.capi;
      const comecou = r.minerando && !minerando;
      minerando = r.minerando;
      if (!carregou) { carregou = true; proxima = setTimeout(ciclo, 1500); }
      else if (comecou && cfg.so_mineracao && !rodando) { clearTimeout(proxima); proxima = setTimeout(ciclo, 1500); } // mineração começou: aparece logo
    } catch { /* sem conexão: tenta na próxima */ }
  }
  consultar();
  setInterval(() => { if (!document.hidden) consultar(); }, CONSULTA_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) consultar(); });
})();
