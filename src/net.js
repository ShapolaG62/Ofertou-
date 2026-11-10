// Acesso seguro a links informados por usuários (feeds de lojas, imagens).
// Bloqueia endereços internos (localhost, rede local, nuvem) para que ninguém use o servidor
// para acessar a sua rede (ataque conhecido como SSRF).
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const { http: client } = require('./util');

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19));
  }
  const g = gruposV6(ip);
  if (!g) return true; // endereço que não deu para ler: na dúvida, recusa
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeros = n => g.slice(0, n).every(x => x === 0);
  // Endereços IPv6 que carregam um IPv4 dentro: confere o IPv4 (senão [::ffff:127.0.0.1] passava como externo)
  if (zeros(5) && g[5] === 0xffff) return isPrivateIp(v4(g[6], g[7]));               // ::ffff:a.b.c.d (mapeado)
  if (zeros(6)) return g[6] === 0 && g[7] <= 1 ? true : isPrivateIp(v4(g[6], g[7])); // ::, ::1 e ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return isPrivateIp(v4(g[6], g[7])); // 64:ff9b::/96 (NAT64)
  if (g[0] === 0x2002) return isPrivateIp(v4(g[1], g[2]));                              // 2002::/16 (6to4)
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;          // 100::/64 (descarte)
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00; // local, link-local, multicast
}

// "::ffff:7f00:1" → [0,0,0,0,0,0xffff,0x7f00,1] (aceita a forma com IPv4 no fim). null = não é IPv6 válido.
function gruposV6(ip) {
  let s = String(ip).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!net.isIPv6(s)) return null;
  const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    const [a, b, c, d] = m[1].split('.').map(Number);
    s = s.slice(0, -m[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [esq, dir] = s.includes('::') ? s.split('::') : [s, null];
  const parte = t => (t ? t.split(':').map(x => parseInt(x, 16)) : []);
  const a = parte(esq), b = dir === null ? [] : parte(dir);
  const grupos = dir === null ? a : [...a, ...Array(8 - a.length - b.length).fill(0), ...b];
  return grupos.length === 8 && grupos.every(x => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? grupos : null;
}

// Resolve o nome e recusa a conexão se qualquer endereço for interno (vale também para redirecionamentos).
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (list.some(a => isPrivateIp(a.address))) {
      return callback(Object.assign(new Error('Endereço não permitido'), { code: 'EBLOCKED' }));
    }
    callback(null, address, family);
  });
}

const httpAgent = new http.Agent({ lookup: guardedLookup });
const httpsAgent = new https.Agent({ lookup: guardedLookup });

function assertPublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Link inválido.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('O link precisa começar com https://');
  if (url.username || url.password) throw new Error('Link inválido.');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Porta não permitida.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Endereço não permitido.');
  if (net.isIP(host) && isPrivateIp(host)) throw new Error('Endereço não permitido.');
  return url;
}

// GET seguindo no máximo 3 redirecionamentos, todos verificados.
async function safeGet(raw, opts = {}) {
  let current = raw;
  for (let i = 0; i < 4; i++) {
    assertPublicUrl(current);
    const res = await client.get(current, {
      ...opts,
      httpAgent, httpsAgent,
      maxRedirects: 0,
      maxContentLength: opts.maxContentLength || 8 * 1024 * 1024,
      validateStatus: () => true,
    });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      current = new URL(res.headers.location, current).href;
      continue;
    }
    return res;
  }
  throw new Error('Redirecionamentos demais.');
}

// POST para um endereço informado pela pessoa (aviso a outros programas), sem seguir redirecionamentos
async function safePost(raw, corpo, opts = {}) {
  assertPublicUrl(raw);
  return client.post(raw, corpo, { ...opts, httpAgent, httpsAgent, maxRedirects: 0, validateStatus: () => true });
}

// Endereço final de um link encurtado (meli.la, amzn.to, s.shopee.com.br…), seguindo os redirecionamentos com as
// mesmas proteções do safeGet. Usado pelo conversor de links das Postagens.
async function resolverLink(raw) {
  let current = raw;
  for (let i = 0; i < 6; i++) {
    assertPublicUrl(current);
    const res = await client.get(current, { httpAgent, httpsAgent, maxRedirects: 0, maxContentLength: 2 * 1024 * 1024,
      validateStatus: () => true, timeout: 10000, responseType: 'text' });
    if (res.status >= 300 && res.status < 400 && res.headers.location) { current = new URL(res.headers.location, current).href; continue; }
    // Alguns encurtadores redirecionam pela página (meta refresh ou location.href)
    const m = /http-equiv=["']?refresh[^>]*url=([^"'>\s]+)/i.exec(String(res.data || '').slice(0, 20000));
    if (m) { current = new URL(m[1].replace(/&amp;/g, '&'), current).href; continue; }
    return current;
  }
  return current;
}

module.exports = { safePost, safeGet, assertPublicUrl, isPrivateIp, resolverLink };
