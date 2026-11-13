// Termos de marca e modelo aprendidos com as ofertas das lojas com link de afiliado.
// Por que existe (2026-11-13): cada termo genérico ("perfume arabe") só alcança os primeiros produtos de cada loja
// (na Shopee, 150). O perfume "Afnan Supremacy" de R$ 139 nem aparecia nos 300 primeiros de "perfume arabe", mas era o
// 1º dos mais vendidos buscando "afnan". Termo com marca e modelo acha o que o genérico perde.
// Como acha marca e modelo sem lista pronta: produto conhecido aparece com o mesmo par de palavras em lojas diferentes
// ("afnan supremacy" na AliExpress e na Shopee), e marca é palavra rara no catálogo ("afnan" está em poucas ofertas;
// "perfume" e "masculino", em milhares). Entra o par de palavras vizinhas no começo do nome que:
//  • aparece em pelo menos 2 lojas (uma delas com afiliado) e em pelo menos 3 ofertas;
//  • tem uma palavra rara (em menos de 0,3% das ofertas) e nenhuma palavra genérica (cor, tamanho, medida...);
//  • não é quase igual nem já está dentro de um termo da lista, e passa pelas regras dos termos aprendidos.
// Uma vez por dia, depois da mineração. Limite por dia no painel; a lista respeita o mesmo tamanho máximo.
const settings = require('./settings');

const ESTADO = 'termos_marca_estado'; // { dia, hoje, total, ultimos: [{ q, lojas, ofertas, em }] } (interna)
const PALAVRAS_NO_COMECO = 8;
const RARA = 0.003;
const GENERICAS = new Set(`de da do das dos e com para pra por em a o as os um uma no na sem kit novo nova original originais oficial lancamento
promocao oferta ofertas frete gratis envio imediato pronta entrega masculino masculina feminino feminina unissex infantil adulto adulta menino menina
preto preta branco branca azul rosa cinza vermelho vermelha verde bege amarelo amarela roxo dourado prata marrom nude colorido estampado liso lisa
tamanho tamanhos cor cores unidade unidades und un pecas peca pcs tipo modelo linha premium luxo qualidade alta top melhor super mini grande pequeno
ml cm mm kg gr g l lt litro litros w watts v volts bivolt polegadas pol pares par conjunto jogo caixa pacote combo
eau parfum edp edt toilette perfume colonia body splash creme gel oleo
compativel similar replica tipo
notebook celular smartphone tablet tv televisao monitor cabo capa capinha case pelicula suporte carregador fonte fone fones headset mouse
teclado gamer gaming cadeira mesa tenis sapato sapatenis sandalia chinelo bota bolsa mochila carteira relogio smartwatch camiseta camisa
calca bermuda shorts vestido saia blusa jaqueta moletom meia cueca calcinha sutia shampoo condicionador panela frigideira jogo jogos placa
mae video processador memoria ram ssd hd nvme sata ii iii iv pci express usb wifi bluetooth interno interna externo externa disco rigido
uhd hdr 4k 8k fhd full qled led oled lcd smart split hi wall inverter volante controle protetora protetor portatil eletrico eletrica
digital automatico automatica fio core i3 i5 i7 i9 ar condicionado geladeira fogao forno micro ondas maquina lavar aspirador ventilador
cafeteira liquidificador batedeira air fryer fritadeira escova secador chapinha barbeador aparelho garrafa copo pote organizador tapete
cortina lencol travesseiro colchao toalha brinquedo boneca carrinho bebe infantil pneu oleo pecas acessorio acessorios
semi mecanico mecanica tela mesh escritorio presidente diretor ergonomica giratoria reclinavel microfone condensador dinamico embutido
fixo universal dual sim chip plus bronze gold adaptador displayport hdmi vga macho femea entrada saida som caixa sem com alto falante
manga curta longa dupla face visao noturna adultos adulto filhotes filhote raca racas pequenas pequenos grandes medio media
aco inox inoxidavel madeira macica secagem rapida metrica`.split(/\s+/).filter(Boolean));
const MEDIDA = /^(\d+([.,]\d+)?(ml|g|gr|kg|l|lt|w|v|gb|tb|mb|mah|cm|mm|m|pol|hz|mhz|ghz|un|pcs|x)?|ddr\d)$/;
const semAcento = v => String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const palavrasDe = nome => semAcento(nome).split(' ').slice(0, PALAVRAS_NO_COMECO).filter(p => p.length >= 2 && !MEDIDA.test(p));

// Candidatos a partir das ofertas no ar: [{ q, lojas, ofertas, categoria }]. Com 140 mil ofertas a conta leva ~7 s:
// a cada 2.000 ofertas solta o servidor para atender quem está no site (respirar), senão o site parava esse tempo todo.
const respirar = () => new Promise(r => setImmediate(r));
async function candidatos(ofertas, comAfiliado) {
  const df = new Map();
  for (const [i, o] of ofertas.entries()) {
    for (const p of new Set(palavrasDe(o.produto))) df.set(p, (df.get(p) || 0) + 1);
    if (i % 2000 === 1999) await respirar();
  }
  const total = Math.max(1, ofertas.length);
  const rara = p => (df.get(p) || 0) >= 3 && (df.get(p) || 0) / total < RARA;
  const pares = new Map();
  for (const [i, o] of ofertas.entries()) {
    if (i % 2000 === 1999) await respirar();
    const ps = palavrasDe(o.produto);
    const vistos = new Set();
    for (let i = 0; i + 1 < ps.length; i++) {
      const [a, b] = [ps[i], ps[i + 1]];
      if (GENERICAS.has(a) || GENERICAS.has(b) || a === b || !(rara(a) || rara(b))) continue;
      const q = `${a} ${b}`;
      if (vistos.has(q)) continue;
      vistos.add(q);
      const c = pares.get(q) || { q, lojas: new Set(), ofertas: 0, cats: new Map(), amostra: [] };
      c.lojas.add(o.store_id);
      c.ofertas++;
      if (c.amostra.length < 15) c.amostra.push(o); // só a referência: as palavras são montadas na hora, para poucos
      if (o.categoria) c.cats.set(o.categoria, (c.cats.get(o.categoria) || 0) + 1);
      pares.set(q, c);
    }
  }
  const lista = [...pares.values()]
    .filter(c => c.lojas.size >= 2 && c.ofertas >= 3 && [...c.lojas].some(l => comAfiliado.has(l)))
    .sort((x, y) => y.lojas.size - x.lojas.size || y.ofertas - x.ofertas)
    .map(c => ({ q: c.q, lojas: [...c.lojas], ofertas: c.ofertas, amostra: c.amostra, categoria: [...c.cats].sort((a, b) => b[1] - a[1])[0]?.[0] || null }));
  lista.rara = rara; // para saber quais termos da lista são específicos (têm marca)
  return lista;
}

