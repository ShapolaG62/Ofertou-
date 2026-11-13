// Liga o servidor de verdade num banco temporário e testa pelos endereços: cabeçalhos, login em duas etapas nas duas portas
// de entrada, cliques e páginas públicas. Rode com: npm test
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');

const PASTA = fs.mkdtempSync(path.join(os.tmpdir(), 'ofertou-servidor-'));
const PORTA = 39000 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORTA}`;
const SENHA = 'Kw9#vTz4!qLm2x';
let proc;

const pede = (p, opts = {}) => fetch(BASE + p, { redirect: 'manual', ...opts });
const json = (p, body, cookie) => pede(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const cookieDe = r => (r.headers.get('set-cookie') || '').split(';')[0];

test.before(async () => {
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: PASTA, PORT: String(PORTA), DISABLE_MINER: '1', DISABLE_AGENDA: '1', ADMIN_PASSWORD: SENHA, NODE_ENV: 'test' },
    stdio: ["ignore", "ignore", process.env.TESTE_VERBOSO ? "inherit" : "ignore"],
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await pede('/healthz')).ok) {
        // O banco novo vem com o site fechado para quem não tem login: abre, como está no ar
        const c = cookieDe(await json('/api/admin/login', { password: SENHA }));
        await pede('/api/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: c }, body: JSON.stringify({ exigir_login: '0' }) });
        return;
      }
    } catch { /* ainda ligando */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('o servidor não ligou');
});
test.after(async () => {
  proc?.kill();
  await new Promise(r => setTimeout(r, 500));
  try { fs.rmSync(PASTA, { recursive: true, force: true }); } catch { /* o Windows pode segurar o arquivo por um instante */ }
});

test('páginas públicas, 404 e cabeçalhos de segurança', async () => {
  const home = await pede('/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await home.text(), /rel="canonical"/);
  assert.equal((await pede('/nao-existe')).status, 404);
  assert.equal((await pede('/ofertas/nao-existe')).status, 404);
  assert.equal((await pede('/ofertas/celulares')).status, 200);
  assert.equal((await pede('/favicon.ico')).status, 301);
  assert.match(await (await pede('/robots.txt')).text(), /Disallow: \/oferta\//);
  assert.match(await (await pede('/sitemap.xml')).text(), /\/ofertas\/celulares/);
  assert.equal((await pede('/data/ofertas.db')).status, 404, 'o banco não é servido');
});

test('busca confirmada e listas de mais pesquisados', async () => {
  const r = await json('/api/offers/termo', { q: '#perfil' });
  assert.deepEqual(await r.json(), { status: 'ignorado' });
  assert.deepEqual(await (await pede('/api/offers/termo?q=nada')).json(), { status: 'cadastrado' });
  assert.notEqual((await pede('/api/offers/populares')).status, 200, 'as listas não são públicas');
  assert.equal((await pede('/api/cliente/populares')).status, 401);
});

test('visitante: sessão sem erro e áreas fechadas', async () => {
  assert.deepEqual(await (await pede('/api/sessao')).json(), { logado: false });
  for (const p of ['/api/admin/backups', '/api/admin/2fa', '/api/admin/offers/suspeitas', '/api/admin/dashboard']) {
    assert.equal((await pede(p)).status, 401, p);
  }
});

test('login em duas etapas nas duas portas de entrada', async () => {
  // Gera o código como o app do celular faria (sem abrir o banco temporário do servidor neste processo)
  const crypto = require('crypto');
  const dois = {
    contador: () => Math.floor(Date.now() / 30000),
    codigo(segredo, n) {
      const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      let bits = '';
      for (const c of segredo.replace(/ /g, '')) bits += A.indexOf(c).toString(2).padStart(5, '0');
      const chave = Buffer.from(bits.match(/.{8}/g).map(b => parseInt(b, 2)));
      const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(n));
      const h = crypto.createHmac('sha1', chave).update(m).digest();
      return String((h.readUInt32BE(h[19] & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
    },
  };
  const r0 = await json('/api/admin/login', { password: SENHA });
  assert.equal(r0.status, 200);
  const admin = cookieDe(r0);
  assert.deepEqual(await (await pede('/api/sessao', { headers: { Cookie: admin } })).json(), { logado: true });

  assert.equal((await json('/api/admin/2fa/iniciar', { senha: 'errada' }, admin)).status, 400);
  const ini = await (await json('/api/admin/2fa/iniciar', { senha: SENHA }, admin)).json();
  assert.match(ini.qr, /<svg/);
  const agora = dois.contador();
  const conf = await (await json('/api/admin/2fa/confirmar', { codigo: dois.codigo(ini.segredo, agora) }, admin)).json();
  assert.equal(conf.codigos.length, 8);
  assert.equal((await pede('/api/admin/2fa', { headers: { Cookie: admin } })).status, 200, 'a sessão atual continua');

  // Painel: senha certa não entra sem o código
  const s1 = await json('/api/admin/login', { password: SENHA });
  assert.equal(s1.status, 401);
  assert.equal((await s1.json()).precisa_codigo, true);
  assert.equal(cookieDe(s1), '', 'nenhuma sessão antes do código');
  assert.equal((await json('/api/admin/login', { password: SENHA, codigo: '000000' })).status, 401);

  // /conta (usuário "admin"): mesma regra
  const s2 = await json('/api/conta/entrar', { email: 'admin', senha: SENHA });
  assert.equal(s2.status, 401);
  assert.equal((await s2.json()).precisa_codigo, true);
  const s3 = await json('/api/conta/entrar', { email: 'admin', senha: SENHA, codigo: conf.codigos[0] });
  assert.equal(s3.status, 200, 'código de recuperação entra');
  assert.equal((await s3.json()).admin, true);

  // Código do app, uma vez só
  const novo = dois.codigo(ini.segredo, agora + 1);
  const s4 = await json('/api/admin/login', { password: SENHA, codigo: novo });
  assert.equal(s4.status, 200);
  assert.ok(cookieDe(s4).startsWith('gp_admin='));
  assert.equal((await json('/api/admin/login', { password: SENHA, codigo: novo })).status, 401, 'o mesmo código não entra de novo');

  // Desligar pede senha e código
  assert.equal((await json('/api/admin/2fa/desligar', { senha: SENHA, codigo: '000000' }, admin)).status, 400);
  assert.equal((await json('/api/admin/2fa/desligar', { senha: SENHA, codigo: conf.codigos[1] }, admin)).status, 200);
  assert.equal((await json('/api/admin/login', { password: SENHA })).status, 200);
});

test('API própria de WhatsApp: sem login ou sem a chave, nada abre', async () => {
  for (const p of ['/api/admin/wa/status', '/api/admin/wa/conversas', '/api/admin/wa/chave', '/api/admin/wa/grupos', '/api/admin/wa/foto/1@g.us', '/api/cliente/wa/status', '/api/cliente/wa/conversas', '/api/wa/status', '/api/wa/mensagens', '/api/wa/grupos', '/api/wa/ofertas', '/api/wa/fila', '/api/wa/resultados']) {
    assert.equal((await pede(p)).status, 401, p);
  }
  for (const p of ['/api/admin/wa/conectar', '/api/admin/wa/desconectar', '/api/admin/wa/enviar', '/api/cliente/wa/conectar', '/api/wa/enviar', '/api/wa/postar', '/api/wa/fila', '/api/admin/wa/chave']) {
    assert.equal((await json(p, { para: '120363000000000001@g.us', texto: 'x' })).status, 401, p);
  }
  assert.equal((await pede('/api/wa/status', { headers: { Authorization: 'Bearer chave-errada' } })).status, 401);
  assert.equal((await json('/api/wa/conectar', {})).status, 401, 'a chave não conecta o número');
  assert.equal((await json('/api/whatsapp/webhook/qualquer', {})).status, 404, 'o endereço de aviso da Z-API e da Evolution saiu');
});

test('extensão do Chrome: busca do Mercado Livre pela chave, com página grande', async () => {
  const c = cookieDe(await json('/api/admin/login', { password: SENHA }));
  const { chave } = await (await pede('/api/admin/extensao/leitor', { headers: { Cookie: c } })).json();
  assert.ok(chave);
  assert.equal((await pede('/api/extensao/ml-buscas', { headers: { 'X-Ofertou-Chave': 'errada' } })).status, 401);
  const r = await pede('/api/extensao/ml-buscas', { headers: { 'X-Ofertou-Chave': chave } });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray((await r.json()).buscas));
  // Página no formato do Mercado Livre, com ~1 MB de enchimento (a página real tem perto disso)
  const texto = '0:{"optimizedResponse":{"results":[{"id":"POLYCARD","polycard":{"metadata":{"id":"MLB3505290114"},'
    + '"pictures":{"pictures":[{"id":"624087-MLB69000247214_042023"}]},"components":[{"type":"title","title":{"text":"Chinelo Babuche Nellie Boaonda"}},'
    + '{"type":"price","price":{"price_labels":[{"values":[{"key":"previous_price","price":{"value":99.99,"previous":true}}]}],"current_price":{"value":68.99}}}]}}],'
    + `"enchimento":"${'x'.repeat(1024 * 1024)}"}}\n`;
  const html = `_n.ctx.s["nr"].q(${JSON.stringify(texto)})`;
  const sem = await pede('/api/extensao/ml-busca', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'chinelo', html }) });
  assert.equal(sem.status, 401, 'sem chave não grava');
  const ok = await pede('/api/extensao/ml-busca', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ofertou-Chave': chave }, body: JSON.stringify({ query: 'chinelo', html }) });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { encontradas: 1, gravadas: 1 });
  const lojas = await (await pede('/api/admin/stores', { headers: { Cookie: c } })).json();
  assert.equal(lojas.ml_chrome.gravadas, 1);
});

test('página do grupo: sem lista de grupos, leva ao grupo principal (não volta para o início)', async () => {
  const pagina = await pede('/grupo');
  assert.equal(pagina.status, 200, 'antes, /grupo voltava para a página inicial');
  assert.match(await pagina.text(), /href="\/grupo\/entrar"/);
  const entrar = await pede('/grupo/entrar');
  assert.equal(entrar.status, 302);
  assert.match(entrar.headers.get('location'), /^https:\/\/chat\.whatsapp\.com\//);
});
