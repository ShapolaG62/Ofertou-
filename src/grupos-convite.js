// Página do grupo (tanoofertou.com.br/grupo): um link só para divulgar em bio, stories e anúncios. Cada pessoa vai
// para o primeiro grupo da lista que ainda não chegou no limite de entradas; quando todos lotam, vai para o último.
// Lista em Painel → Redes sociais → Página do grupo (um por linha: "Nome | link de convite | limite").
// O cliente da ferramenta tem a própria página em /g/<endereço>, com os próprios grupos e a própria contagem.
const settings = require('./settings');
const db = require('./db');

const CONTAGEM = 'grupos_convite_entradas'; // { link: entradas } (chave interna)
const textoDe = cid => (cid
  ? db.get(`SELECT value FROM cliente_config WHERE cliente_id = ? AND key = 'grupos_convite'`, cid)?.value
  : settings.get('grupos_convite'));
const valido = link => /^https:\/\/(chat\.whatsapp\.com|t\.me|whatsapp\.com\/channel)\//i.test(String(link || ''));
function lista(cid = null) {
  const grupos = String(textoDe(cid) || '').split(/\r?\n/).map(l => l.split('|').map(x => x.trim()))
    .map(([nome, link, limite]) => ({ nome: nome || 'Grupo', link, limite: Math.max(0, parseInt(limite, 10) || 0) }))
    .filter(g => valido(g.link));
  // Sem lista: o site usa o grupo principal (o mesmo dos botões "Grupo de ofertas"). Antes, /grupo voltava para a
  // página inicial e quem clicava no link divulgado (bio, anúncio) nunca chegava ao WhatsApp.
  if (!grupos.length && !cid) {
    const principal = String(settings.get('whatsapp_link') || '').trim();
    if (valido(principal)) return [{ nome: 'Grupo de ofertas', link: principal, limite: 0, principal: true }];
  }
  return grupos;
}
function contagem(cid = null) {
  const v = cid ? db.get('SELECT value FROM cliente_config WHERE cliente_id = ? AND key = ?', cid, CONTAGEM)?.value : settings.get(CONTAGEM);
  try { return JSON.parse(v || '{}') || {}; } catch { return {}; }
}
function gravar(cid, c) {
  if (!cid) return settings.set(CONTAGEM, JSON.stringify(c));
  db.run(`INSERT INTO cliente_config (cliente_id, key, value) VALUES (?, ?, ?)
          ON CONFLICT (cliente_id, key) DO UPDATE SET value = excluded.value`, cid, CONTAGEM, JSON.stringify(c));
}

// Escolhe o grupo da vez e conta a entrada
function proximo(cid = null) {
  const grupos = lista(cid);
  if (!grupos.length) return null;
  const c = contagem(cid);
  const g = grupos.find(x => !x.limite || (c[x.link] || 0) < x.limite) || grupos[grupos.length - 1];
  c[g.link] = (c[g.link] || 0) + 1;
  gravar(cid, c);
  return g;
}
function resumo(cid = null) {
  const c = contagem(cid);
  return lista(cid).map(g => ({ ...g, entradas: c[g.link] || 0, lotado: Boolean(g.limite) && (c[g.link] || 0) >= g.limite }));
}
function zerar(cid = null) { gravar(cid, {}); }

// Cliente ativo dono do endereço /g/<endereço>
function clienteDoEndereco(slug) {
  const r = db.get(`SELECT c.id FROM cliente_config k JOIN clientes c ON c.id = k.cliente_id
    WHERE k.key = 'grupo_slug' AND k.value = ? AND c.status = 'ativo' AND c.validade >= datetime('now')`, String(slug || '').toLowerCase());
  return r ? r.id : null;
}

module.exports = { lista, proximo, resumo, zerar, clienteDoEndereco };
