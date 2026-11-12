// Nota de viral: quais ofertas merecem ir para os grupos de WhatsApp (0 a ~100; só passa quem chega na nota mínima).
// De onde vieram os pesos (estudo de 2026-11-12):
//  • Seus envios (90 dias): 1.304 envios e 7 cliques. KaBuM! (506 envios) e Informática (547) não tiveram quase nenhum
//    clique; os cliques vieram de itens baratos de impulso e de marcas famosas (kit de bermudas, perfume Club de Nuit,
//    robô aspirador). → o site aprende sozinho com os cliques de cada envio (por tema e por loja).
//  • Grupos de origem da repostagem (PromoTech, Lipe Ofertas): marcas conhecidas e modelos famosos, repetidos várias
//    vezes (SSD Kingston NV3, Club de Nuit, creatina, cadeira ergonômica). → produto que outros grupos estão postando
//    agora sobe muito; marca famosa sobe.
//  • Estudos de varejo: compra por impulso concentra na faixa de R$ 20 a R$ 80; acima disso a pessoa compara e demora.
//    Prova social (muitas vendas e nota alta) aumenta a conversão. → faixa de preço, vendidos e nota pesam.
//  • Foto: lojas com foto de produto limpa (Amazon, Mercado Livre, KaBuM!, Magalu) sobem; AliExpress costuma ter
//    montagens cheias de texto. A foto também é conferida na hora do envio (src/agenda.js: tamanho e formato).
const db = require('./db');
const busca = require('./busca-ofertas');

const normalizar = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9+]+/g, ' ').trim();

const MARCAS = new RegExp(`\\b(${[
  'apple', 'iphone', 'samsung', 'galaxy', 'xiaomi', 'redmi', 'motorola', 'jbl', 'sony', 'lg', 'philips', 'mondial', 'britania', 'electrolux',
  'brastemp', 'consul', 'oster', 'arno', 'wap', 'nike', 'adidas', 'puma', 'olympikus', 'mizuno', 'havaianas', 'vans', 'fila', 'natura',
  'boticario', 'eudora', 'avon', 'loreal', 'nivea', 'dove', 'la roche', 'cerave', 'kingston', 'logitech', 'redragon', 'hyperx', 'lenovo',
  'dell', 'acer', 'asus', 'intelbras', 'tramontina', 'karcher', 'bosch', 'makita', 'dewalt', 'stanley', 'black decker', 'vonder',
  'growth', 'integralmedica', 'max titanium', 'probiotica', 'dux', 'armaf', 'lattafa', 'montblanc', 'armani', 'calvin klein',
  'carolina herrera', 'paco rabanne', 'azzaro', 'pampers', 'huggies', 'lego', 'hot wheels', 'barbie', 'ype', 'omo', 'colgate', 'gillette',
  'oral b', 'philco', 'aoc', 'tcl', 'haier', 'nintendo', 'playstation', 'xbox', 'kindle', 'echo dot', 'alexa', 'stanley', 'wap', 'electrolux',
  'nespresso', 'dolce gusto', 'tefal', 'rayban', 'ray ban', 'oakley', 'casio', 'mondaine', 'technos', 'quiksilver', 'hering', 'malwee',
].map(m => m.replace(/ /g, '\\s')).join('|')})\\b`);
// Logo antes da marca: "para", "compatível com", "tipo", "modelo"... → a marca é só referência
const COMPATIVEL = /\b(para|pra|p|compativel( com)?|tipo|modelo|estilo|similar|replica|inspirad[oa]( em| no| na)?|igual( ao| a)?|linha)\s+(o |a |os |as )?([a-z0-9+]+ ){0,2}$/;
const IMITACAO = /\b(compativel|replica|similar ao|tipo (lego|alexa|airpods)|alaxe|1 ?a linha|primeira linha)\b/;
// Acessório no começo do nome (capa, cabo, carregador...): chama menos atenção que o produto em si
const ACESSORIO = /\b(capa|capinha|case|pelicula|suporte|cabo|carregador|adaptador|adesivo|organizador|refil|peca|reposicao|controle remoto|pulseira)\b/;
// Peças de computador: público pequeno (quem monta PC); nos seus grupos quase não tiveram clique
const NICHO = /\b(processador|placa mae|placa de video|fonte \d{3,4} ?w|fonte (atx|modular)|memoria ram|gabinete|water cooler|cooler|dissipador|pasta termica|controladora|placa de rede)\b/;
const FOTO = [[/m\.media-amazon\.com|images-amazon/, 3], [/mlstatic\.com/, 3], [/kabum\.com\.br/, 2], [/mlcdn\.com\.br|magazineluiza/, 2], [/alicdn\.com|aliexpress/, -3]];

