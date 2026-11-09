// Ofertou! — coleta das ofertas do Mercado Livre (só age quando ligada pelo botão "Coletar agora" do Painel).
//  1. Lê até 10 páginas de ofertas relâmpago, rolando como uma pessoa (para antes se a lista acabar);
//  2. Lê as páginas gerais de "Ofertas do dia" (até 20): trazem também os anúncios fora do catálogo (/up/…), que a
//     API do Mercado Livre não deixa o site ler;
//  3. Guarda o que achou e segue para a comissão extra e depois para os cupons ativos;
//  3. No fim, a mineração de cupons volta para o Painel, que grava tudo.
// Só lê as páginas. Se o Mercado Livre pedir login ou verificação, não tenta nada: segue em frente sem as ofertas.
(() => {
  'use strict';
  if (window.__ofertouOfertas) return;
  window.__ofertouOfertas = true;

  const espera = ms => new Promise(r => setTimeout(r, ms));
  const num = s => { const t = String(s || '').replace(/[^\d,.]/g, ''); return t ? Number(t.replace(/\./g, '').replace(',', '.')) : null; };
  const COMISSAO = 'https://www.mercadolivre.com.br/afiliados/hub?is_affiliate=true';
  const paginaDe = (n, fase = 'relampago') => {
    if (fase === 'gerais') return `https://www.mercadolivre.com.br/ofertas${n > 1 ? `?page=${n}` : ''}`;
    const q = new URLSearchParams({ container_id: 'MLB779362-1', promotion_type: 'lightning' });
    if (n > 1) q.set('page', n);
    return `https://www.mercadolivre.com.br/ofertas?${q}`;
  };

  let raiz;
  function caixa(msg) {
    if (!raiz) {
      const c = document.createElement('div');
      c.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646';
      raiz = c.attachShadow({ mode: 'open' });
      raiz.innerHTML = `<style>
        .c { display: flex; align-items: center; gap: 10px; max-width: min(400px, calc(100vw - 32px)); padding: 10px 12px; border-radius: 14px;
          font: 600 13.5px/1.4 system-ui, sans-serif; background: #121714; color: #eef3f0; border: 1px solid #2bb673; box-shadow: 0 12px 30px rgba(0,0,0,.35); }
        b { color: #2bb673; } .t { flex: 1; }
        button { font: inherit; font-weight: 800; padding: 7px 12px; border-radius: 999px; border: 0; background: #3a2222; color: #ffb4b4; cursor: pointer; }
      </style><div class="c"><span class="t"></span><button class="p">Parar</button></div>`;
      raiz.querySelector('.p').addEventListener('click', () => { terminar('parado'); });
      document.documentElement.append(c);
    }
    raiz.querySelector('.t').innerHTML = '<b>Ofertou!</b> ';
    raiz.querySelector('.t').append(msg);
  }

  const valor = el => {
    if (!el) return null;
    const f = el.querySelector('.andes-money-amount__fraction')?.textContent, c = el.querySelector('.andes-money-amount__cents')?.textContent;
    return f ? num(f) + (c ? Number(c.replace(/\D/g, '').slice(0, 2).padEnd(2, '0')) / 100 : 0) : null;
  };
  // "Termina em 02:14:33"
  function restante(texto) {
    const m = String(texto).match(/(\d{1,2}):(\d{2}):(\d{2})/);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
  }
  // O cartão mostra o relógio em blocos de dígitos ("0 8 : 0 7 : 1 3"), e o dígito dos segundos vem com o seguinte junto
  function restanteDoCartao(card) {
    const blocos = [...card.querySelectorAll('.poly-countdown__block')].map(b => Number([...b.querySelectorAll('.poly-countdown__roller-container')]
      .map(r => r.querySelector('.poly-countdown__digit--current, .poly-countdown__digit--static')?.textContent || '').join('')));
    if (blocos.length >= 3 && blocos.length <= 4 && blocos.every(Number.isFinite)) {
      const [s, m, h, d = 0] = blocos.reverse();
      return d * 86400 + h * 3600 + m * 60 + s;
    }
    return restante(card.innerText || '');
  }
  function lerCartoes(relampago = true) {
    const out = [];
    for (const card of document.querySelectorAll('.poly-card, .promotion-item')) {
      const a = card.querySelector('a.poly-component__title, .poly-component__title-wrapper a, a[href*="MLB"]');
      const href = (a?.href || '').split(/[?#]/)[0];
      const produto = (href.match(/\/p\/(MLB\d{6,})/i) || [])[1] || null;
      const item = (decodeURIComponent(a?.href || '').match(/MLB-?(\d{6,})/i) || [])[1];
      if (!href || (!produto && !item)) continue;
      const preco = valor(card.querySelector('.poly-price__current .andes-money-amount'));
      const anterior = valor(card.querySelector('.andes-money-amount--previous'));
      if (!preco || !anterior) continue;
      const img = card.querySelector('img');
      out.push({
        produto, item: item ? `MLB${item}` : null, link: href,
        nome: (card.querySelector('.poly-component__title')?.textContent || a?.textContent || '').trim().slice(0, 200),
        preco, preco_anterior: anterior, imagem: img?.getAttribute('data-src') || img?.src || null,
        relampago, ...(relampago ? (() => { const s = restanteDoCartao(card); return s > 0 ? { resta_s: s, fim_ms: Date.now() + s * 1000 } : {}; })() : {}),
      });
    }
    return out;
  }

  async function terminar(motivo, completa = false) {
    const { ofertasJob: j } = await chrome.storage.local.get('ofertasJob');
    await chrome.storage.local.remove('ofertasJob');
    if (!j) return;
    // A comissão extra (mercadolivre.js) segue para os cupons quando terminar
    await chrome.storage.local.set({ ofertasResultado: { em: Date.now(), motivo, completa, itens: Object.values(j.itens || {}) }, coletaJob: { cupons: j.cupons, painel: j.painel, em: Date.now() }, autoAte: Date.now() + 10 * 60 * 1000, rolagens: 10 });
    caixa('Ofertas lidas. Agora a comissão extra…');
    location.href = COMISSAO;
  }

  (async () => {
    const { ofertasJob: j } = await chrome.storage.local.get('ofertasJob');
    if (!j || Date.now() > j.ate) { if (j) await chrome.storage.local.remove('ofertasJob'); return; }
    await espera(1500);
    const rel = (j.fase || 'relampago') === 'relampago';
    caixa(rel ? `Lendo ofertas relâmpago, página ${j.pagina} de ${j.paginas}…` : `Lendo as ofertas do dia, página ${j.pagina} de ${j.paginas}…`);
    for (let i = 0; i < 6; i++) { window.scrollBy(0, innerHeight); await espera(700); }
    const lidos = lerCartoes(rel);
    const antes = Object.keys(j.itens).length;
    // A relâmpago vale mais (tem hora para acabar): a mesma oferta lida depois nas gerais não a substitui
    for (const it of lidos) { const k = it.produto || it.item; if (rel || !j.itens[k]) j.itens[k] = it; }
    const total = Object.keys(j.itens).length;
    caixa(`${total} ofertas até agora…`);
    // Acabou: última página, página vazia ou (nas relâmpago) só repetidos
    const acabou = !lidos.length || j.pagina >= j.paginas || (rel && total === antes);
    if (acabou && rel && j.paginasGerais > 0) {
      // "completa": a lista relâmpago acabou antes do limite de páginas, então o que não veio já não está em promoção
      await chrome.storage.local.set({ ofertasJob: { ...j, fase: 'gerais', pagina: 1, paginas: j.paginasGerais, completaRel: Boolean(total) && j.pagina < j.paginas } });
      await espera(1500);
      location.href = paginaDe(1, 'gerais');
      return;
    }
    if (acabou) return terminar(total ? 'ok' : 'sem-dados', rel ? Boolean(total) && j.pagina < j.paginas : Boolean(j.completaRel));
    const pagina = j.pagina + 1;
    await chrome.storage.local.set({ ofertasJob: { ...j, pagina } });
    await espera(1500);
    location.href = paginaDe(pagina, rel ? 'relampago' : 'gerais');
  })();
})();
