const path = require('path');
const fs = require('fs');

// Configurações do servidor no arquivo .env (PORT, DATA_DIR, ADMIN_PASSWORD...), como em .env.example.
// Lido antes de tudo; o que já estiver definido no sistema vale mais que o arquivo. Sobrevive às atualizações.
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* sem .env: usa o padrão */ }

const express = require('express');

const { UPLOADS_DIR } = require('./src/db');
const auth = require('./src/auth');
const miner = require('./src/miner');
const offers = require('./src/offers');
const access = require('./src/access');
const publicRoutes = require('./src/routes/public');
const adminRoutes = require('./src/routes/admin');
const contaRoutes = require('./src/routes/conta');
const postagens = require('./src/routes/postagens');
const clienteRoutes = require('./src/routes/cliente');
const assinaturaRoutes = require('./src/routes/assinatura');
const appRoutes = require('./src/routes/app');
const perfilRoutes = require('./src/routes/perfil');
const ganhosRoutes = require('./src/routes/ganhos');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

auth.initFromEnv();
auth.purgeExpiredSessions();
offers.reclassifyAll().then(n => { if (n) console.log(`[CATEGORIAS] ${n} oferta(s) reclassificada(s)`); });

const app = express();
// Erro fora de um pedido (mineração, agenda...): registra para o Painel; o site não cai por causa de um deles
process.on('unhandledRejection', err => { console.error('[SERVER] promessa sem tratamento:', err); try { require('./src/erros-site').registrar(err, 'tarefa em segundo plano'); } catch { /* */ } });
app.disable('x-powered-by');

// Pedidos lentos aparecem na janela do site, para achar gargalos na VPS (fotos baixadas pela 1ª vez não contam)
app.use((req, res, next) => {
  const inicio = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
    if (ms > 1500 && !/^\/(img\/o|api\/img)\//.test(req.path)) console.log(`[LENTO] ${Math.round(ms)} ms  ${req.method} ${req.originalUrl.slice(0, 120)}`);
  });
  next();
});
// Quem fica na frente do site e informa o IP real do visitante (X-Forwarded-For) e se ele veio por https:
// Nginx/IIS na própria máquina (loopback) e a Cloudflare (faixas oficiais em cloudflare.com/ips). Sem isso, todo
// visitante apareceria com o IP da Cloudflare (bloqueio de login, registros de acesso e varredura de IP errados).
const CLOUDFLARE = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];
app.set('trust proxy', ['loopback', ...CLOUDFLARE]);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN'); // só o próprio site pode exibir as páginas num quadro (o SAC dentro do painel)
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Só regras que não dependem da lista de scripts do site (anúncios do Google e Analytics continuam funcionando)
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'; base-uri 'self'; object-src 'none'");
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self)');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

// Compressão (brotli/gzip) de páginas, CSS, JS e JSON. A lista de ofertas já sai comprimida pela própria rota.
app.use(require('compression')({ threshold: 1024 }));

app.use(require('./src/routes/whatsapp-api')); // WhatsApp: API própria (conexão pelo QR code)

app.use(['/api/cliente/comissao/previa', '/api/cliente/comissao/importar'], express.json({ limit: '12mb' })); // planilha de vendas
// A coleta do Mercado Livre entrega milhares de cupons e produtos em lotes grandes: limite maior só para o admin logado
const jsonMineracao = express.json({ limit: '5mb' });
app.use(['/api/admin/mineracao', '/api/admin/ganhos/portal'], (req, res, next) => (auth.isLoggedIn(req) ? jsonMineracao(req, res, next) : next()));
app.use(express.json({ limit: '100kb' }));

// Login obrigatório para ver as ofertas (configurável no painel).
// Mantém conectado quem já entrou: renova as sessões (site, cliente e admin) enquanto a pessoa usa o site.
app.use((req, res, next) => {
  try {
    require('./src/users').renovarSessao(req, res);
    require('./src/clientes').renovarSessao(req, res);
    require('./src/auth').renovarSessao(req, res);
  } catch (err) { console.error('[SESSAO]', err.message); }
  next();
});
// Registros de acesso (IP, data e hora) por 6 meses — Marco Civil da Internet, art. 15
app.use(require('./src/registro-acesso').middleware);
app.use(access.guard);

// O painel só abre para quem entrou como "admin". Exceção: antes da senha existir, /admin mostra a criação de senha
// (aceita apenas no próprio computador do servidor).
app.use((req, res, next) => {
  if (req.method === 'GET' && /^\/admin(\.html)?\/?$/.test(req.path) && auth.hasPassword() && !auth.isLoggedIn(req)) {
    return res.redirect('/conta?voltar=/admin');
  }
  // Tela de postagens: só o admin, os usuários que ele liberou e os clientes da ferramenta.
  if (req.method === 'GET' && /^\/postagens(\.html)?\/?$/.test(req.path) && !postagens.poster(req)) {
    return res.redirect('/conta?voltar=/postagens');
  }
  next();
});

