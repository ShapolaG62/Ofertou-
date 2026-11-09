// Ofertou! Comissão extra ML — no Painel do Ofertou!. Conversa com a página do Painel por mensagens na própria
// janela (window.postMessage): avisa que a extensão está instalada, marca a busca automática quando você clica em
// "Buscar automaticamente" e entrega a página do Mercado Livre que a extensão trouxe (o Painel lê e importa).
(() => {
  'use strict';
  const ORIGEM = location.origin;
  chrome.storage.local.set({ painel: ORIGEM, soGanhoCliente: false }); // endereço do Painel, para voltar depois de buscar

  const VERSAO = chrome.runtime.getManifest().version;
  const avisar = msg => window.postMessage({ ofertouExt: true, ...(msg.tipo === 'instalada' ? { versao: VERSAO } : {}), ...msg }, ORIGEM);
  avisar({ tipo: 'instalada' });

  window.addEventListener('message', async e => {
    if (e.source !== window || e.origin !== ORIGEM || !e.data || e.data.ofertouPainel !== true) return;
    if (e.data.tipo === 'ola') avisar({ tipo: 'instalada' });
    // O Painel terminou de gravar a coleta: só agora ela pode ser apagada daqui
    if (e.data.tipo === 'coleta-gravada') chrome.storage.local.remove(['cuponsResultado', 'ofertasResultado']);
    if (e.data.tipo === 'buscar') {
      const rolagens = Math.min(Math.max(parseInt(e.data.rolagens, 10) || 10, 1), 100);
      await chrome.storage.local.set({ autoAte: Date.now() + 10 * 60 * 1000, rolagens });
      avisar({ tipo: 'pode-ir' });
    }
    // Coleta completa: até 10 páginas de ofertas relâmpago, até 20 das ofertas do dia, comissão extra com 10 rolagens e os cupons ativos
    if (e.data.tipo === 'coletar-tudo') {
      const n = (v, min, max, pad) => Math.min(Math.max(parseInt(v, 10) || pad, min), max);
      await chrome.storage.local.set({ ofertasJob: {
        ate: Date.now() + 45 * 60 * 1000, painel: ORIGEM, fase: 'relampago', pagina: 1, paginas: 10, itens: {},
        paginasGerais: n(e.data.paginasGerais, 0, 50, 20),
        cupons: { painel: ORIGEM, fase: 'cupons', pagina: 1, cupons: {}, produtos: {}, soAtivos: true,
          paginas: n(e.data.paginas, 1, 100, 70), maxCupons: n(e.data.cupons, 0, 2000, 60), paginasProd: n(e.data.paginasProd, 1, 10, 2),
          aplicar: false, maxAplicar: 0, aplicados: 0 },
      } });
      avisar({ tipo: 'pode-ir-ofertas' });
    }
    // Saldo e vendas de afiliado do Mercado Livre e da Magalu, lidos sem abrir página nenhuma
    if (e.data.tipo === 'ler-ganhos') {
      let resultados;
      try { resultados = await chrome.runtime.sendMessage({ tipo: 'ler-ganhos' }); } catch (err) { resultados = { erro: String(err?.message || err) }; }
      avisar({ tipo: 'ganhos-portal', resultados });
    }
    // Minerar cupons: páginas da central de cupons, quantos cupons ativos abrir e quantas páginas de produtos por cupom
    if (e.data.tipo === 'buscar-cupons') {
      const n = (v, min, max, pad) => Math.min(Math.max(parseInt(v, 10) || pad, min), max);
      await chrome.storage.local.set({ cuponsJob: {
        ate: Date.now() + 3 * 60 * 60 * 1000, painel: ORIGEM, fase: 'cupons', pagina: 1, cupons: {}, produtos: {},
        paginas: n(e.data.paginas, 1, 100, 70), maxCupons: n(e.data.cupons, 0, 2000, 60), paginasProd: n(e.data.paginasProd, 1, 10, 2),
        aplicar: e.data.aplicar === true, maxAplicar: n(e.data.maxAplicar, 0, 2000, 300), aplicados: 0,
      } });
      avisar({ tipo: 'pode-ir-cupons' });
    }
  });

  // "Ganho estimado" lido no painel do Mercado Livre: entrega ao Painel (que grava no site, substituindo o anterior)
  chrome.storage.local.get('ganhoEstimado').then(async ({ ganhoEstimado }) => {
    if (!ganhoEstimado) return;
    await chrome.storage.local.remove('ganhoEstimado');
    avisar({ tipo: 'ganho-estimado', valor: ganhoEstimado.valor, em: ganhoEstimado.em });
  });

  // Cupons do Mercado Livre e ofertas relâmpago trazidos pela coleta (valem 2 horas). Ficam guardados até o Painel avisar que
  // gravou tudo: se a página for fechada no meio, a próxima abertura do Painel termina de gravar.
  chrome.storage.local.get(['cuponsResultado', 'ofertasResultado']).then(async ({ cuponsResultado: r, ofertasResultado: o }) => {
    if (!r) return;
    if (Date.now() - r.em > 2 * 60 * 60 * 1000) { await chrome.storage.local.remove(['cuponsResultado', 'ofertasResultado']); return; }
    const ofertas = o && Date.now() - o.em < 4 * 60 * 60 * 1000 ? o.itens : [];
    avisar({ tipo: 'cupons', ofertas_completa: Boolean(o?.completa), cupons: r.cupons, esgotados: r.esgotados || [], produtos: r.produtos, motivo: r.motivo, aplicados: r.aplicados || 0, listasFalhas: r.listasFalhas || 0, ofertas });
  });

  // Página do Mercado Livre trazida pela extensão (vale 15 min): entrega ao Painel uma vez só
  chrome.storage.local.get('pagina').then(async ({ pagina }) => {
    if (!pagina) return;
    await chrome.storage.local.remove('pagina');
    if (Date.now() - pagina.em > (pagina.coleta ? 4 * 60 : 15) * 60 * 1000) return; // na coleta completa, os cupons vêm depois
    avisar({ tipo: 'pagina', html: pagina.html, filtro: pagina.filtro });
  });
})();
