// Postar uma oferta nos grupos de WhatsApp, a partir da API (src/routes/whatsapp-api.js) e da tela de postagens.
const db = require('./db');
const settings = require('./settings');
const whatsapp = require('./whatsapp');
const social = require('./social');

const falha = (msg, status = 400) => Object.assign(new Error(msg), { status });
const cfgDe = cid => (cid ? require('./clientes').config(cid) : settings.getAll());

// Confere os grupos pedidos: só os que este número administra. Aceita ["id"] ou [{ id, nome }].
async function conferirGrupos(s, pedidos) {
  const meus = await whatsapp.listarGrupos(s);
  const porId = new Map(meus.map(g => [g.id, g]));
  const ids = (Array.isArray(pedidos) ? pedidos : []).map(g => String(g?.id || g));
  const fora = ids.filter(id => !porId.has(id));
  if (fora.length) throw falha(`Grupo que não é deste número: ${fora.slice(0, 3).join(', ')}.`);
  return [...new Set(ids)].map(id => ({ id, nome: porId.get(id).nome }));
}
// Destino de uma postagem, para guardar na fila: { grupos, por_tipo } (ou nulo: usa os grupos salvos no painel)
async function destino(cid, grupos, porTipo = true) {
  if (!Array.isArray(grupos) || !grupos.length) return null;
  return { grupos: await conferirGrupos(cfgDe(cid), grupos), por_tipo: porTipo !== false };
}

// Publica agora, em segundo plano (há pausas entre os grupos). Devolve para quantos grupos vai.
async function postar(cid, { offerId, texto, grupos, porTipo = true, autor }) {
  const s0 = cfgDe(cid);
  const o = db.get('SELECT * FROM offers WHERE id = ?', offerId);
  if (!o) throw falha('Oferta não encontrada.', 404);
  if (!require('./offers').isActive(o.id)) throw falha('Esta oferta saiu do ar.', 409);
  const lista = Array.isArray(grupos) && grupos.length ? await conferirGrupos(s0, grupos) : null;
  const s = lista ? whatsapp.comDestinos(s0, lista, porTipo) : s0;
  const motivo = social.REDES.whatsapp.pronta(s);
  if (motivo) throw falha(motivo, 409);
  const vaoReceber = whatsapp.gruposDaOferta(s, o.categoria, o.store_id);
  if (!vaoReceber.length) throw falha('Nenhum grupo escolhido recebe este tipo de produto desta loja.', 409);
  const conferencia = await require('./preco-na-hora').conferir(o.id);
  if (conferencia.acao === 'pular') throw falha(conferencia.motivo, 409);
  const atual = db.get('SELECT * FROM offers WHERE id = ?', offerId);
  const link = cid ? await require('./clientes').linkParaPostar(cid, atual, s) : null;
  if (link) atual.__link = link;
  atual.__link = require('./encurtador').curto(social.postLink(atual, s));
  const mensagem = String(texto || '').trim() || social.textoPadrao(atual, s);
  social.publicar(atual.id, ['whatsapp'], mensagem, autor, { s, ...(cid ? { clienteId: cid, link } : {}) })
    .catch(err => console.error('[POSTAR]', err.message));
  return { ok: true, offer_id: atual.id, grupos: vaoReceber.map(g => ({ id: g.id, nome: g.nome })), preco: atual.preco_atual };
}

module.exports = { postar, destino, conferirGrupos };