function ler() { try { return JSON.parse(settings.get(ESTADO) || '{}') || {}; } catch { return {}; } }
const hojeSp = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

// Aprende os termos do dia (uma vez por dia; forcar = de novo no mesmo dia). Devolve os termos que entraram.
async function aprender({ ofertas, forcar = false } = {}) {
  if (settings.get('termos_marca_aprender') === '0') return [];
  const st = ler();
  const hoje = hojeSp();
  if (st.dia === hoje && !forcar) return [];
  const porDia = Math.min(Math.max(parseInt(settings.get('termos_marca_por_dia') ?? '20', 10) || 0, 0), 300);
  const maximo = Math.min(Math.max(parseInt(settings.get('ml_chrome_termos_max') ?? '1000', 10) || 0, 0), 5000);
  const feitosHoje = st.dia === hoje ? st.hoje || 0 : 0;
  const termos = settings.getSearchTerms();
  let vagas = Math.min(porDia - feitosHoje, maximo - termos.length);
  const marcar = novos => settings.set(ESTADO, JSON.stringify({ dia: hoje, hoje: feitosHoje + novos.length, total: (st.total || 0) + novos.length,
    ultimos: [...novos, ...(st.ultimos || [])].slice(0, 50) }));
  if (vagas <= 0) { marcar([]); return []; }
  const comAfiliado = new Set(require('./clientes').lojasComAfiliado(settings.getAll()));
  if (!comAfiliado.size) { marcar([]); return []; }
  const lista = ofertas || require('./busca-ofertas').ativas();
  const existentes = termos.map(t => semAcento(t.query));
  const { termoRuim, distancia } = require('./mineracao-ml-chrome');
  const proibidas = require('./palavras-proibidas');
  const novos = [];
  // Uma categoria por vez (o melhor de cada uma, depois o 2º de cada uma...): senão o dia inteiro vira informática,
  // que é a categoria com mais produtos repetidos entre as lojas
  // (o que a lista já cobre sai antes do rodízio, para não ocupar a vez da categoria)
  const todos = await candidatos(lista, comAfiliado);
  // Termos da lista com marca (palavra rara): só esses contam como "já cobre". Genérico como "perfume" não alcança a
  // marca (era o problema), então não impede o termo novo.
  const especificos = existentes.map(e => e.split(' ')).filter(ws => ws.some(w => todos.rara(w)));
  const cobertos = c => termoRuim(c.q) || proibidas.bloqueia(c.q)
    || existentes.some(e => e === c.q || distancia(e, c.q) <= 2 || ` ${e} `.includes(` ${c.q} `)) // "afnan 9pm" ⊂ "afnan 9pm night out"
    || (c.amostra?.length && especificos.length && (() => {                                  // "out extrait": as ofertas são as de "afnan 9pm night out"
      const nomes = c.amostra.map(o => new Set(semAcento(o.produto).split(' ')));
      return especificos.some(ws => nomes.every(nome => ws.every(w => nome.has(w))));
    })());
  const porCategoria = new Map();
  for (const c of todos) {
    if (cobertos(c)) continue;
    const k = c.categoria || 'outros';
    if (!porCategoria.has(k)) porCategoria.set(k, []);
    porCategoria.get(k).push(c);
  }
  const intercalados = [];
  for (let i = 0, resto = true; resto; i++) {
    resto = false;
    for (const l of porCategoria.values()) if (l[i]) { intercalados.push(l[i]); resto = true; }
  }
  for (const c of intercalados) {
    if (vagas <= 0) break;
    // No mesmo dia, nada que divida palavra com um termo já escolhido ("jbl partybox" e "partybox encore")
    const ps = c.q.split(' ');
    if (novos.some(n => n.q.split(' ').some(p => ps.includes(p)))) continue;
    novos.push({ q: c.q, lojas: c.lojas.length, ofertas: c.ofertas, categoria: c.categoria, em: new Date().toISOString() });
    vagas--;
  }
  if (novos.length) {
    const atual = String(settings.get('search_terms') || '').replace(/\s+$/, '');
    settings.set('search_terms', `${atual}\n${novos.map(n => (n.categoria ? `${n.q} | ${n.categoria}` : n.q)).join('\n')}`);
  }
  marcar(novos.map(({ q, lojas, ofertas: n, em }) => ({ q, lojas, ofertas: n, em })));
  return novos.map(n => n.q);
}

function estado() {
  const st = ler();
  return { ligado: settings.get('termos_marca_aprender') !== '0', hoje: st.dia === hojeSp() ? st.hoje || 0 : 0, total: st.total || 0, ultimos: (st.ultimos || []).slice(0, 8) };
}

module.exports = { aprender, candidatos, estado, palavrasDe };