// Central: quem tem área de trabalho (afiliado, loja, equipe, administrador) usa tudo numa guia só
const central = require('./src/central');
app.use(central.redirecionar);
app.get('/api/central', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const areas = central.areas(req);
  res.json({ areas, trabalho: central.temTrabalho(areas), visualizar: central.visualizar(req) });
});
app.get('/central', (req, res) => {
  const areas = central.areas(req);
  if (!areas.length) return res.redirect('/conta?voltar=/central');
  if (!central.temTrabalho(areas)) return res.redirect('/');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'central.html'));
});

// Mensagens ficam no painel flutuante do canto inferior direito: /mensagens?c=ID&pedido=ID abre a página de ofertas
// com a conversa aberta no painel. A tela completa só é usada dentro de Minha conta (aba Mensagens): /mensagens/tela.
app.get(['/mensagens', '/mensagens.html'], (req, res) => {
  const q = new URLSearchParams();
  q.set('chat', String(Number(req.query.c) || ''));
  if (Number(req.query.pedido)) q.set('pedido', String(Number(req.query.pedido)));
  res.redirect(`/?${q}`);
});
app.get('/mensagens/tela', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'mensagens.html')));
// SAC: o chamado do usuário abre no painel de Mensagens; /sac é a fila de atendimento (admin e atendentes)
app.get('/sac/meu', (req, res) => res.redirect('/?sac=1'));
app.get(['/sac', '/sac.html'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'sac.html')));
// Área de trabalho da equipe (SAC e Moderação do chat); as próprias páginas conferem a permissão pela API
app.get(['/trabalho', '/trabalho.html'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'trabalho.html')));
app.get(['/moderacao', '/moderacao.html'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'moderacao.html')));
app.get(['/equipe', '/equipe.html'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'equipe.html')));
// Guia da equipe: só para quem tem cargo na equipe (ou o dono do site); fica fora de public/ para não abrir sem login
app.get('/trabalho/guia', (req, res) => {
  const dono = require('./src/perfis').donoDe(req);
  if (!dono) return res.redirect('/conta?voltar=/trabalho%23guia');
  if (!require('./src/cargos').de(dono).permissoes.length) return res.redirect('/trabalho');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'src', 'paginas', 'guia-equipe.html'));
});

// O próprio perfil fica em Minha conta (aba "Meu perfil"); admin e clientes só da ferramenta continuam em /perfil.
app.get(['/perfil', '/perfil.html'], (req, res, next) => {
  const dono = require('./src/perfis').donoDe(req);
  const u = dono && dono.startsWith('u:') ? require('./src/users').currentUser(req) : null;
  // Afiliado com a ferramenta não usa Minha conta (ela manda de volta ao painel): o perfil abre aqui mesmo
  if (u && !(u.tipo === 'afiliado' && u.cliente_id)) return res.redirect('/conta?aba=meuperfil');
  next();
});

// Google AdSense: coloca a meta de verificação e o script do AdSense no <head> das páginas HTML.
// (Sem ID configurado, as páginas são servidas sem mudança.)
const paginaCache = new Map();
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const client = String(require('./src/settings').get('adsense_client') || '').trim();
  if (!/^ca-pub-\d{10,20}$/.test(client)) return next();
  let nome = req.path === '/' ? 'index.html' : req.path.replace(/^\/+/, '');
  if (!nome.endsWith('.html')) nome += '.html';
  if (!/^[a-z0-9-]+\.html$/.test(nome) || nome === 'admin.html') return next();
  const arquivo = path.join(PUBLIC_DIR, nome);
  let st;
  try { st = fs.statSync(arquivo); } catch { return next(); }
  const chave = `${arquivo}|${st.mtimeMs}|${client}`;
  let html = paginaCache.get(chave);
  if (!html) {
    // Só a etiqueta de verificação do AdSense; o script dos anúncios (que usa cookies) carrega depois do aceite (cookies.js)
    html = fs.readFileSync(arquivo, 'utf8').replace('</head>', `<meta name="google-adsense-account" content="${client}">
</head>`);
    paginaCache.set(chave, html);
  }
  res.type('html').setHeader('Cache-Control', 'no-cache');
  res.send(html);
});

