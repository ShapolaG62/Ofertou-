// WhatsApp do site e dos clientes da ferramenta: tudo passa pela API própria (src/whatsapp-proprio.js).
// Use um número separado só para as postagens: o WhatsApp pode banir números automatizados.
const proprio = () => require('./whatsapp-proprio');
const donoDe = s => proprio().donoDe(s.cliente_id);

// Pronto para enviar? Sem número conectado neste dono, diz o que falta.
function config(s) {
  const dono = donoDe(s);
  return proprio().pronto(dono) ? { tipo: 'proprio', dono } : { erro: 'Conecte o WhatsApp no painel: clique em Conectar e leia o QR code.' };
}

async function status(s) {
  const e = proprio().status(donoDe(s));
  return { conectado: e.conectado, mensagem: e.conectado ? 'Número conectado.' : (e.erro || 'Número desconectado: clique em Conectar e leia o QR code.') };
}

// Grupos deste número: os que ele administra (criados por ele ou não)
const listarGrupos = s => proprio().carregarGrupos(donoDe(s));
const resumoGrupos = s => proprio().resumoGrupos(donoDe(s));

// Quantas pessoas há em cada grupo: Map(id → total). Grupo que não responder fica de fora.
async function tamanhoGrupos(s, ids) {
  const out = new Map();
  for (const g of await proprio().carregarGrupos(donoDe(s), { todos: true })) {
    if (ids.includes(g.id) && Number.isInteger(g.membros)) out.set(g.id, g.membros);
  }
  return out;
}

// Envia foto com legenda (ou só texto, sem foto) para um grupo ou celular.
// imagem: endereço https da foto ou o arquivo (Buffer JPEG).
const enviar = (s, destino, { imagem, texto }) => proprio().enviar(donoDe(s), destino, { imagem, texto });
// Baixa a foto antes de postar: se a loja recusar, dá para trocar de oferta sem ter mandado nada ao grupo
const fotoParaEnvio = url => proprio().prepararImagem(url);

function gruposEscolhidos(s) {
  try {
    const g = JSON.parse(s.whatsapp_groups || '[]');
    return Array.isArray(g) ? g.filter(x => x && x.id).map(x => ({ ...x, categorias: Array.isArray(x.categorias) ? x.categorias.map(String) : [], lojas: Array.isArray(x.lojas) ? x.lojas.map(String) : [] })) : [];
  } catch { return []; }
}
// O grupo recebe esta oferta? Sem tipo marcado, recebe todos os tipos; sem loja marcada, todas as lojas.
const grupoRecebe = (g, categoria, loja) => (!g.categorias?.length || g.categorias.includes(categoria)) && (!g.lojas?.length || g.lojas.includes(loja));
const gruposDaOferta = (s, categoria, loja) => gruposEscolhidos(s).filter(g => grupoRecebe(g, categoria, loja));

// Grupos escolhidos para esta postagem. porTipo: cada produto vai só para os grupos do tipo e da loja dele (o que foi
// marcado no painel; grupo sem marcação usa o tipo que o nome indica). Sem porTipo, vai para todos os grupos escolhidos.
function comDestinos(s, grupos, porTipo = true) {
  const salvos = new Map(gruposEscolhidos(s).map(g => [g.id, g]));
  const { categoriasDoNome } = require('./temas-grupos');
  const lista = (grupos || []).filter(g => g && g.id).map(g => {
    const salvo = salvos.get(String(g.id));
    const nome = g.nome || salvo?.nome || String(g.id);
    let categorias = [], lojas = [];
    if (porTipo) {
      categorias = salvo ? salvo.categorias : categoriasDoNome(nome);
      lojas = salvo ? salvo.lojas : [];
    }
    return { id: String(g.id), nome, categorias, lojas };
  });
  return { ...s, whatsapp_groups: JSON.stringify(lista) };
}

module.exports = {
  fotoParaEnvio, config, status, listarGrupos, resumoGrupos, tamanhoGrupos, enviar, gruposEscolhidos, grupoRecebe, gruposDaOferta, comDestinos };
