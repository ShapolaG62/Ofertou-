// Página de venda da ferramenta de afiliado (/ferramenta). Preço e prazo vêm do plano cadastrado no painel.
const planos = require('../planos');
const h = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fs = require('fs');
const path = require('path');

function versao() {
  try { return /site\.css\?v=(\d+)/.exec(fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8'))?.[1] || '1'; } catch { return '1'; }
}

const PROBLEMAS = [
  ['Passar o dia copiando e colando link', 'Você escolhe as lojas e os horários. O envio acontece sozinho, com o seu link de afiliado.'],
  ['O número do WhatsApp cair na hora errada', 'Conecte um número reserva. Se um parar, a oferta sai pelo outro.'],
  ['Postar oferta que já acabou', 'As ofertas são conferidas várias vezes por dia, e a que sai do ar não entra na sua fila.'],
  ['Não saber se o grupo está dando resultado', 'Comissão, entradas e saídas de membros no mesmo painel.'],
];
const RECURSOS = [
  ['Ofertas prontas para postar', 'Ofertas mineradas nas lojas, conferidas várias vezes por dia e com cupom quando existe.'],
  ['Seus links, sua comissão', 'Mercado Livre, Amazon, Shopee, Magalu, AliExpress e KaBuM!, cada um com o seu código.'],
  ['WhatsApp, Telegram, Facebook, Instagram e X', 'Uma oferta, todas as redes que você conectar.'],
  ['Agendamento e fila', 'Nos horários que você escolher ou o dia todo, com intervalo sorteado e filtro de palavras.'],
  ['Grupo de automação', 'Mande um link no seu grupo e a oferta sai para todos, direto do celular.'],
  ['Número de contingência', 'Dois números revezando no envio, um cobrindo o outro.'],
  ['Painel de comissão', 'A Shopee atualiza sozinha; as outras lojas entram pela planilha do portal.'],
  ['Monitor de membros', 'Quantos entraram e saíram por dia em cada grupo.'],
  ['Site do grupo', 'Um link para divulgar, com rotação quando um grupo lota.'],
];
const DUVIDAS = [
  ['Preciso ter conta nos programas de afiliados?', 'Sim. A comissão é sua, então os links precisam ser das suas contas em cada loja. O painel mostra quais ainda faltam.'],
  ['Preciso de um número só para isso?', 'Para o WhatsApp, é o mais seguro: o envio automático usa um número conectado pelo QR code direto no seu painel, sem serviço à parte. Um número só para isso protege o seu número pessoal.'],
  ['Os ganhos são garantidos?', 'Não. O resultado depende do tamanho do seu público, das ofertas e das regras de cada programa. A ferramenta cuida do trabalho repetitivo.'],
  ['O WhatsApp pode bloquear meu número?', 'Pode. O envio automático não é oficial para grupos e sempre tem esse risco. O intervalo sorteado ajuda, mas não elimina.'],
];

function pagina() {
  const p = planos.listar().find(x => x.tipo === 'ferramenta' && !x.gratis) || null;
  const preco = p ? Number(p.preco).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '';
  const prazo = p ? (p.sem_vencimento ? 'sem vencimento' : `por ${p.dias} dias`) : '';
  const comprar = p ? `/assinar?plano=${encodeURIComponent(p.id)}` : '/conta#planos';
  const v = versao();
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Ferramenta para afiliados: ofertas prontas e postagem automática | Ofertou!</title>
<meta name="description" content="Ofertas mineradas, cupons, postagem automática no WhatsApp e Telegram, comissão e membros no mesmo painel, com os seus links de afiliado.">
<link rel="canonical" href="https://tanoofertou.com.br/ferramenta">
<meta name="theme-color" content="#0a7a43">
<link rel="icon" type="image/png" sizes="32x32" href="/images/favicon-32x32.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/site.css?v=${v}">
<script src="/js/tema.js?v=${v}"></script>
<script src="/js/cookies.js?v=${v}"></script>
<script src="/js/rodape-legal.js?v=${v}" defer></script>
<script src="/js/ferramenta.js?v=${v}" defer></script>
</head><body>
<header class="site-header"><div class="container header-row">
  <a class="brand" href="/" aria-label="Ofertou! — início"><img src="/images/capi-76.png" alt="" width="38" height="38"><span class="brand-name">Ofertou<b>!</b></span></a>
  <div class="header-actions"><a class="btn btn-sm" href="/">Ver ofertas</a><a class="btn btn-sm btn-primary" href="/cliente">Entrar</a></div>
</div></header>
<main class="fr">
  <section class="fr-topo container">
    <div>
      <h1>Seu grupo de ofertas postando sozinho, com os seus links.</h1>
      <p>O Ofertou! encontra as ofertas nas lojas e posta nos seus grupos. Você acompanha a comissão e os membros em um painel só.</p>
      <div class="fr-acoes"><a class="btn btn-primary btn-lg" href="${h(comprar)}">Começar agora</a><a class="btn btn-lg" href="#recursos">Ver o que tem</a></div>
    </div>
    <img src="/images/capi-faixa.webp" alt="Capi, a mascote do Ofertou!, com uma picareta" width="409" height="320">
  </section>

  <section class="fr-sec container">
    <h2>O trabalho repetitivo fica com a gente</h2>
    <div class="fr-grade fr-2">${PROBLEMAS.map(([a, b]) => `<article class="fr-card"><h3>${h(a)}</h3><p>${h(b)}</p></article>`).join('')}</div>
  </section>

  <section class="fr-sec container" id="recursos">
    <h2>Tudo em um painel</h2>
    <div class="fr-grade fr-3">${RECURSOS.map(([a, b]) => `<article class="fr-card"><h3>${h(a)}</h3><p>${h(b)}</p></article>`).join('')}</div>
  </section>

  <section class="fr-sec container">
    <h2>Faça a sua conta</h2>
    <form class="fr-calc" id="fr-calc" data-preco="${p ? Number(p.preco) : 0}" data-dias="${p ? Number(p.dias) || 30 : 30}">
      <div class="fr-campos">
        <label class="field">Membros nos seus grupos <input type="number" name="membros" min="0" step="100" value="1000" inputmode="numeric"></label>
        <label class="field">Quanto cada membro rende por mês hoje (R$) <input type="number" name="hoje" min="0" step="0.1" value="1" inputmode="decimal"></label>
        <label class="field">Quanto você quer que renda (R$) <input type="number" name="meta" min="0" step="0.1" value="1.5" inputmode="decimal"></label>
      </div>
      <div class="fr-result" aria-live="polite">
        <div><small>Hoje, por mês</small><b id="fr-hoje"></b></div>
        <div><small>Na sua meta, por mês</small><b id="fr-meta"></b></div>
        <div><small>Diferença menos a ferramenta</small><b id="fr-dif"></b></div>
      </div>
      <p class="cli-hint">É só uma conta com os números que você digitou. Não é promessa de resultado.</p>
    </form>
  </section>

  <section class="fr-sec container fr-preco">
    <h2>${h(p ? p.nome : 'Ferramenta de afiliado')}</h2>
    ${p ? `<p class="fr-valor"><small>R$</small> ${h(preco)} <span>${h(prazo)}</span></p>` : ''}
    <p>Sem renovação automática. Desistiu nos primeiros 7 dias? Você pode pedir o dinheiro de volta (direito de arrependimento).</p>
    <a class="btn btn-primary btn-lg" href="${h(comprar)}">Começar agora</a>
  </section>

  <section class="fr-sec container">
    <h2>Dúvidas</h2>
    <div class="fr-duvidas">${DUVIDAS.map(([a, b]) => `<details><summary>${h(a)}</summary><p>${h(b)}</p></details>`).join('')}</div>
  </section>
</main>
<footer class="site-footer"><div class="container"><div class="footer-legal">© Ofertou! · <a href="/">Ofertas</a> · <a href="/ajuda">Ajuda</a> · <a href="/privacidade">Termos e privacidade</a></div></div></footer>
</body></html>`;
}

module.exports = { pagina };
