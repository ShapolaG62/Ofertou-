// Painel do cliente da ferramenta (/cliente): login próprio, links de afiliado, canais e agendamento DELE.
const express = require('express');
const auth = require('../auth');
const clientes = require('../clientes');
const whatsapp = require('../whatsapp');
const agenda = require('../agenda');
const db = require('../db');
const { createLimiter } = require('../ratelimit');

const router = express.Router();
const loginLimiter = createLimiter(8, 15); // 8 tentativas por 15 min por IP
const sendError = (res, err) => res.status(err.status || 400).json({ error: err.message, ...(err.reativar ? { reativar: err.reativar } : {}) });

router.post('/api/cliente/entrar', (req, res) => {
  const wait = loginLimiter.hit(req.ip);
  if (wait) return res.status(429).json({ error: `Muitas tentativas. Tente de novo em ${wait} min.` });
  try {
    const c = clientes.login(req.body?.email, req.body?.senha);
    loginLimiter.reset(req.ip);
    clientes.criarSessao(req, res, c);
    res.json({ ok: true, cliente: clientes.publico(c) });
  } catch (err) { sendError(res, err); }
});

router.post('/api/cliente/sair', (req, res) => {
  // Sai também da conta do site, quando o acesso à ferramenta é pela conta (afiliado / Google).
  require('../users').destroySession(req, res);
  clientes.encerrarSessao(req, res); // acrescenta o próprio cookie, sem apagar o da conta
  res.json({ ok: true });
});

router.get('/api/cliente/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const c = clientes.atual(req);
  res.json({ cliente: c ? clientes.publico(c) : null, parceiro_pendente: c ? pendenteCliente(c) : [] });
});

// Termos do Afiliado (item 6-A): cliente criado pelo painel ou antes destes Termos aceita ao entrar
const pendenteCliente = c => require('../consentimento').pendentesParceiro({ dono: `c:${c.id}`, email: c.email, papeis: ['afiliado'] });

router.use('/api/cliente', clientes.exigir);

router.post('/api/cliente/aceite-parceiro', (req, res) => {
  try { res.json(require('../consentimento').aceitarParceiro({ dono: `c:${req.cliente.id}`, email: req.cliente.email, papeis: ['afiliado'], b: req.body || {}, req })); } catch (err) { sendError(res, err); }
});
// Sem o aceite, o painel não funciona (a janela de aceite aparece ao entrar)
router.use('/api/cliente', (req, res, next) => (pendenteCliente(req.cliente).length
  ? res.status(428).json({ error: 'Aceite os Termos do Afiliado para continuar usando o painel.', aceite_parceiro: true }) : next()));

router.get('/api/cliente/config', (req, res) => {
  const s = clientes.config(req.cliente.id);
  res.json({ config: clientes.configParaPainel(req.cliente.id), sem_afiliado: clientes.lojasSemAfiliado(s) });
});

router.put('/api/cliente/config', (req, res) => {
  res.json({ ok: true, alterados: clientes.salvarConfig(req.cliente.id, req.body || {}) });
});

router.post('/api/cliente/senha', (req, res) => {
  const { atual, nova } = req.body || {};
  const c = clientes.getById(req.cliente.id);
  if (!auth.verifyPassword(String(atual || ''), c.senha_hash)) return res.status(401).json({ error: 'Senha atual incorreta.' });
  try { clientes.editar(c.id, { senha: nova }); clientes.criarSessao(req, res, c); res.json({ ok: true }); } catch (err) { sendError(res, err); }
});

router.get('/api/cliente/whatsapp/status', async (req, res) => {
  res.json(await whatsapp.status(clientes.config(req.cliente.id)));
});

router.get('/api/cliente/whatsapp/grupos', async (req, res) => {
  const s = clientes.config(req.cliente.id);
  try { const { grupos, ocultos } = await whatsapp.resumoGrupos(s); const temas = require('../temas-grupos'); res.json({ grupos: temas.paraTelaGrupos(grupos, whatsapp.gruposEscolhidos(s), '/api/cliente/wa/foto/'), ocultos, temas: temas.listar(), lojas: temas.listarLojas() }); } catch (err) { sendError(res, err); }
});