// Arquivo de instalação do app (manifest) com as cores do tema da pessoa: o Android pinta a barra de navegação de
// baixo (e a tela de abertura) com essas cores, e não deixa a página pintar essa área. Tema escolhido no site
// (cookie ofertou_tema, gravado por tema.js) ou, no automático, o tema do celular (Sec-CH-Prefers-Color-Scheme).
const MANIFEST_BASE = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'site.webmanifest'), 'utf8'));
app.use((req, res, next) => { // pede ao Chrome para informar o tema do aparelho nos próximos pedidos
  if (req.method === 'GET' && req.accepts('html')) res.setHeader('Accept-CH', 'Sec-CH-Prefers-Color-Scheme');
  next();
});
app.get('/site.webmanifest', (req, res) => {
  // ?tema= vem da página (tema.js); o cookie e o aviso do Chrome ficam de reserva
  const tema = ['claro', 'escuro'].includes(req.query.tema) ? req.query.tema : auth.parseCookies(req.headers.cookie).ofertou_tema;
  const escuro = tema === 'escuro' || (tema !== 'claro' && /dark/i.test(String(req.get('sec-ch-prefers-color-scheme') || '')));
  const cor = escuro ? '#0e1210' : '#eef2ee';
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('Vary', 'Cookie, Sec-CH-Prefers-Color-Scheme');
  res.type('application/manifest+json').send(JSON.stringify({ ...MANIFEST_BASE, background_color: cor, theme_color: cor,
    start_url: `/?origem=app&barra=${escuro ? 'escuro' : 'claro'}` }));
});

// Google e outros buscadores: o que pode ser indexado (robots.txt) e a lista de páginas públicas (sitemap.xml).
// Áreas internas, a API e os links de redirecionamento (/o/:id) ficam de fora.
const baseUrl = req => `${req.protocol}://${req.get('host')}`;
// Página do grupo (captação): um link só para divulgar e para anúncios; o botão leva ao próximo grupo que ainda não
// lotou (src/grupos-convite.js, src/paginas/grupo.js)
app.get(['/grupo', '/grupos'], (req, res) => {
  const gc = require('./src/grupos-convite');
  if (!gc.lista().length) return res.redirect('/');
  const total = gc.resumo().reduce((a, g) => a + g.entradas, 0);
  res.set('Cache-Control', 'no-store');
  res.type('html').send(require('./src/paginas/grupo').pagina(require('./src/settings').getAll(), total));
});
app.get('/grupo/entrar', (req, res) => {
  const g = require('./src/grupos-convite').proximo();
  res.set('Cache-Control', 'no-store');
  res.redirect(302, g ? g.link : '/');
});

// Página do grupo de cada cliente da ferramenta
app.get('/g/:slug', (req, res) => {
  const gc = require('./src/grupos-convite');
  const cid = gc.clienteDoEndereco(req.params.slug);
  if (!cid || !gc.lista(cid).length) return res.redirect('/');
  const total = gc.resumo(cid).reduce((a, g) => a + g.entradas, 0);
  res.set('Cache-Control', 'no-store');
  res.type('html').send(require('./src/paginas/grupo').pagina(require('./src/clientes').config(cid), total, {
    entrar: `/g/${encodeURIComponent(req.params.slug)}/entrar`, tituloPadrao: 'Entre no nosso grupo de ofertas',
  }));
});
app.get('/g/:slug/entrar', (req, res) => {
  const gc = require('./src/grupos-convite');
  const cid = gc.clienteDoEndereco(req.params.slug);
  const g = cid ? gc.proximo(cid) : null;
  res.set('Cache-Control', 'no-store');
  res.redirect(302, g ? g.link : '/');
});
// Página de venda da ferramenta de afiliado
app.get('/ferramenta', (req, res) => {
  res.type('html').set('Cache-Control', 'no-cache').send(require('./src/paginas/ferramenta').pagina());
});

// Páginas de categoria, tipo de produto e marca (src/paginas/ofertas-seo.js)
app.get(/^\/ofertas\/([a-z0-9-]+(?:\/[a-z0-9-]+)?)\/?$/, (req, res, next) => {
  if (!access.canSeeOffers(req)) return res.redirect('/conta');
  const seo = require('./src/paginas/ofertas-seo');
  const p = seo.pagina(req.params[0].split('/'), seo.baseDe(req));
  if (!p) return next();
  res.type('html').setHeader('Cache-Control', 'no-cache');
  res.send(p.html);
});
// Navegadores e robôs pedem /favicon.ico mesmo com o ícone indicado nas páginas
app.get('/favicon.ico', (req, res) => res.redirect(301, '/images/favicon-32x32.png'));

