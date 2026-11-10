// /cupons é a própria página de ofertas, mostrando os cupons no lugar dos produtos (public/js/site.js).
// Com ?de=<afiliado>: página à parte, em que as ofertas abrem com os links de afiliado dele (/ir/...) e nada leva às ofertas do site.
const fs = require('fs');
const path = require('path');
const h = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const CENTRAL_ML = 'https://www.mercadolivre.com.br/cupons';
const reais = v => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: Number(v) % 1 ? 2 : 0, maximumFractionDigits: 2 });
const preco = v => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NA = { mercadolivre: 'no Mercado Livre', amazon: 'na Amazon', shopee: 'na Shopee', magalu: 'na Magalu', aliexpress: 'no AliExpress', kabum: 'na KaBuM!', shein: 'na Shein', temu: 'na Temu' };

// Página de ofertas com o título e o endereço dos cupons
const INDEX = path.join(__dirname, '..', '..', 'public', 'index.html');
function paginaSite(site) {
  const base = String(site || '').trim().replace(/\/+$/, '');
  const titulo = 'Cupons ativos — Ofertou!';
  const descricao = 'Cupons de desconto ativos no Mercado Livre, Amazon, Shopee, Magalu, AliExpress e KaBuM!, com onde usar cada um.';
  return fs.readFileSync(INDEX, 'utf8')
    .replace(/<title>[^<]*<\/title>/, () => `<title>${h(titulo)}</title>`)
    .replace(/<meta name="description"[^>]*>/, () => `<meta name="description" content="${h(descricao)}">`)
    .replace(/<link rel="canonical"[^>]*>/, () => `<link rel="canonical" href="${h(base)}/cupons">`)
    .replace(/<meta property="og:title"[^>]*>/, () => `<meta property="og:title" content="${h(titulo)}">`)
    .replace(/<meta property="og:description"[^>]*>/, () => `<meta property="og:description" content="${h(descricao)}">`)
    .replace(/<meta property="og:url"[^>]*>/, () => `<meta property="og:url" content="${h(base)}/cupons">`);
}