// ── O que o site aprende ──────────────────────────────────────────────────────
// Cliques por tema e por loja nos seus envios (60 dias), puxados para a média quando há poucos envios
const PESO_MEDIA = 100; // envios "imaginários" na média: tema com poucos envios fica perto do neutro
function aprendizado(cid = null) {
  const linhas = db.all(`SELECT categoria, store_id, SUM(situacao = 'enviado') AS envios, SUM(CASE WHEN situacao = 'enviado' THEN cliques ELSE 0 END) AS cliques
    FROM envio_grupo WHERE cliente_id IS ? AND created_at >= datetime('now', '-60 days') GROUP BY categoria, store_id`, cid);
  const total = linhas.reduce((a, l) => ({ e: a.e + (l.envios || 0), c: a.c + (l.cliques || 0) }), { e: 0, c: 0 });
  if (total.c < 5 || total.e < 100) return null; // pouco clique ainda: sem conclusão
  const media = total.c / total.e;
  const somar = chave => {
    const m = new Map();
    for (const l of linhas) { const k = l[chave] || ''; const a = m.get(k) || { e: 0, c: 0 }; a.e += l.envios || 0; a.c += l.cliques || 0; m.set(k, a); }
    const pontos = new Map();
    for (const [k, a] of m) {
      const taxa = (a.c + PESO_MEDIA * media) / (a.e + PESO_MEDIA);
      pontos.set(k, 8 * Math.max(-1.5, Math.min(1.5, Math.log2(taxa / media))));
    }
    return pontos;
  };
  return { tema: somar('categoria'), loja: somar('store_id'), media };
}

// Produtos que os grupos de origem (repostagem) postaram nos últimos 7 dias: as 3 primeiras palavras que importam
const VAZIAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'com', 'para', 'por', 'em', 'a', 'o', 'as', 'os', 'kit', 'novo', 'nova', 'original', 'oferta', 'promocao']);
const chaveDe = nome => normalizar(nome).split(' ').filter(p => p.length > 1 && !VAZIAS.has(p)).slice(0, 3);
function emAltaNosGrupos(cid = null) {
  const contagem = new Map();
  for (const r of db.all(`SELECT produto FROM repostar_registro WHERE cliente_id IS ? AND produto IS NOT NULL AND created_at >= datetime('now', '-7 days')`, cid)) {
    const k = chaveDe(r.produto);
    if (k.length < 2) continue;
    const id = k.join(' ');
    contagem.set(id, { palavras: k, n: (contagem.get(id)?.n || 0) + 1 });
  }
  return [...contagem.values()];
}
const tabelaExiste = nome => Boolean(db.get(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, nome));

// Contexto calculado uma vez por escolha (não a cada oferta)
function contexto(cid = null) {
  return {
    aprendido: tabelaExiste('envio_grupo') ? aprendizado(cid) : null,
    alta: tabelaExiste('repostar_registro') ? emAltaNosGrupos(cid) : [],
  };
}