// Para um monitor externo (UptimeRobot etc.) avisar quando o site cair: 200 se o banco responde. Sem dados sensíveis.
app.get('/healthz', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try { require('./src/db').get('SELECT 1 AS ok'); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});
// Sessão: resposta única para as páginas saberem se há login, sem pedir perfil, comunidade e alertas à toa (visitante)
app.get('/api/sessao', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ logado: Boolean(require('./src/perfis').donoDe(req)) });
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Allow: /',
    ...['/admin', '/central', '/api/', '/o/', '/p/', '/oferta/', '/grupo', '/g/', '/trabalho', '/moderacao', '/equipe', '/sac', '/mensagens', '/postagens', '/cliente', '/conta?'].map(p => `Disallow: ${p}`),
    '',
    `Sitemap: ${baseUrl(req)}/sitemap.xml`,
    '',
  ].join('\n'));
});
app.get('/sitemap.xml', (req, res) => {
  const base = String(require('./src/settings').get('site_url') || '').replace(/\/+$/, '') || baseUrl(req);
  const hoje = new Date().toISOString().slice(0, 10);
  const urls = [['/', 'hourly', '1.0'], ['/conta', 'weekly', '0.8'], ['/ajuda', 'monthly', '0.6'], ['/anuncie', 'monthly', '0.5'], ['/ferramenta', 'weekly', '0.7'], ['/privacidade', 'yearly', '0.3']]
    .map(([p, freq, pri]) => ({ loc: base + p, freq, pri }));
  try {
    const lojas = require('./src/db').all(`SELECT lj.slug FROM lojas lj JOIN users u ON u.id = lj.user_id
      WHERE lj.oculta = 0 AND u.status = 'active' ORDER BY lj.id LIMIT 5000`);
    for (const l of lojas) urls.push({ loc: `${base}/loja/${encodeURIComponent(l.slug)}`, freq: 'daily', pri: '0.6' });
  } catch { /* sem lojas parceiras */ }
  try { for (const u of require('./src/paginas/ofertas-seo').enderecos()) urls.push({ loc: base + u.p, freq: 'daily', pri: u.pri }); } catch { /* sem ofertas */ }
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${esc(u.loc)}</loc><lastmod>${hoje}</lastmod><changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join('\n')}
</urlset>
`);
});

// Somente a pasta public/ é servida. Banco de dados e código ficam inacessíveis.
// Cache no navegador: CSS/JS com ?v= (o número muda a cada versão) ficam guardados por 1 ano; imagens por 7 dias;
// páginas HTML são sempre conferidas (ETag), para as mudanças aparecerem na hora.
app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  extensions: ['html'],
  setHeaders(res, arquivo) {
    if (/\.(css|js)$/.test(arquivo) && res.req.query.v) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else if (/\.(png|jpe?g|webp|svg|ico|woff2?)$/.test(arquivo)) res.setHeader('Cache-Control', 'public, max-age=604800');
    else if (/\.html$/.test(arquivo)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Fotos enviadas pelas empresas: só imagens já verificadas, sem execução de nada.
app.use('/uploads', express.static(UPLOADS_DIR, {
  index: false,
  dotfiles: 'deny',
  setHeaders: res => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  },
}));

app.use(publicRoutes);
app.use(adminRoutes);
app.use(contaRoutes);
app.use(postagens.router);
app.use(clienteRoutes);
app.use(assinaturaRoutes);
app.use(appRoutes);
app.use(perfilRoutes);
app.use(ganhosRoutes);
app.use(require('./src/routes/chat'));
app.use(require('./src/routes/sac')); // SAC: chamados e fila de atendimento
app.use(require('./src/routes/trabalho')); // Área de trabalho da equipe: Moderação do chat
app.use(require('./src/routes/loja')); // página profissional das lojas: aparência, catálogos e avaliações // mensagens, pedidos às lojas e contadores de acesso

app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/conta', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'conta.html')));
app.get('/postagens', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'postagens.html')));
app.get('/cliente', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'cliente.html')));
app.get('/assinar', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'assinar.html')));
app.get('/anuncie', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'anuncie.html')));
app.get('/privacidade', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'privacidade.html')));
app.get('/ajuda', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'ajuda.html'))); // Guia do usuário (aberto a todos)
app.get('/loja/:slug', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'loja.html')));
app.get('/anuncio/:id', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'anuncio.html')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
app.get('*', (req, res) => {
  // Arquivos (com extensão) e caminhos ocultos (.env, .git...) inexistentes respondem 404.
  if (path.extname(req.path) || /\/\./.test(req.path)) return res.status(404).send('Não encontrado');
  if (!access.canSeeOffers(req)) return res.redirect('/conta');
  // Endereço que não existe: mostra as ofertas, mas responde 404 (com 200 o Google trata como página duplicada)
  res.status(req.path === '/' ? 200 : 404).sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[SERVER]', err);
  if ((err.status || 500) >= 500) require('./src/erros-site').registrar(err, `${req.method} ${req.path}`);
  res.status(err.status || 500).json({ error: err.status === 413 ? 'Os dados enviados são grandes demais para este envio.' : 'Erro interno.' });
});

// Na Vercel o servidor não fica ligado: cada acesso executa o app exportado e não há mineração agendada.
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, HOST, () => {
    console.log('\n==================================================');
    console.log('🚀 OFERTOU! RODANDO');
    console.log(`🌐 Site:   http://localhost:${PORT}`);
    console.log(`🔐 Painel: http://localhost:${PORT}/admin`);
    console.log('==================================================\n');
    if (process.env.DISABLE_MINER !== '1') miner.startScheduler();
    if (process.env.DISABLE_MINER !== '1') require('./src/comissao-shopee').iniciar(); // comissão das ofertas antigas da Shopee
    if (process.env.DISABLE_AGENDA !== '1') require('./src/whatsapp-proprio').iniciar(); // volta a conectar o número, antes do agendamento
    if (process.env.DISABLE_AGENDA !== '1') require('./src/agenda').iniciar();
    require('./src/repostar-grupos').iniciar(); // limpeza do registro das repostagens
    try { require('./src/palavras-proibidas').aplicar(); } catch (err) { console.error('[palavras proibidas]', err.message); } // tira do ar o que já estava no site e caiu na lista
    require('./src/relampago').iniciar({ radar: process.env.DISABLE_MINER !== '1', postar: process.env.DISABLE_AGENDA !== '1' });
    if (process.env.DISABLE_AGENDA !== '1') require('./src/alertas-whatsapp').iniciar(); // alertas de ofertas no WhatsApp particular
    require('./src/pedidos-loja').iniciar(); require('./src/busca-ofertas').aquecer(); require('./src/vitrine').aquecer(); // confere no Mercado Pago os pedidos esperando pagamento // postagens agendadas (manhã, tarde, noite)
    if (process.env.DISABLE_AGENDA !== '1') require('./src/backup').iniciar(); // uma cópia do banco por dia, de madrugada
    if (process.env.DISABLE_AGENDA !== '1') require('./src/assinaturas').iniciar(); // renovações automáticas do Mercado Pago e aviso do fim do período grátis
    require('./src/ganhos').iniciar(); // confere a cada hora se alguma plataforma de afiliados já tem saldo para sacar
    if (process.env.DISABLE_AGENDA !== '1') { require('./src/cliente-ganhos').iniciar(); require('./src/membros-grupo').iniciar(); }
    if (process.env.DISABLE_AGENDA !== '1') require('./src/ganhos-sync').iniciar(); // busca as vendas na Shopee e na Awin a cada 6 h
    const acessos = require('./src/registro-acesso');
    acessos.limpar(); setInterval(acessos.limpar, 24 * 3600 * 1000); // registros de acesso com mais de 6 meses
    // Conexões das lojas com o Mercado Pago (valem 180 dias): renova as que estão perto de vencer
    const mpLojas = require('./src/mp-lojas');
    mpLojas.renovarTodas(); setInterval(() => mpLojas.renovarTodas(), 24 * 3600 * 1000);
    // Empresas: foto do perfil = logo da loja (alinha as contas antigas que estavam diferentes)
    try { require('./src/foto-loja').alinharTudo(); } catch (err) { console.error('[FOTO LOJA]', err.message); }
    const limparVitrine = () => {
      try { require('./src/vitrine').limparCache(); } catch (err) { console.error('[VITRINE]', err.message); }
    };
    limparVitrine();
    setInterval(limparVitrine, 24 * 3600 * 1000); // cartões da vitrine gerados há mais de 3 dias
    // Fotos das ofertas guardadas em data/cache-img: vencidas e excesso saem de hora em hora
    const imgCache = require('./src/img-cache');
    imgCache.limpar(); setInterval(() => imgCache.limpar(), 3600 * 1000);
    // Servidor travado (código pesado segurando os outros pedidos): avisa na janela do site
    const { monitorEventLoopDelay } = require('perf_hooks');
    const atraso = monitorEventLoopDelay({ resolution: 20 }); atraso.enable();
    setInterval(() => {
      const ms = atraso.max / 1e6;
      if (ms > 300) console.log(`[LENTO] servidor ficou travado por até ${Math.round(ms)} ms no último minuto`);
      atraso.reset();
    }, 60 * 1000).unref();
  });
}