// Dashboard do painel: envios no período (por dia, ok e falha), conexões, fila e cliques nos links do cliente
router.get('/api/cliente/painel', (req, res) => {
  const cid = req.cliente.id;
  const dias = [1, 7, 30].includes(Number(req.query.dias)) ? Number(req.query.dias) : 7;
  const desde = `-${dias - 1} days`;
  const porDia = db.all(`SELECT date(created_at, '-3 hours') AS dia, SUM(ok) AS ok, SUM(1 - ok) AS erro FROM social_posts
    WHERE cliente_id = ? AND date(created_at, '-3 hours') >= date('now', '-3 hours', ?) GROUP BY dia ORDER BY dia`, cid, desde);
  const mapa = Object.fromEntries(porDia.map(r => [r.dia, r]));
  const porLoja = {};
  for (const l of db.all(`SELECT date(p.created_at, '-3 hours') AS dia, COALESCE(o.store_id, 'outros') AS loja, COUNT(*) AS n
    FROM social_posts p LEFT JOIN offers o ON o.id = p.offer_id
    WHERE p.cliente_id = ? AND p.ok = 1 AND date(p.created_at, '-3 hours') >= date('now', '-3 hours', ?) GROUP BY dia, loja`, cid, desde)) {
    (porLoja[l.dia] ||= {})[l.loja] = l.n;
  }
  const serie = [];
  for (let i = dias - 1; i >= 0; i--) {
    const d = new Date(Date.now() - 3 * 3600000 - i * 86400000).toISOString().slice(0, 10);
    serie.push({ dia: d, ok: mapa[d]?.ok || 0, erro: mapa[d]?.erro || 0, lojas: porLoja[d] || {} });
  }
  const cg = require('../cliente-ganhos'); // garante a tabela de vendas
  const comissao = db.get(`SELECT COALESCE(SUM(comissao), 0) AS v FROM cliente_vendas
    WHERE cliente_id = ? AND status <> 'cancelada' AND date(data_venda) >= date('now', '-3 hours', ?)`, cid, desde).v;
  const s = clientes.config(cid);
  const dono = db.get('SELECT id FROM users WHERE cliente_id = ?', cid);
  const cliques = db.get('SELECT valor FROM metricas WHERE dono = ? AND chave = ?', dono ? `u:${dono.id}` : `c:${cid}`, 'cliques_links')?.valor || 0;
  const ultimo = db.get('SELECT MAX(created_at) AS created_at FROM social_posts WHERE cliente_id = ? AND ok = 1', cid)?.created_at || null;
  res.json({
    dias, serie,
    enviados: serie.reduce((a, d) => a + d.ok, 0), falhas: serie.reduce((a, d) => a + d.erro, 0),
    redes: require('../social').listarRedes(s),
    grupos_whatsapp: whatsapp.gruposEscolhidos(s).length, fila: agenda.pendentes(cid), agenda: agenda.estado(cid),
    cliques, comissao, saldo: cg.saldos(cid).brl, lembrete_planilha: cg.lembretePlanilha(cid).map(l => l.nome), ultimo_envio: ultimo, sem_afiliado: clientes.lojasSemAfiliado(s),
  });
});

// ── Comissão ──
router.get('/api/cliente/comissao', (req, res) => res.json(require('../cliente-ganhos').resumo(req.cliente.id, req.query.dias)));
router.post('/api/cliente/comissao/sincronizar', async (req, res) => {
  try { res.json(await require('../cliente-ganhos').sincronizar(req.cliente.id, { manual: true })); } catch (err) { sendError(res, err); }
});
router.post('/api/cliente/comissao/previa', (req, res) => {
  try { res.json(require('../cliente-ganhos').previa(req.body?.texto)); } catch (err) { sendError(res, err); }
});
router.post('/api/cliente/comissao/importar', (req, res) => {
  try { res.json(require('../cliente-ganhos').importar(req.cliente.id, req.body?.texto, req.body?.plataforma, req.body?.mapa)); } catch (err) { sendError(res, err); }
});

router.post('/api/cliente/comissao/ml-estimado', (req, res) => {
  try { res.json(require('../cliente-ganhos').salvarEstimadoMl(req.cliente.id, req.body?.valor)); } catch (err) { sendError(res, err); }
});
router.post('/api/cliente/comissao/saque', (req, res) => {
  try { res.json(require('../cliente-ganhos').registrarSaque(req.cliente.id, req.body)); } catch (err) { sendError(res, err); }
});
router.delete('/api/cliente/comissao/saque/:id', (req, res) => {
  try { res.json(require('../cliente-ganhos').excluirSaque(req.cliente.id, req.params.id)); } catch (err) { sendError(res, err); }
});

// ── O que está em alta ──
router.get('/api/cliente/populares', (req, res) => {
  const { buscados, clicados } = require('../populares').populares();
  // O link leva a comissão de quem está no painel
  res.json({ buscados, clicados: clicados.map(o => ({ ...o, link: `/ir/${req.cliente.id}-${o.id}` })) });
});