// ── A nota ───────────────────────────────────────────────────────────────────
// o: oferta da lista (busca-ofertas) — usa preco_atual, preco_anterior, desconto_pct, store_id, categoria, produto e,
// se houver, _v (vendidos), _a (nota 0 a 5), imagem, relampago_tipo, cupom, comissao_extra_pct.
// Devolve { nota, motivos } (motivos: o que mais pesou, para o painel).
function notaGrupo(o, ctx = { aprendido: null, alta: [] }) {
  const motivos = [];
  const somar = (v, motivo) => { if (v) { s += v; if (motivo && Math.abs(v) >= 5) motivos.push(`${motivo} (${v > 0 ? '+' : ''}${Math.round(v)})`); } };
  let s = 20;
  const n = ` ${normalizar(o.produto)} `;
  const p = Number(o.preco_atual) || 0;
  const d = Number(o.desconto_pct) || 0;

  // Preço de impulso
  somar(p >= 20 && p <= 80 ? 15 : p > 80 && p <= 200 ? 10 : p > 200 && p <= 500 ? 4 : p > 1500 ? -8 : p > 500 ? -2 : p < 15 ? -8 : 2,
    p >= 20 && p <= 80 ? 'preço de impulso' : p > 1500 ? 'preço alto' : p < 15 ? 'preço muito baixo' : null);
  // Desconto e economia em reais
  somar(d >= 30 && d <= 70 ? 10 : d >= 20 ? 4 : -4, d >= 30 && d <= 70 ? `${Math.round(d)}% OFF` : null);
  somar(Math.min(8, Math.max(0, (Number(o.preco_anterior) - p) / 25)), 'economia em reais');
  // Prova social (vendidos e nota informados pela loja)
  const v = o._v ?? o.vendidos;
  if (v != null) somar(v < 10 ? -6 : Math.min(25, 6 * Math.log10(1 + v)), v < 10 ? 'quase sem vendas' : `${v >= 1000 ? `${Math.floor(v / 1000)} mil` : v} vendidos`);
  const a = o._a ?? o.avaliacao;
  if (a) somar(a >= 4.7 ? 6 : a >= 4.5 ? 3 : a < 4 ? -10 : 0, a < 4 ? `nota ${a}` : a >= 4.7 ? `nota ${a}` : null);
  // Procurado, marca famosa, nicho e acessório. "Para iPhone", "compatível com Lego", "modelo Alexa": a marca é de
  // outro produto (acessório ou imitação), então não conta; nome que avisa imitação perde pontos.
  const imitacao = IMITACAO.test(n);
  const deVerdade = i => i >= 0 && !imitacao && !COMPATIVEL.test(n.slice(Math.max(0, i - 22), i));
  const emAlta = busca.EM_ALTA.some(k => deVerdade(n.indexOf(k)));
  if (emAlta) somar(12, 'produto procurado');
  const marca = MARCAS.exec(n.slice(0, 70));
  if (marca && deVerdade(marca.index)) somar(8, 'marca famosa');
  if (imitacao) somar(-6, 'imitação ou peça compatível');
  if (NICHO.test(n)) somar(-10, 'peça de computador (público pequeno)');
  if (ACESSORIO.test(n.slice(0, 42))) somar(-10, 'acessório');
  // O que outros grupos estão postando agora
  const palavras = new Set(n.trim().split(' '));
  const viral = ctx.alta.find(x => x.palavras.every(w => palavras.has(w)));
  if (viral) somar(viral.n >= 2 ? 25 : 18, 'em alta em outros grupos');
  // Loja e foto
  somar(((busca.LOJA_CONFIANCA[o.store_id] ?? 2) - 6) * 0.8);
  for (const [re, pts] of FOTO) if (re.test(String(o.imagem || ''))) { somar(pts); break; }
  // Extras
  if (o.relampago_tipo === 'loja') somar(8, 'relâmpago da loja');
  if (o.cupom || o.cupom_codigo) somar(3);
  if (o.comissao_extra_pct > 0) somar(Math.min(5, o.comissao_extra_pct / 2)); // rende mais, mas não faz vender mais
  // O que deu clique nos seus grupos
  if (ctx.aprendido) {
    somar(ctx.aprendido.tema.get(o.categoria || '') || 0, 'cliques do tema nos seus grupos');
    somar(ctx.aprendido.loja.get(o.store_id || '') || 0, 'cliques da loja nos seus grupos');
  }
  return { nota: Math.round(Math.max(0, Math.min(100, s))), motivos };
}

module.exports = { notaGrupo, contexto, aprendizado, emAltaNosGrupos, MARCAS, NICHO };