function documento({ titulo, descricao, corpo }) {
  const topo = `<header class="cp-topo"><span class="cp-marca"><img src="/images/capi-76.png" alt="" width="34" height="34"><span>Ofertou<b>!</b></span></span></header>`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${h(titulo)} — Ofertou!</title>
<meta name="description" content="${h(descricao)}">
<meta name="robots" content="noindex">
<meta property="og:title" content="${h(titulo)} — Ofertou!"><meta property="og:description" content="${h(descricao)}"><meta property="og:image" content="/images/icon-512.png">
<link rel="canonical" href="/cupons"><link rel="icon" href="/images/favicon-32x32.png">
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/site.css?v=20261331">
<script src="/js/tema.js?v=20261331"></script>
<script src="/js/rodape-legal.js?v=20261331" defer></script>
<style>
  body { background: var(--bg); }
  .cp-faixa { height: 3px; background: linear-gradient(90deg, #0a7a43, #0d6985 60%, #0b6bb5); }
  .cp-topo { max-width: 1040px; margin: 0 auto; padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .cp-marca { display: inline-flex; align-items: center; gap: 10px; font-weight: 800; font-size: 19px; color: var(--ink); text-decoration: none; }
  .cp-marca b { color: var(--brand); }
  main.cp { max-width: 1040px; margin: 0 auto; padding: 8px 16px 48px; }
  main.cp h1 { margin: 8px 0 4px; font-size: clamp(27px, 6vw, 38px); line-height: 1.12; letter-spacing: -.02em; color: var(--brand); overflow-wrap: anywhere; }
  .cp-sub { margin: 0 0 22px; color: var(--ink-2); max-width: 62ch; }
  .cp-volta { display: inline-flex; align-items: center; min-height: 44px; font-weight: 700; color: var(--azul-texto, var(--brand)); }
  main.cp h2 { margin: 26px 0 10px; font-size: 20px; color: var(--ink); }
  main.cp h2 small { font-size: 13px; font-weight: 600; color: var(--ink-3); margin-left: 6px; }
  .cp-lista { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 12px; }
  .cp-cartao { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 14px; display: grid; gap: 8px; min-width: 0; }
  .cp-nome { font-size: 18px; font-weight: 800; color: var(--azul-texto, var(--brand)); overflow-wrap: anywhere; letter-spacing: .01em; }
  .cp-cartao p { margin: 0; font-size: 14.5px; color: var(--ink-2); }
  .cp-botoes { display: flex; flex-wrap: wrap; gap: 8px; align-self: end; }
  .cp-botoes .btn { flex: 1 1 130px; min-height: 44px; justify-content: center; display: inline-flex; align-items: center; }
  .cp-vazio { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 22px; color: var(--ink-2); }
  .cp-oferta { grid-template-columns: 84px minmax(0, 1fr); align-items: center; column-gap: 12px; }
  .cp-oferta img { width: 84px; height: 84px; object-fit: contain; border-radius: 10px; background: #fff; }
  .cp-oferta .cp-prod { font-size: 14.5px; font-weight: 600; color: var(--ink); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .cp-oferta .cp-preco { font-size: 18px; font-weight: 800; color: var(--brand); }
  .cp-oferta .cp-preco s { font-size: 13px; font-weight: 500; color: var(--ink-3); margin-right: 6px; }
  .cp-oferta .btn { grid-column: 1 / -1; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; }
</style></head><body>
<div class="cp-faixa"></div>
${topo}
<main class="cp">${corpo}</main>
<script>
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-copiar]');
  if (!b) return;
  const antes = b.textContent;
  try { await navigator.clipboard.writeText(b.dataset.copiar); b.textContent = 'Copiado!'; }
  catch { b.textContent = b.dataset.copiar; }
  setTimeout(() => { b.textContent = antes; }, 1800);
});
</script>
</body></html>`;
}

function cartao(c, cid) {
  const nome = c.ml ? (c.texto || 'Cupom') : c.codigo;
  const det = c.ml ? `${c.minimo ? `Em compras acima de R$ ${reais(c.minimo)}. ` : ''}Sem código: ative em Cupons, no Mercado Livre.` : `${c.texto ? `${c.texto}. ` : ''}Use no pagamento ${c.na}`;
  const destino = `/cupons?de=${Number(cid)}&cupom=${encodeURIComponent(c.codigo)}`;
  const ofertas = c.ofertas ? `<a class="btn" href="${destino}">Ver ${c.ofertas === 1 ? '1 oferta' : `${c.ofertas} ofertas`}</a>` : '';
  const principal = c.ml
    ? `<a class="btn btn-primary" href="${CENTRAL_ML}" target="_blank" rel="noopener">Ativar no Mercado Livre</a>`
    : `<button class="btn btn-primary" type="button" data-copiar="${h(c.codigo)}">Copiar cupom</button>`;
  return `<li class="cp-cartao"><b class="cp-nome">${h(nome)}</b><p>${h(det)}</p><div class="cp-botoes">${principal}${ofertas}</div></li>`;
}

function pagina(lista, { cid }) {
  const lojas = new Map();
  for (const c of lista) {
    if (!lojas.has(c.loja)) lojas.set(c.loja, []);
    lojas.get(c.loja).push({ ...c, na: NA[c.store_id] || `na ${c.loja}` });
  }
  const blocos = [...lojas.entries()].map(([loja, itens]) => `<section><h2>${h(loja)} <small>${itens.length === 1 ? '1 cupom' : `${itens.length} cupons`}</small></h2><ul class="cp-lista">${itens.map(c => cartao(c, cid)).join('')}</ul></section>`).join('');
  return documento({
    titulo: 'Cupons ativos',
    descricao: 'Cupons de desconto ativos no Mercado Livre, Amazon, Shopee, Magalu, AliExpress e KaBuM!, com onde usar cada um.',
    corpo: `<h1>Cupons ativos</h1>
  <p class="cp-sub">Copie o código e use no pagamento da loja. A validade e as regras de cada cupom são definidas pela loja.</p>
  ${blocos || '<p class="cp-vazio">Nenhum cupom ativo agora. Volte mais tarde: a lista é atualizada várias vezes por dia.</p>'}`,
  });
}

// Ofertas de um cupom, com os links de afiliado de quem divulgou
function paginaOfertas(cupom, ofertas, cid) {
  const nome = /^ML\d+$/.test(cupom.codigo) ? (cupom.texto || 'Cupom') : cupom.codigo;
  const itens = ofertas.map(o => `<li class="cp-cartao cp-oferta">
    <img src="/img/p/${Number(o.id)}.webp" alt="" width="84" height="84" loading="lazy">
    <div><span class="cp-prod">${h(o.produto)}</span><div class="cp-preco">${Number(o.preco_anterior) > Number(o.preco_atual) ? `<s>R$ ${preco(o.preco_anterior)}</s>` : ''}R$ ${preco(o.preco_atual)}</div></div>
    <a class="btn btn-primary" href="/ir/${Number(cid)}-${Number(o.id)}" target="_blank" rel="noopener nofollow">Ver oferta</a></li>`).join('');
  return documento({
    titulo: `Ofertas com o cupom ${nome}`,
    descricao: `Ofertas em que vale o cupom ${nome}.`,
    corpo: `<a class="cp-volta" href="/cupons?de=${Number(cid)}">‹ Todos os cupons</a>
  <h1>Ofertas com o cupom ${h(nome)}</h1>
  <p class="cp-sub">${cupom.texto ? `${h(cupom.texto)}. ` : ''}O preço mostrado já considera o cupom. A validade e as regras são definidas pela loja.</p>
  ${itens ? `<ul class="cp-lista">${itens}</ul>` : '<p class="cp-vazio">Nenhuma oferta no ar com este cupom agora.</p>'}`,
  });
}

module.exports = { pagina, paginaOfertas, paginaSite };
