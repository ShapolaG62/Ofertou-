/* Ofertou! — modelo do texto das postagens (o mesmo no navegador, na tela Postagens, e no servidor, nas postagens
   agendadas). O modelo é um texto com variáveis entre chaves duplas; a linha que usa uma variável vazia some sozinha
   (ex.: a linha do cupom só aparece quando há cupom). Vazio = modelo padrão do site.
   Variáveis: {{produto}} {{preco_de}} {{preco}} {{desconto}} {{economia}} {{loja}} {{na_loja}} {{link}} {{cupom}} {{conferido}}
   {{na_loja}} = a loja com o artigo certo ("no Mercado Livre", "na Amazon"), montado a partir de {{loja}}. */
(function (raiz) {
  'use strict';
  const PADRAO = [
    '*{{produto}}*',
    '',
    '❌ De ~R$ {{preco_de}}~',
    '✅ *Por R$ {{preco}}* ({{desconto}}% off)',
    '💸 Você economiza R$ {{economia}}',
    '🏬 Loja: {{loja}}',
    '🎟️ Cupom: *{{cupom}}*',
    '',
    '🛒 Compre aqui: {{link}}',
  ].join('\n');
  const VARIAVEIS = ['produto', 'preco_de', 'preco', 'desconto', 'economia', 'loja', 'na_loja', 'link', 'cupom', 'conferido'];
  // Artigo de cada loja ("no Mercado Livre", "na Amazon"); loja parceira: "em <nome>"
  const ARTIGO = { 'Mercado Livre': 'no', AliExpress: 'no', Amazon: 'na', Shopee: 'na', Magalu: 'na', 'KaBuM!': 'na', Shein: 'na', Temu: 'na' };
  const naLoja = loja => (String(loja || '').trim() ? `${ARTIGO[String(loja).trim()] || 'em'} ${String(loja).trim()}` : '');
  // Os 3 modelos prontos para escolher (Painel → Redes sociais → Modelo da mensagem)
  const MODELOS = [
    { id: 'padrao', nome: 'Padrão', desc: 'Completo: preço de antes e de agora, economia e loja.', texto: PADRAO },
    { id: 'direto', nome: 'Direto ao ponto', desc: 'Curto, para quem posta muitas ofertas por dia.', texto: [
      '🔥 *{{produto}}*',
      '💰 *R$ {{preco}}* ({{desconto}}% off) · {{loja}}',
      '🎟️ Cupom: *{{cupom}}*',
      '👉 {{link}}',
    ].join('\n') },
    { id: 'chamativo', nome: 'Chamativo', desc: 'Nome do produto em cima, o desconto em destaque no meio e a economia.', texto: [
      '🛍️ *{{produto}}*',
      '',
      '❌ De ~R$ {{preco_de}}~',
      '🚨 *{{desconto}}% OFF {{na_loja}}*',
      '🤑 *Por R$ {{preco}}*',
      '💸 Você economiza *R$ {{economia}}*',
      '🎟️ Use o cupom: *{{cupom}}*',
      '',
      '👉 {{link}}',
    ].join('\n') },
  ];

  // valores: { produto, preco_de, preco, ... } já formatados como texto
  function aplicar(modelo, valores) {
    const m = String(modelo || '').trim() ? String(modelo) : PADRAO;
    if (valores && valores.na_loja === undefined) valores = { ...valores, na_loja: naLoja(valores.loja) };
    const linhas = [];
    for (const linha of m.replace(/\r/g, '').split('\n')) {
      let vazia = false;
      const pronta = linha.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, nome) => {
        const v = valores[nome.toLowerCase()];
        if (v === undefined || v === null || String(v).trim() === '') { vazia = true; return ''; }
        return String(v);
      });
      if (!vazia) linhas.push(pronta);
    }
    // sem linhas em branco repetidas, nem no começo ou no fim
    let texto = linhas.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    // Oferta relâmpago no ar: o aviso vai no começo de toda mensagem (a não ser que o modelo já fale de relâmpago)
    if (valores && valores.relampago && !/OFERTA REL[ÂA]MPAGO/i.test(texto)) texto = `${valores.relampago}\n\n${texto}`;
    return texto;
  }

  // Topo da mensagem de uma oferta relâmpago que ainda está no ar ('' se não for relâmpago ou já acabou)
  function topoRelampago(o, agora = Date.now()) {
    if (!o || !o.relampago_fim) return '';
    const fim = Date.parse(`${String(o.relampago_fim).replace(' ', 'T')}Z`);
    if (!(fim > agora)) return '';
    const linhas = ['⚡🔥 *OFERTA RELÂMPAGO* 🔥⚡'];
    if (o.relampago_tipo && o.relampago_tipo !== 'loja') linhas.push('🚨 O preço caiu agora');
    else if (o.relampago_fim_real) {
      const br = new Date(fim - 3 * 3600000), hoje = new Date(agora - 3 * 3600000);
      const hora = br.toISOString().slice(11, 16);
      linhas.push(`⏰ Termina ${br.toISOString().slice(0, 10) === hoje.toISOString().slice(0, 10) ? `hoje às ${hora}` : `dia ${br.toISOString().slice(8, 10)}/${br.toISOString().slice(5, 7)} às ${hora}`}`);
    }
    return linhas.join('\n');
  }

  const api = { PADRAO, VARIAVEIS, MODELOS, aplicar, topoRelampago };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.OfertouModelo = api;
})(typeof window !== 'undefined' ? window : globalThis);
