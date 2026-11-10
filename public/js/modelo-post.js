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
    '✅ *Por R$ {{preco}}* {{na_loja}}',
    '💸 Você economiza *R$ {{economia}}* ({{desconto}}% off)',
    '🎟️ Cupom: *{{cupom}}*',
    '',
    '👉 {{link}}',
    '',
    '_Preço conferido em {{conferido}}. Pode mudar a qualquer momento._',
  ].join('\n');
  const VARIAVEIS = ['produto', 'preco_de', 'preco', 'desconto', 'economia', 'loja', 'na_loja', 'link', 'cupom', 'conferido'];
  // Artigo de cada loja ("no Mercado Livre", "na Amazon"); loja parceira: "em <nome>"
  const ARTIGO = { 'Mercado Livre': 'no', AliExpress: 'no', Amazon: 'na', Shopee: 'na', Magalu: 'na', 'KaBuM!': 'na', Shein: 'na', Temu: 'na' };
  const naLoja = loja => (String(loja || '').trim() ? `${ARTIGO[String(loja).trim()] || 'em'} ${String(loja).trim()}` : '');
  // Os 3 modelos prontos para escolher (Painel → Redes sociais → Modelo da mensagem)
  const MODELOS = [
    { id: 'padrao', nome: 'Padrão', desc: 'Completo: preço de antes e de agora, loja e quando foi conferido.', texto: PADRAO },
    { id: 'direto', nome: 'Direto ao ponto', desc: 'Curto, para quem posta muitas ofertas por dia.', texto: [
      '🔥 *{{produto}}*',
      '💰 *R$ {{preco}}* ({{desconto}}% off) · {{loja}}',
      '🎟️ Cupom: *{{cupom}}*',
      '👉 {{link}}',
    ].join('\n') },
    { id: 'chamativo', nome: 'Chamativo', desc: 'Abre com o desconto em destaque e mostra a economia.', texto: [
      '🚨 *{{desconto}}% OFF {{na_loja}}*',
      '',
      '🛍️ {{produto}}',
      '',
      '~De R$ {{preco_de}}~',
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
    return linhas.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  const api = { PADRAO, VARIAVEIS, MODELOS, aplicar };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.OfertouModelo = api;
})(typeof window !== 'undefined' ? window : globalThis);