// ── Monitor de membros ──
router.get('/api/cliente/membros', (req, res) => res.json(require('../membros-grupo').resumo(req.cliente.id, req.query.dias)));
router.post('/api/cliente/membros/atualizar', async (req, res) => {
  try { res.json(await require('../membros-grupo').atualizarAgora(req.cliente.id)); } catch (err) { sendError(res, err); }
});

// ── Site do grupo (/g/<endereço>) ──
router.get('/api/cliente/site-grupo', (req, res) => {
  const cid = req.cliente.id;
  const gc = require('../grupos-convite');
  let slug = clientes.config(cid).grupo_slug;
  if (!slug) { // primeiro acesso: já deixa um endereço reservado, que a pessoa pode trocar
    const base = String(req.cliente.nome || 'grupo').toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'grupo';
    slug = `${base.length >= 3 ? base : 'grupo'}-${cid}`;
    clientes.salvarConfig(cid, { grupo_slug: slug });
  }
  const base = String(require('../settings').get('site_url') || '').trim().replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;
  res.json({ slug, endereco: `${base}/g/${slug}`, grupos: gc.resumo(cid) });
});
router.post('/api/cliente/site-grupo/zerar', (req, res) => { require('../grupos-convite').zerar(req.cliente.id); res.json({ ok: true }); });

// Sugestões para postar hoje: o mesmo critério do agendamento, com a comissão e o cupom de cada produto
router.get('/api/cliente/sugestoes', (req, res, next) => require('../busca-ofertas').aguardar(req, res, next), (req, res) => {
  const ids = agenda.melhoresOfertas(12, new Set(), req.cliente.id, clientes.config(req.cliente.id));
  const dados = new Map(require('../busca-ofertas').ativas().filter(o => ids.includes(o.id)).map(o => [o.id, o]));
  res.json({ itens: ids.map(id => dados.get(id)).filter(Boolean).map(o => ({
    id: o.id, store_id: o.store_id, plataforma: o.plataforma, produto: o.produto, preco_atual: o.preco_atual, preco_anterior: o.preco_anterior,
    desconto_pct: o.desconto_pct, cupom_texto: o.cupom_texto || null, comissao_pct: o.comissao_pct, comissao_extra_pct: o.comissao_extra_pct,
  })) });
});

router.get('/api/cliente/grupo-automacao', (req, res) => {
  const ga = require('../grupo-automacao');
  res.json({ controle: clientes.config(req.cliente.id).wa_grupo_controle || '', ajuda: ga.AJUDA });
});
// ── Repostar ofertas de outros grupos (src/repostar-grupos.js) ──
router.get('/api/cliente/repostar', (req, res) => res.json(require('../repostar-grupos').painel(req.cliente.id)));
router.get('/api/cliente/repostar/grupos', async (req, res) => {
  const proprio = require('../whatsapp-proprio');
  try {
    const todos = await proprio.carregarGrupos(proprio.donoDe(req.cliente.id), { todos: true });
    res.json({ grupos: todos.map(g => ({ id: g.id, nome: g.nome, membros: g.membros, meu: g.meu })) });
  } catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});
router.delete('/api/cliente/repostar/registro', (req, res) => res.json(require('../repostar-grupos').apagarRegistro(req.cliente.id)));
router.delete('/api/cliente/repostar/registro/:id', (req, res) => res.json(require('../repostar-grupos').apagarRegistro(req.cliente.id, req.params.id)));
router.post('/api/cliente/repostar/registro/:id/enviar', async (req, res) => {
  try { res.json(await require('../repostar-grupos').enviarDoRegistro(req.cliente.id, req.params.id)); } catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});
router.post('/api/cliente/repostar', async (req, res) => {
  try { res.json(await require('../repostar-grupos').salvar(req.cliente.id, req.body || {})); } catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});
router.get('/api/cliente/agenda', (req, res) => {
  res.json({ estado: agenda.estado(req.cliente.id), fila: agenda.listarFila(req.cliente.id) });
});

router.post('/api/cliente/agenda/executar', (req, res) => {
  if (agenda.estado(req.cliente.id).rodando) return res.status(409).json({ error: 'Já existe uma rodada em andamento.' });
  agenda.executar('manual pelo painel do cliente', req.cliente.id)
    .then(r => r?.erro && console.log('[AGENDA]', r.erro)).catch(err => console.error('[AGENDA]', err));
  res.json({ ok: true });
});

router.delete('/api/cliente/agenda/fila/:id', (req, res) => {
  agenda.removerDaFila(Number(req.params.id), req.cliente.id);
  res.json({ ok: true });
});

router.delete('/api/cliente/agenda/fila', (req, res) => {
  res.json({ ok: true, removidos: agenda.limparFila(req.cliente.id) });
});

module.exports = router;
