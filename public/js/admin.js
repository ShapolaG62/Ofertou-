// Painel administrativo (a página está em public/admin.html)
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const brl = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDate = s => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.includes('/login') && !path.includes('/password')) { showAuth(); throw new Error(data.error || 'Sessão expirada'); }
  if (!res.ok) throw Object.assign(new Error(data.error || `Erro ${res.status}`), { dados: data });
  return data;
}

function flash(el, text, ok = true) {
  el.innerHTML = `<div class="msg ${ok ? 'ok' : 'err'}">${esc(text)}</div>`;
  if (ok) setTimeout(() => { el.innerHTML = ''; }, 4000);
}
const globalMsg = (t, ok) => { flash($('#global-msg'), t, ok); window.scrollTo({ top: 0, behavior: 'smooth' }); };

// ── Autenticação ──────────────────────────────────────────────────────────────
async function boot() {
  const s = await api('/api/admin/session');
  $('#min-pass').textContent = s.minPassword;
  if (s.loggedIn) return showApp();
  showAuth(s);
}

async function showAuth(s) {
  s = s || await fetch('/api/admin/session').then(r => r.json());
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  $('#setup-box').classList.toggle('hidden', !(s.needsSetup && s.canSetup));
  $('#setup-remote').classList.toggle('hidden', !(s.needsSetup && !s.canSetup));
  $('#login-box').classList.toggle('hidden', s.needsSetup);
}

$('#setup-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  if (f.password.value !== f.confirm.value) return flash($('#auth-msg'), 'As senhas não conferem.', false);
  try { await api('/api/admin/setup', { method: 'POST', body: { password: f.password.value } }); showApp(); }
  catch (err) { flash($('#auth-msg'), err.message, false); }
});

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('/api/admin/login', { method: 'POST', body: { password: e.target.password.value, codigo: e.target.codigo.value.trim() || undefined } }); e.target.reset(); $('#login-codigo').classList.add('hidden'); showApp(); }
  catch (err) {
    flash($('#auth-msg'), err.message, false);
    if (err.dados?.precisa_codigo) { $('#login-codigo').classList.remove('hidden'); e.target.codigo.value = ''; e.target.codigo.focus(); }
  }
});

// Menu Conta: fecha ao tocar fora
document.addEventListener('click', e => { const m = $('#top-conta'); if (m?.open && !m.contains(e.target)) m.open = false; });
$('#logout').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST' }); location.reload(); });

// ── Aplicativo ────────────────────────────────────────────────────────────────
let STORE_LIST = [], CATEGORIES = [], SETTINGS = {};

async function showApp() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  STORE_LIST = await api('/api/admin/store-list');
  for (const sel of ['#manual-store', '#f-store']) {
    $(sel).insertAdjacentHTML('beforeend', STORE_LIST.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join(''));
  }
  await Promise.all([loadStores(), loadSettings()]);
  api('/api/admin/users?status=pending').then(d => setPendingBadge(d.pending)).catch(() => {});
  loadAds().catch(() => {});
  loadPedidos().catch(() => {});
  $('#manual-cat').insertAdjacentHTML('beforeend', CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join(''));
  $('#cat-list').textContent = CATEGORIES.join(', ');
  if ($('#nt-cat').options.length === 1) $('#nt-cat').insertAdjacentHTML('beforeend', CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join(''));
  const inicial = location.hash.slice(1);
  if (inicial && inicial !== 'dash' && document.querySelector(`.tab[data-tab="${inicial}"]`)) abrirAba(inicial); else loadDashboard();
}

// Cabeçalho de cada página: título, para que serve e atalhos para as seções dela
const ABAS_COM_NUMEROS = ['offers', 'mining', 'social', 'avisos', 'acessos', 'users', 'atendimento', 'clientes', 'planos', 'ganhos', 'aff', 'ads'];
const PAGINAS = {
  offers: ['Ofertas', 'Adicione ofertas à mão e gerencie as que estão no site: buscar, ocultar, editar e ver os cliques.'],
  mining: ['Mineração', 'Situação de cada loja, busca pontual e as regras da mineração automática (lojas, termos e frequência).'],
  social: ['Redes sociais', 'Postagem automática das ofertas no WhatsApp, Telegram, Facebook/Instagram e X, com fila e histórico.'],
  chatmod: ['Moderação', 'Conversas em que alguém usou xingamentos: veja o histórico com a hora de cada ocorrência e aplique advertência, bloqueio das mensagens, suspensão ou banimento.'],
  sac: ['SAC', 'Chamados do Suporte Ofertou!: assuma um chamado da fila, converse com o cliente e marque como resolvido.'],
  equipe: ['Equipe', 'Pessoas da equipe com os cargos (Proprietário, Gerente, Admin, Moderador e Suporte) e, na aba Cargos e permissões, o que cada cargo pode fazer na Área de trabalho.'],
  users: ['Usuários', 'Cadastros do site: aprove empresas, modere contas e configure o login com Google.'],
  atendimento: ['Lojas e pedidos', 'Empresas parceiras, o Mercado Pago das lojas, pedidos feitos pelo site e as conversas de atendimento.'],
  clientes: ['Clientes', 'Quem comprou acesso à ferramenta de afiliados: validade, bloqueio e links.'],
  planos: ['Planos', 'Planos à venda, pedidos de assinatura, formas de recebimento (Mercado Pago), app e e-mail de confirmação.'],
  ganhos: ['Ganhos', 'Comissões das plataformas, vendas importadas, saques e avisos de saldo para sacar.'],
  aff: ['Links de afiliado', 'Suas tags e credenciais de afiliado de cada loja. Ao salvar, todos os links das ofertas são atualizados.'],
  ads: ['Publicidade', 'Google AdSense, campanhas de anunciantes e pedidos de empresas que querem anunciar.'],
  avisos: ['Avisos na entrada', 'Mensagens que aparecem ao abrir o site: quem vê, em que período e quantas vezes.'],
  acessos: ['Acessos suspeitos', 'Contas usadas em lugares distantes em pouco tempo e consulta de localização por IP.'],
  membros: ['Membros dos grupos', 'Quantas pessoas entraram e saíram dos seus grupos de envio.'],
  site: ['Site', 'Links das redes sociais, Google Analytics e os dados do responsável pelo site (LGPD).'],
  account: ['Senha e backup', 'Senha do painel, login em duas etapas e backup do banco de dados.'],
};
for (const [aba, [titulo, desc]] of Object.entries(PAGINAS)) {
  const corpo = document.querySelector(`.tab-body[data-body="${aba}"]`);
  if (!corpo) continue;
  corpo.insertAdjacentHTML('afterbegin', `<header class="page-head"><h1>${titulo}</h1><p>${desc}</p></header>${ABAS_COM_NUMEROS.includes(aba) ? `<div class="db-kpis aba-kpis" id="kpis-${aba}" hidden></div>` : ''}`);
}
// ── Login em duas etapas ──
let F2 = { ativo: false };
async function f2Carregar() {
  F2 = await api('/api/admin/2fa');
  $('#f2-status').innerHTML = F2.ativo
    ? `<b style="color:var(--green)">Ligado.</b> O login pede a senha e o código do app. ${F2.codigos_restantes} código(s) de recuperação restante(s).`
    : 'Desligado. Com ele ligado, quem descobrir a sua senha ainda não consegue entrar no painel.';
  $('#f2-botao').textContent = F2.ativo ? 'Desligar' : 'Ativar';
  $('#f2-botao').className = `btn ${F2.ativo ? 'danger' : 'primary'}`;
  $('#f2-codigo-campo').classList.toggle('hidden', !F2.ativo);
  $('#f2-form').codigo.required = F2.ativo;
}
document.querySelector('.tab[data-tab="account"]')?.addEventListener('click', () => f2Carregar().catch(() => {}));
$('#f2-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  try {
    if (F2.ativo) {
      await api('/api/admin/2fa/desligar', { method: 'POST', body: { senha: f.senha.value, codigo: f.codigo.value.trim() } });
      globalMsg('Login em duas etapas desligado.');
    } else {
      const d = await api('/api/admin/2fa/iniciar', { method: 'POST', body: { senha: f.senha.value } });
      $('#f2-qr-img').innerHTML = d.qr;
      $('#f2-chave').textContent = d.segredo;
      $('#f2-qr').classList.remove('hidden');
      $('#f2-codigos').classList.add('hidden');
      $('#f2-confirma').codigo.focus();
    }
    f.reset();
    await f2Carregar();
  } catch (err) { globalMsg(err.message, false); }
});
$('#f2-confirma').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const d = await api('/api/admin/2fa/confirmar', { method: 'POST', body: { codigo: e.target.codigo.value.trim() } });
    e.target.reset();
    $('#f2-qr').classList.add('hidden');
    $('#f2-qr-img').innerHTML = ''; $('#f2-chave').textContent = '';
    $('#f2-lista').textContent = d.codigos.join('\n');
    $('#f2-codigos').classList.remove('hidden');
    globalMsg('Login em duas etapas ligado.');
    await f2Carregar();
  } catch (err) { globalMsg(err.message, false); }
});
$('#f2-copiar').addEventListener('click', () => navigator.clipboard?.writeText($('#f2-lista').textContent).then(() => globalMsg('Códigos copiados.')));

// ── Backup do banco ──
async function bkCarregar() {
  const b = await api('/api/admin/backups');
  const f = $('#bk-form');
  if (document.activeElement?.form !== f) { f.backup_pasta_externa.value = b.pasta_externa || ''; f.backup_dias.value = b.dias; }
  const mb = n => `${(n / 1048576).toFixed(1).replace('.', ',')} MB`;
  $('#bk-status').innerHTML = b.rodando ? 'Fazendo backup agora…'
    : b.erro ? `<span style="color:var(--yellow)">O último backup falhou: ${esc(b.erro.mensagem)}</span>`
    : b.ultimo ? `Último backup: <b>${esc(new Date(b.ultimo.em).toLocaleString('pt-BR'))}</b> · ${mb(b.ultimo.tamanho)}${b.pasta_externa ? ' · também vai para a pasta externa' : ' · <span style="color:var(--yellow)">só neste servidor</span>'}${b.atrasado ? ' · <span style="color:var(--yellow)">atrasado</span>' : ''}`
    : 'Nenhum backup ainda: o primeiro sai de madrugada, ou toque em "Fazer backup agora".';
  $('#bk-lista').innerHTML = b.lista.map(a => `<tr><td>${esc(a.nome)}</td><td>${mb(a.tamanho)}</td><td>${esc(new Date(a.em).toLocaleString('pt-BR'))}</td>
    <td><a class="btn small" href="/api/admin/backups/${encodeURIComponent(a.nome)}" download>Baixar</a></td></tr>`).join('') || '<tr><td colspan="4" class="hint">Nenhum backup ainda.</td></tr>';
}
document.querySelector('.tab[data-tab="account"]')?.addEventListener('click', () => bkCarregar().catch(() => {}));
$('#bk-agora').addEventListener('click', async e => {
  const b = e.target; b.disabled = true; b.textContent = 'Fazendo backup…';
  try { const r = await api('/api/admin/backups', { method: 'POST' }); globalMsg(r.ok ? `Backup feito em ${r.segundos} s (${r.ofertas.toLocaleString('pt-BR')} ofertas).` : r.motivo, r.ok); }
  catch (err) { globalMsg(err.message, false); }
  b.disabled = false; b.textContent = '💾 Fazer backup agora';
  bkCarregar().catch(() => {});
});
$('#bk-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  try { await api('/api/admin/settings', { method: 'PUT', body: { backup_pasta_externa: f.backup_pasta_externa.value, backup_dias: f.backup_dias.value } }); globalMsg('Salvo.'); bkCarregar().catch(() => {}); }
  catch (err) { globalMsg(err.message, false); }
});

function abrirAba(aba) {
  const t = document.querySelector(`.tab[data-tab="${aba}"]`); if (t) t.click(); }

// Botão Voltar do painel: volta para a aba anterior; no Painel inicial (sem aba anterior), volta ao site
const ABAS_ANTES = []; let voltandoAba = false;
$('#painel-voltar').addEventListener('click', () => {
  const atual = document.querySelector('.tab.active')?.dataset.tab;
  let ant; while ((ant = ABAS_ANTES.pop()) && ant === atual);
  if (ant) { voltandoAba = true; abrirAba(ant); voltandoAba = false; return; }
  if (atual && atual !== 'dash') { voltandoAba = true; abrirAba('dash'); voltandoAba = false; return; }
  try {
    const r = document.referrer && new URL(document.referrer);
    if (r && r.origin === location.origin && !r.pathname.startsWith('/admin')) { history.back(); return; }
  } catch { /* vai para o site */ }
  location.href = '/';
});
$$('.tab').forEach(t => t.addEventListener('click', () => {
  const antes = document.querySelector('.tab.active')?.dataset.tab;
  if (!voltandoAba && antes && antes !== t.dataset.tab) { ABAS_ANTES.push(antes); if (ABAS_ANTES.length > 30) ABAS_ANTES.shift(); }
  $$('.tab').forEach(x => x.classList.toggle('active', x === t));
  $$('.tab-body').forEach(b => b.classList.toggle('hidden', b.dataset.body !== t.dataset.tab));
  if (location.hash.slice(1) !== t.dataset.tab) history.replaceState(null, '', `#${t.dataset.tab}`);
  if (t.closest('.side') && matchMedia('(max-width: 900px)').matches) t.scrollIntoView({ inline: 'center', block: 'nearest' });
  window.scrollTo({ top: 0 });
  if (t.dataset.tab === 'offers') loadOffers();
  if (t.dataset.tab === 'sac' && !$('#sac-quadro').src) $('#sac-quadro').src = '/sac?embed=1';
  if (t.dataset.tab === 'chatmod' && !$('#mod-quadro').src) $('#mod-quadro').src = '/moderacao?embed=1';
  if (t.dataset.tab === 'dash') loadDashboard();
  mostrarNumerosAba(t.dataset.tab);
  if (t.dataset.tab === 'mining') loadStores();
  if (t.dataset.tab === 'equipe' && !$('#eq-quadro').src) $('#eq-quadro').src = '/equipe?embed=1';
  if (t.dataset.tab === 'users') { loadUsers(); loadModLog(); }
  if (t.dataset.tab === 'ads') loadAds();
  if (t.dataset.tab === 'acessos') {
    loadAcessosBase().catch(() => {}); $('#ac-form').requestSubmit();
    api('/api/admin/acessos/visto', { method: 'POST' }).then(() => $('#acessos-badge').classList.add('hidden')).catch(() => {});
  }
  if (t.dataset.tab === 'avisos') loadAvisos().catch(e => globalMsg(e.message, false));
  if (t.dataset.tab === 'social') { loadSocialLog(); loadAwa(); }
  if (t.dataset.tab === 'clientes') loadClientes();
  if (t.dataset.tab === 'membros') loadMembros().catch(e => globalMsg(e.message, false));
  if (t.dataset.tab === 'ganhos') loadGanhos();
  if (t.dataset.tab === 'atendimento') loadAtendimento().catch(e => globalMsg(e.message, false));
  if (t.dataset.tab === 'planos') { loadPlanos().then(loadPedidos).catch(e => globalMsg(e.message, false)); $('#rc-webhook-url').textContent = `${location.origin}/api/app/webhook/revenuecat`; }
}));

const semAcentoP = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
// ── Seções que abrem e fecham: o trabalho do dia fica aberto, as configurações recolhidas ────
// Títulos abertos da primeira vez; a escolha de cada pessoa fica guardada neste navegador
const DOBRA_ABERTAS = ['Extensão do Chrome', 'Palavras proibidas na mineração','Ofertas cadastradas', 'Links de afiliado', 'Situação das lojas', 'Busca pontual', 'Usuários', 'Pedidos de assinatura', 'Planos à venda',
  'Saldo por plataforma', 'Vendas registradas', 'Buscar ticket', 'Pedidos às lojas', 'Clientes da ferramenta', 'Postagens agendadas',
  'Histórico de postagens', 'Campanhas de anunciantes', 'Pedidos de empresas', 'Varredura de IP', 'Avisos', 'Backup do banco de dados', 'Trocar senha'];
const DOBRA_CHAVE = 'ofertou-painel-dobras';
const dobraLer = () => { try { return JSON.parse(localStorage.getItem(DOBRA_CHAVE)) || {}; } catch { return {}; } };
function dobraDefinir(painel, aberto, guardar = true) {
  painel.classList.toggle('fechado', !aberto);
  const h2 = painel.querySelector(':scope > .dobra-cab h2, :scope > h2.dobra-cab');
  h2?.setAttribute('aria-expanded', String(aberto));
  if (guardar && h2) { const m = dobraLer(); m[painel.dataset.dobra] = aberto; try { localStorage.setItem(DOBRA_CHAVE, JSON.stringify(m)); } catch { /* sem armazenamento */ } }
}
function dobraMontar() {
  const salvas = dobraLer();
  document.querySelectorAll('.tab-body:not([data-body="dash"])').forEach(corpo => {
    const paineis = [...corpo.querySelectorAll('.panel')].filter(p => !p.parentElement.closest('.panel') && !p.hasAttribute('hidden') && !p.classList.contains('hidden'));
    if (paineis.length < 2) return; // seção única: fica sempre aberta
    for (const p of paineis) {
      const cab = [...p.children].find(c => c.matches('h2') || c.querySelector(':scope > h2, :scope > div > h2'));
      const h2 = cab && (cab.matches('h2') ? cab : cab.querySelector('h2'));
      if (!h2) continue;
      const titulo = h2.textContent.trim();
      p.classList.add('dobra');
      p.dataset.dobra = `${corpo.dataset.body}:${titulo}`;
      cab.classList.add('dobra-cab');
      h2.classList.add('dobra-tit');
      h2.setAttribute('role', 'button');
      h2.tabIndex = 0;
      const alternar = () => dobraDefinir(p, p.classList.contains('fechado'));
      h2.addEventListener('click', alternar);
      h2.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); alternar(); } });
      dobraDefinir(p, p.dataset.dobra in salvas ? salvas[p.dataset.dobra] : DOBRA_ABERTAS.includes(titulo), false);
    }
    // Nenhuma aberta na lista e nada escolhido antes: abre a primeira, para a aba não parecer vazia
    const dobras = paineis.filter(p => p.classList.contains('dobra'));
    if (dobras.length && dobras.every(p => p.classList.contains('fechado') && !(p.dataset.dobra in salvas))) dobraDefinir(dobras[0], true, false);
  });
}
dobraMontar();
// Abre a seção cujo título contém o texto (atalhos da tela inicial e busca do menu)
function dobraAbrir(aba, texto) {
  const q = semAcentoP(texto);
  const p = [...document.querySelectorAll(`.tab-body[data-body="${aba}"] .panel.dobra`)].find(x => semAcentoP(x.querySelector('h2')?.textContent).includes(q));
  if (p) { dobraDefinir(p, true, false); p.scrollIntoView({ block: 'start' }); window.scrollBy(0, -70); }
}
// Quando o painel leva a um campo dentro de uma seção fechada, a seção abre primeiro
const rolarOriginal = Element.prototype.scrollIntoView;
Element.prototype.scrollIntoView = function (...a) {
  const fechado = this.closest?.('.panel.fechado');
  if (fechado) dobraDefinir(fechado, true, false);
  return rolarOriginal.apply(this, a);
};

// ── Dashboard (aba Painel) ────────────────────────────────────────────────────
const DB_ICO = {
  ofertas: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="8" cy="8" r="1.5"/>',
  clique: '<path d="M9 3v3M3 9h3M4.8 4.8l2.1 2.1M12 12l8 3-3.5 1.5L15 20z"/>',
  pessoas: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  dinheiro: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/>',
  sacola: '<path d="M5 8h14l-1 12H6z"/><path d="M9 8a3 3 0 0 1 6 0"/>',
  alerta: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17v.5"/>',
  ok: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.6 2.6L16 9.5"/>',
  seta: '<path d="M9 6l6 6-6 6"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>',
  sino: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
};
const dbIco = n => `<svg class="tab-ico" viewBox="0 0 24 24" aria-hidden="true">${DB_ICO[n]}</svg>`;
const dbNum = v => Number(v || 0).toLocaleString('pt-BR');
const dbVar = v => (v === null || v === undefined ? '<span class="db-var">novo</span>'
  : `<span class="db-var ${v > 0 ? 'sobe' : v < 0 ? 'desce' : ''}">${v > 0 ? '▲' : v < 0 ? '▼' : '='} ${Math.abs(v)}%</span>`);
const dbDia = d => new Date(d + 'T12:00:00Z').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
const DB_SERIES = { cliques: ['Cliques', dbNum], ofertas: ['Ofertas novas', dbNum], cadastros: ['Cadastros', dbNum], receita: ['Receita', brl] };
let DASH = null;

function dbGrafico(serie, chave, W = 700, H = 210) {
  const Pe = 34, Pd = 8, Pt = 22, Pb = 24, n = serie.length, bw = (W - Pe - Pd) / n, [nome, fmt] = DB_SERIES[chave];
  const max = Math.max(1, ...serie.map(d => d[chave]));
  const barras = serie.map((d, i) => {
    const h = Math.max(d[chave] ? 3 : 0, (d[chave] / max) * (H - Pt - Pb));
    return `<rect x="${(Pe + i * bw + 1).toFixed(1)}" y="${(H - Pb - h).toFixed(1)}" width="${Math.max(2, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="3"><title>${dbDia(d.dia)}: ${esc(fmt(d[chave]))} — ${nome.toLowerCase()}</title></rect>`;
  }).join('');
  const passo = bw < 18 ? 5 : bw < 30 ? 3 : 2;
  const rot = serie.map((d, i) => ((n - 1 - i) % passo === 0 ? `<text x="${(Pe + i * bw + bw / 2).toFixed(1)}" y="${H - 7}">${dbDia(d.dia)}</text>` : '')).join('');
  const meio = Pt + (H - Pt - Pb) / 2;
  return `<svg class="db-graf" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${nome} nos últimos 30 dias">
    <line x1="${Pe}" x2="${W - Pd}" y1="${Pt}" y2="${Pt}" class="grade"/><line x1="${Pe}" x2="${W - Pd}" y1="${meio}" y2="${meio}" class="grade"/>
    <text x="${Pe}" y="${Pt - 7}" class="topo">${esc(fmt(max))}</text>${barras}${rot}</svg>`;
}
let dbSerieAtual = 'cliques';
function dbDesenharGrafico() {
  const g = $('#db-graf');
  if (!g || !DASH) return;
  g.innerHTML = '';
  g.innerHTML = dbGrafico(DASH.serie, dbSerieAtual, Math.max(280, g.clientWidth), Math.max(180, g.clientHeight));
}
window.addEventListener('resize', () => { clearTimeout(dbDesenharGrafico.t); dbDesenharGrafico.t = setTimeout(dbDesenharGrafico, 150); });
// Quanto tempo faz que o resumo foi lido
let dbLidoEm = 0;
const dbTextoLido = () => { const m = Math.floor((Date.now() - dbLidoEm) / 60000); return m < 1 ? 'atualizado agora' : `atualizado há ${m} min`; };
setInterval(() => { const e = $('#db-lido'); if (e) e.textContent = dbTextoLido(); }, 30000);

// Cores dos gráficos: sempre na mesma ordem (conferidas nos temas claro e escuro)
const DB_CORES = ['#0d9255', '#1f77d0', '#c9700f', '#8a5cd6', '#d9486a', '#0fa3b1'];
const DB_OUTROS = '#8a9a91';
const dbPct = (v, t) => `${t ? Math.round((v / t) * 100) : 0}%`;
// Rosca com a lista ao lado. A cor segue o item (ordemFixa), não a posição; depois da 6ª cor, vira "Outros"
function dbRosca(l, nome, ordemFixa) {
  const total = l.reduce((s, x) => s + x.n, 0);
  if (!total) return '<p class="hint">Ainda sem cliques nesta semana.</p>';
  const ordem = ordemFixa.filter(k => l.some(x => x.k === k));
  const fatias = [];
  for (const x of l) {
    const i = ordem.indexOf(x.k);
    if (i >= 0 && i < DB_CORES.length) fatias.push({ ...x, nome: nome(x), cor: DB_CORES[ordemFixa.indexOf(x.k) % DB_CORES.length] });
    else { const o = fatias.find(f => f.outros); if (o) o.n += x.n; else fatias.push({ k: 'outros', outros: true, n: x.n, nome: 'Outros', cor: DB_OUTROS }); }
  }
  const R = 42, C = 2 * Math.PI * R;
  let ini = 0;
  const arcos = fatias.map(f => {
    const tam = (f.n / total) * C, gap = fatias.length > 1 ? 2 : 0;
    const s = `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${f.cor}" stroke-width="16" stroke-dasharray="${Math.max(1, tam - gap).toFixed(2)} ${(C - Math.max(1, tam - gap)).toFixed(2)}" stroke-dashoffset="${(-ini).toFixed(2)}"><title>${esc(f.nome)}: ${f.n.toLocaleString('pt-BR')} (${dbPct(f.n, total)})</title></circle>`;
    ini += tam;
    return s;
  }).join('');
  return `<div class="dp-rosca"><svg viewBox="0 0 120 120" role="img" aria-label="Divisão de ${total} cliques"><g transform="rotate(-90 60 60)">${arcos}</g><text x="60" y="58" class="t1">${total.toLocaleString('pt-BR')}</text><text x="60" y="73" class="t2">cliques</text></svg>
    <ul class="dp-legenda">${fatias.map(f => `<li><i style="background:${f.cor}"></i><span title="${esc(f.nome)}">${esc(f.nome)}</span><b>${f.n.toLocaleString('pt-BR')}</b><small>${dbPct(f.n, total)}</small></li>`).join('')}</ul></div>`;
}
// Barras na horizontal: um assunto só, uma cor, com o total e a porcentagem de cada linha
function dbBarras(l, nome) {
  const total = l.reduce((s, x) => s + x.n, 0), max = Math.max(1, ...l.map(x => x.n));
  if (!total) return '<p class="hint">Ainda sem cliques nesta semana.</p>';
  return `<div class="dp-barras">${l.map(x => `<div title="${esc(nome(x))}: ${x.n.toLocaleString('pt-BR')} (${dbPct(x.n, total)})"><span>${esc(nome(x))}</span><i><u style="width:${(x.n / max) * 100}%"></u></i><b>${x.n.toLocaleString('pt-BR')}</b><small>${dbPct(x.n, total)}</small></div>`).join('')}</div>`;
}

// Resumo: o que dá resultado (cliques da última semana e o que as pessoas buscam)
let dpAba = 'cliques';
function mostrarDesempenho(s) {
  const el = $('#dash-desempenho');
  if (!s) { el.innerHTML = ''; return; }
  const loja = id => STORE_LIST.find(x => x.id === id)?.name || id;
  const cat = c => CATEGORIES_NOMES[c] || c;
  const reais = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const ORDEM_LOJAS = ['shopee', 'mercadolivre', 'amazon', 'magalu', 'aliexpress', 'kabum'];
  const blocos = dpAba === 'buscas' ? `
    <div class="dp-tres">
      <div class="panel"><h2>Mais pesquisados</h2><ol class="dp-rank">${s.buscas.mais.map((b, i) => `<li><a href="/?q=${encodeURIComponent(b.termo)}" target="_blank" rel="noopener"><i>${i + 1}</i><span>${esc(b.termo)}</span><small>${b.vezes} buscas</small></a></li>`).join('') || '<li class="hint">Nenhuma busca registrada ainda.</li>'}</ol></div>
      <div class="panel"><h2>Buscam e não acham</h2><ul class="dp-lista dp-rola">${s.buscas.sem.slice(0, 30).map(b => `<li><span>${esc(b.termo)} (${b.vezes}x)</span><button class="btn small" type="button" data-minerar="${esc(b.termo)}">Minerar</button></li>`).join('') || '<li class="hint">Nenhuma até agora.</li>'}</ul></div>
      <div class="panel"><h2>Acrescentados pela busca</h2><ul class="dp-lista dp-rola">${(s.termos_auto || []).map(t => `<li><span>${esc(t.termo)}</span><b>${t.gravadas} ofertas</b></li>`).join('') || '<li class="hint">Nenhum ainda.</li>'}</ul></div>
    </div>` : `
    <div class="dp-tres">
      <div class="panel"><h2>Por loja</h2>${dbRosca(s.cliques.por_loja.map(x => ({ ...x, k: x.store_id })), x => loja(x.k), ORDEM_LOJAS)}</div>
      <div class="panel"><h2>Por categoria</h2>${dbBarras(s.cliques.por_categoria, x => cat(x.categoria))}</div>
      <div class="panel"><h2>Por origem</h2>${dbRosca((s.origens || []).map(x => ({ ...x, k: x.origem })), x => ORIGENS[x.k] || x.k, Object.keys(ORIGENS))}</div>
    </div>
    <div class="panel dp-top"><h2>Ofertas mais clicadas</h2>
      <ol class="dp-rank">${s.cliques.top.map((o, i) => `<li><a href="/oferta/${Number(o.id)}" target="_blank" rel="noopener" title="${esc(o.produto)}"><i>${i + 1}</i><img class="dp-foto" src="/img/o/${Number(o.id)}.jpg" alt="" width="40" height="40" loading="lazy" onerror="this.style.visibility='hidden'"><span>${esc(o.produto)}</span><em>${lojaLogo(o.store_id, loja(o.store_id))}</em><b>${reais(o.preco_atual)}</b><small>${o.link_clicks.toLocaleString('pt-BR')} cliques</small></a></li>`).join('') || '<li class="hint">Nenhum clique ainda.</li>'}</ol>
    </div>`;
  const totalErros = (s.erros || []).reduce((t, x) => t + x.vezes, 0);
  el.innerHTML = `<div class="dp-cab"><h2>Desempenho da semana</h2>
      <div class="db-seg" role="tablist"><button type="button" data-dp="cliques" aria-selected="${dpAba !== 'buscas'}">Cliques</button><button type="button" data-dp="buscas" aria-selected="${dpAba === 'buscas'}">Buscas</button></div></div>
    ${blocos}
    ${s.erros?.length ? `<details class="db-console" id="db-console">
      <summary><i class="db-nivel critico"></i><b>Erros do servidor nas últimas 24 h</b><span>Ocorrências: ${totalErros.toLocaleString('pt-BR')}</span><button class="btn small" type="button" id="db-resolver">Marcar como resolvido</button></summary>
      <ul>${s.erros.map(x => `<li><code>${esc(x.rota || 'servidor')}</code><span>${esc(x.mensagem)}</span><small>${x.vezes}× · última às ${fmtDate(x.ultima)}</small></li>`).join('')}</ul>
    </details>` : ''}`;
}
const ORIGENS = { postagem: 'Postagens (grupos e redes)', site: 'Navegando no site', busca_site: 'Busca do site', pagina_categoria: 'Páginas de categoria', buscador: 'Google e buscadores', rede_social: 'Redes sociais', outro_site: 'Outros sites', direto: 'Acesso direto' };
const CATEGORIES_NOMES = { informatica: 'Informática', celulares: 'Celulares', games: 'Games', audio_tv: 'TV e áudio', eletrodomesticos: 'Eletrodomésticos', cozinha: 'Cozinha', casa: 'Casa', ferramentas: 'Ferramentas', beleza: 'Beleza', saude: 'Saúde', esporte: 'Esporte', moda: 'Moda', brinquedos: 'Brinquedos', automotivo: 'Automotivo', pets: 'Pets', limpeza: 'Limpeza', alimentos: 'Alimentos', outros: 'Outros' };
$('#dash-desempenho').addEventListener('click', async e => {
  const aba = e.target.closest('[data-dp]');
  if (aba) { dpAba = aba.dataset.dp; return mostrarDesempenho(DASH?.saude); }
  if (e.target.closest('#db-resolver')) {
    e.preventDefault();
    try { await api('/api/admin/erros/resolver', { method: 'POST' }); await loadDashboard(); } catch (err) { globalMsg(err.message, false); }
    return;
  }
  const b = e.target.closest('[data-minerar]');
  if (!b) return;
  b.disabled = true; b.textContent = 'Minerando…';
  try {
    const r = await api('/api/admin/mine', { method: 'POST', body: { query: b.dataset.minerar } });
    const g = (r.results || []).reduce((s, x) => s + (x.saved || 0), 0);
    b.textContent = `${g} gravadas`;
  } catch (err) { b.disabled = false; b.textContent = 'Minerar'; globalMsg(err.message, false); }
});

// Descontos suspeitos (aba Ofertas)
async function suspCarregar() {
  const d = await api('/api/admin/offers/suspeitas');
  $('#susp-n').textContent = `${d.total.toLocaleString('pt-BR')} no ar`;
  $('#susp-lista').innerHTML = d.itens.map(o => `<tr data-id="${o.id}"><td><a href="/oferta/${o.id}" target="_blank" rel="noopener">${esc(o.produto.slice(0, 70))}</a><br><span class="hint" style="margin:0">${esc(o.plataforma)}</span></td>
    <td>R$ ${Number(o.preco_atual).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}<br><span class="hint" style="margin:0">-${Math.round(o.desconto_pct)}%</span></td><td>${esc(o.motivo)}</td>
    <td><button class="btn small" type="button" data-ocultar="${o.id}">Ocultar</button></td></tr>`).join('') || '<tr><td colspan="4" class="hint">Nenhuma no momento.</td></tr>';
}
document.querySelector('.tab[data-tab="offers"]')?.addEventListener('click', () => suspCarregar().catch(() => {}));
$('#susp-lista').addEventListener('click', async e => {
  const b = e.target.closest('[data-ocultar]');
  if (!b) return;
  b.disabled = true;
  try { await api(`/api/admin/offers/${b.dataset.ocultar}`, { method: 'PATCH', body: { oculto: true } }); b.closest('tr').remove(); }
  catch (err) { b.disabled = false; globalMsg(err.message, false); }
});

// Buscar no painel: encontra a aba pelo nome ou por um título dentro dela (ex.: "backup", "cupons", "kabum"); Enter abre a primeira
const ABAS_TEXTO = () => [...document.querySelectorAll('.side .tab')].map(t => {
  const corpo = document.querySelector(`.tab-body[data-body="${t.dataset.tab}"]`);
  const titulos = corpo ? [...corpo.querySelectorAll('h2, h3, h4, label.field')].map(x => x.textContent).join(' ') : '';
  return { t, texto: semAcentoP(`${t.textContent} ${titulos}`) };
});
let ABAS_IDX = null;
$('#painel-busca').addEventListener('input', e => {
  ABAS_IDX ||= ABAS_TEXTO();
  const q = semAcentoP(e.target.value.trim());
  let n = 0;
  for (const { t, texto } of ABAS_IDX) { const ok = !q || texto.includes(q); t.style.display = ok ? '' : 'none'; if (ok) n++; }
  document.querySelectorAll('.side .side-grupo').forEach(g => { g.style.display = q ? 'none' : ''; });
  e.target.classList.toggle('sem-resultado', Boolean(q) && !n);
});
$('#painel-busca').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const alvo = [...document.querySelectorAll('.side .tab')].find(t => t.style.display !== 'none');
  alvo?.click();
  if (alvo && e.target.value.trim()) dobraAbrir(alvo.dataset.tab, e.target.value.trim());
});

async function loadDashboard() {
  const el = $('#dash-root');
  try { DASH = await api('/api/admin/dashboard'); }
  catch (err) { el.innerHTML = `<div class="panel"><div class="msg err">${esc(err.message)}</div></div>`; return; }
  const d = DASH, k = d.kpis, p = d.pendencias, m = d.mineracao;
  $('#sac-badge').textContent = p.sac_fila; $('#sac-badge').classList.toggle('hidden', !p.sac_fila);
  $('#chatmod-badge').textContent = p.xingamentos; $('#chatmod-badge').classList.toggle('hidden', !p.xingamentos);
  $('#acessos-badge').textContent = p.acessos_suspeitos || 0; $('#acessos-badge').classList.toggle('hidden', !p.acessos_suspeitos);
    const serie0 = Object.keys(DB_SERIES).find(c => d.serie.some(x => x[c])) || 'cliques'; // abre numa série com dados
  // O que precisa de atenção (cada item abre a página certa)
  const acoes = [];
  const add = (n, txt, aba, nivel, acao, secao = '', erros = false) => { if (n) acoes.push({ txt, aba, nivel, acao, secao, erros }); };
  add(p.cartao_sem_chave, '<b>Cartões salvos desligados:</b> cole a Public Key do Mercado Pago em Formas de recebimento', 'planos', 'atencao', 'Configurar', 'Formas de recebimento');
  add(p.sac_fila, `<b>${p.sac_fila} chamado(s) no SAC</b> esperando atendimento`, 'sac', 'atencao', 'Atender');
  add(p.xingamentos, `<b>${p.xingamentos} conversa(s) com xingamentos</b> para revisar`, 'chatmod', 'atencao', 'Revisar');
  add(p.acessos_suspeitos, `<b>${p.acessos_suspeitos} conta(s) acessada(s) de lugares distantes</b> em pouco tempo (últimas 24 h)`, 'acessos', 'critico', 'Ver acessos');
  add(p.cadastros, `<b>${p.cadastros} cadastro(s) de empresa</b> esperando aprovação`, 'users', 'atencao', 'Aprovar');
  add(p.assinaturas, `<b>${p.assinaturas} pedido(s) de assinatura</b> para confirmar o pagamento`, 'planos', 'atencao', 'Confirmar');
  add(p.leads, `<b>${p.leads} empresa(s)</b> querem anunciar no site`, 'ads', 'info', 'Ver pedidos');
  add(p.avisos, `<b>${p.avisos} aviso(s)</b> de saldo de afiliado`, 'ganhos', 'info', 'Ver saldo');
  add(m.problemas.length, `<b>${m.problemas.length} loja(s) com problema</b> na mineração: ${esc(m.problemas.map(x => x.nome).join(', '))}`, 'mining',
    m.problemas.some(x => ['blocked', 'error'].includes(x.status)) ? 'critico' : 'atencao', 'Ver mineração');
  add(p.postagens_erro, `<b>${p.postagens_erro} postagem(ns)</b> com erro nos últimos 3 dias`, 'social', 'atencao', 'Ver postagens');
  add(p.clientes_vencendo, `<b>${p.clientes_vencendo} cliente(s) da ferramenta</b> vencem em até 5 dias`, 'clientes', 'info', 'Ver clientes');
  for (const a of d.saude?.alertas || []) {
    if (a.aba === 'aff') add(1, a.texto, a.aba, 'atencao', 'Inserir link');
    else if (a.aba === 'dash') add(1, a.texto.replace(': veja a lista no fim do resumo', ''), 'dash', 'critico', 'Ver erros', '', true);
    else if (a.aba === 'account') add(1, a.texto, a.aba, /falhou/i.test(a.texto) ? 'critico' : a.forte ? 'atencao' : 'info', a.forte ? 'Ver backup' : 'Escolher pasta', 'Backup');
    else add(1, a.texto, a.aba, a.forte ? 'critico' : 'atencao', 'Ver mineração');
  }
  const PESO = { critico: 0, atencao: 1, info: 2 };
  acoes.sort((a, b) => PESO[a.nivel] - PESO[b.nivel]);
  const criticos = acoes.filter(a => a.nivel === 'critico').length;
  const NOME_NIVEL = { critico: 'Crítico', atencao: 'Atenção', info: 'Informativo' };
  dbSerieAtual = serie0;
  dbLidoEm = Date.now();
  mostrarDesempenho(d.saude);
  const kpi = (aba, ico, rot, val, sub) => `<button class="db-kpi" type="button" data-db-ir="${aba}"><span>${rot}</span><i class="db-kpi-ico">${dbIco(ico)}</i><b>${val}</b><small>${sub}</small></button>`;
  const statusPedido = { pago: 'Pago', enviado: 'Enviado', concluido: 'Concluído', cancelado: 'Cancelado' };
  const statusPag = { pendente: 'Aguardando', aprovado: 'Aprovado', recusado: 'Recusado', cancelado: 'Cancelado', expirado: 'Expirado' };
  const tipo = { empresa: 'Empresa', consumidor: 'Consumidor', afiliado: 'Ferramenta' };
  const usd = k.receita.afiliados_usd ? ` + US$ ${k.receita.afiliados_usd.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : '';
  const cab = (titulo, aba, botao) => `<div class="db-cab"><h2>${titulo}</h2><button class="btn small" type="button" data-db-ir="${aba}">${botao}</button></div>`;
  // Dinheiro: o saldo em destaque; as linhas zeradas ficam recolhidas
  const linhas = [
    [`Assinaturas (${dbNum(k.receita.assinaturas_n)})`, k.receita.assinaturas, brl(k.receita.assinaturas)],
    ['Taxa do site sobre pedidos', k.receita.taxa_pedidos, brl(k.receita.taxa_pedidos)],
    [`Comissões de afiliado (${dbNum(k.receita.afiliados_n)})`, k.receita.afiliados + (k.receita.afiliados_usd || 0), `${brl(k.receita.afiliados)}${usd}`],
    ['Afiliados: a liberar', k.afiliados.a_liberar, brl(k.afiliados.a_liberar)],
    [`Vendido pelas lojas (${dbNum(k.pedidos.n)})`, k.pedidos.valor, brl(k.pedidos.valor)],
  ];
  const linha = ([a, , c]) => `<div><dt>${a}</dt><dd>${c}</dd></div>`;
  const comValor = linhas.filter(l => l[1] > 0), zeradas = linhas.filter(l => !(l[1] > 0));
  const sacar = k.afiliados.sacar || [];
  const botaoSacar = sacar.length === 1 && sacar[0].portal
    ? `<a class="btn primary small" href="${esc(sacar[0].portal)}" target="_blank" rel="noopener" title="Abre o portal: ${esc(sacar[0].nome)}">Sacar</a>`
    : `<button class="btn ${sacar.length ? 'primary ' : ''}small" type="button" data-db-ir="ganhos">${sacar.length ? 'Sacar' : 'Ver ganhos'}</button>`;
  const PILL = { ok: ['b-ok', 'Ativo'], blocked: ['b-blocked', 'Bloqueado'], error: ['b-error', 'Erro'], not_configured: ['b-none', 'Falta configurar'], running: ['b-ok', 'Minerando'], disabled: ['b-none', 'Desligado'] };
  const noAr = Object.fromEntries((d.saude?.lojas || []).map(l => [l.id, l.ofertas]));

  el.innerHTML = `
    <div class="db-topo">
      <div><h1>Painel</h1><p class="db-status"><i class="db-pulso ${criticos ? 'alerta' : ''}"></i>${criticos ? `${criticos} crítico${criticos > 1 ? 's' : ''}` : 'Operacional'} · <span id="db-lido">${dbTextoLido()}</span></p></div>
      <div class="row db-acoes-topo">
        <button class="btn db-ico-btn" type="button" id="db-atualizar" title="Atualizar" aria-label="Atualizar">${dbIco('refresh')}</button>
        <button class="btn db-manual" type="button" data-db-ir="offers" data-db-secao="Adicionar oferta">+ Oferta manual</button>
        <button class="btn primary" type="button" id="db-minerar" ${m.rodando ? 'disabled' : ''}>${m.rodando ? 'Minerando…' : 'Minerar agora'}</button></div>
    </div>

    <div class="db-kpis">
      ${kpi('offers', 'ofertas', 'Ofertas no ar', dbNum(k.ofertas.no_ar), `${dbVar(k.ofertas.var)} ${dbNum(k.ofertas.novas7d)} novas em 7 dias`)}
      ${kpi('offers', 'clique', 'Cliques em 7 dias', dbNum(k.cliques.d7), `${dbVar(k.cliques.var)} sobre a semana anterior`)}
      ${kpi('users', 'pessoas', 'Usuários', dbNum(k.usuarios.total), `${dbVar(k.usuarios.var)} ${dbNum(k.usuarios.novos7)} novos em 7 dias`)}
      ${kpi('ganhos', 'dinheiro', 'Receita em 30 dias', brl(k.receita.total), `${dbVar(k.receita.var)} sobre o mês anterior`)}
    </div>

    <div class="db-mosaico">
      <section class="panel db-atencao">
        <div class="db-cab"><h2>Precisa da sua atenção</h2>${acoes.length ? `<span class="db-num">${acoes.length}</span>` : ''}</div>
        ${acoes.length ? `<ul class="db-alertas">${acoes.map(a => `<li class="${a.nivel}"><i class="db-nivel ${a.nivel}" title="${NOME_NIVEL[a.nivel]}"></i><span>${a.txt}</span><button class="btn small" type="button" ${a.erros ? 'data-db-erros' : `data-db-ir="${a.aba}" data-db-secao="${esc(a.secao)}"`}>${a.acao}</button></li>`).join('')}</ul>`
          : `<p class="db-ok">${dbIco('ok')} Tudo em dia. Nenhuma pendência agora.</p>`}
      </section>

      <section class="panel db-dinheiro-card">
        ${cab('Dinheiro em 30 dias', 'ganhos', 'Ganhos')}
        <div class="db-saldo"><div><small>Disponível para saque</small><b>${brl(k.afiliados.disponivel)}</b>${k.afiliados.pode_sacar?.length ? `<small>${esc(k.afiliados.pode_sacar.join(', '))}</small>` : ''}</div>${botaoSacar}</div>
        <dl class="db-linhas">${comValor.map(linha).join('')}</dl>
        ${zeradas.length ? `<details class="db-zeradas"><summary>${zeradas.length} linha${zeradas.length > 1 ? 's' : ''} sem valor</summary><dl class="db-linhas">${zeradas.map(linha).join('')}</dl></details>` : ''}
      </section>

      <section class="panel db-grafico">
        <div class="db-cab"><h2>Últimos 30 dias</h2>
          <div class="db-seg" role="tablist">${Object.entries(DB_SERIES).map(([c, [nome]]) => `<button type="button" data-serie="${c}" aria-selected="${c === serie0}">${nome}</button>`).join('')}</div></div>
        <div id="db-graf"></div>
      </section>

      <section class="panel db-mineracao">
        ${cab('Mineração', 'mining', 'Detalhes')}
        <p class="db-nota">${m.rodando ? 'Mineração em andamento…' : m.ultima ? `Última rodada: ${new Date(m.ultima).toLocaleString('pt-BR')}` : 'Nenhuma rodada desde que o servidor iniciou'} · <b>${m.ok} de ${m.total}</b> funcionando</p>
        <table class="db-lojas-tab"><thead><tr><th>Loja</th><th>Ofertas no ar</th><th>Situação</th></tr></thead><tbody>${m.lojas.map(l => { const [c, t] = PILL[l.status] || ['b-none', 'Sem rodada']; return `<tr><td>${lojaLogo(l.id, l.nome)}</td><td>${dbNum(noAr[l.id])}</td><td><span class="badge ${c}">${t}</span></td></tr>`; }).join('')}</tbody></table>
        ${m.problemas.map(x => `<p class="db-falha" title="${esc(x.msg || STATUS_LABEL[x.status] || '')}"><b>${esc(x.nome)}:</b> ${esc(x.msg || STATUS_LABEL[x.status] || '')}</p>`).join('')}
      </section>
    </div>

    <div class="db-tres">
      <section class="panel">
        ${cab('Novos cadastros', 'users', 'Ver usuários')}
        ${d.ultimos_cadastros.length ? `<ul class="db-lista">${d.ultimos_cadastros.slice(0, 4).map(u => `<li><span class="db-txt"><b>${esc(u.empresa_nome || u.nome || u.email)}</b><br><small>${esc(tipo[u.tipo] || 'Sem perfil')} · ${fmtDate(u.created_at)}</small></span><span class="badge b-${esc(u.status)}">${esc({ active: 'Ativo', pending: 'Pendente', onboarding: 'Escolhendo perfil', suspended: 'Suspenso', banned: 'Banido', rejected: 'Recusado' }[u.status] || u.status)}</span></li>`).join('')}</ul>` : '<p class="hint">Nenhum cadastro ainda.</p>'}
      </section>
      <section class="panel">
        ${cab('Últimas assinaturas', 'planos', 'Ver planos')}
        ${d.ultimos_pagamentos.length ? `<ul class="db-lista">${d.ultimos_pagamentos.slice(0, 4).map(x => `<li><span class="db-txt"><b>${esc(x.nome || x.email)}</b><br><small>${esc(x.plano)} · ${fmtDate(x.created_at)}</small></span><b class="num">${brl(x.valor)}</b><span class="badge ${(PED_STATUS[x.status] || ['b-none'])[0]}">${esc(statusPag[x.status] || x.status)}</span></li>`).join('')}</ul>` : '<p class="hint">Nenhuma assinatura ainda.</p>'}
      </section>
      ${d.ultimos_pedidos.length ? `<section class="panel">
        \${cab('Últimos pedidos', 'atendimento', 'Ver pedidos')}
        \${d.ultimos_pedidos.length ? \`<ul class="db-lista">\${d.ultimos_pedidos.slice(0, 4).map(x => \`<li><span class="db-txt"><b>PD-\${String(x.id).padStart(6, '0')}</b> · \${esc(x.produto)}<br><small>\${esc(x.loja)} · \${fmtDate(x.pago_em)}</small></span><b class="num">\${brl(x.total)}</b><span class="badge b-\${x.status === 'cancelado' ? 'banned' : 'active'}">\${esc(statusPedido[x.status] || x.status)}</span></li>\`).join('')}</ul>\` : ''}
      </section>` : ''}
    </div>`;

  dbDesenharGrafico();
  el.querySelectorAll('[data-db-erros]').forEach(b => b.addEventListener('click', () => {
    const c = $('#db-console');
    if (c) { c.open = true; c.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }));
  el.querySelectorAll('[data-db-ir]').forEach(b => b.addEventListener('click', () => { abrirAba(b.dataset.dbIr); if (b.dataset.dbSecao) dobraAbrir(b.dataset.dbIr, b.dataset.dbSecao); }));
  el.querySelectorAll('[data-serie]').forEach(b => b.addEventListener('click', () => {
    el.querySelectorAll('[data-serie]').forEach(x => x.setAttribute('aria-selected', x === b));
    dbSerieAtual = b.dataset.serie;
    dbDesenharGrafico();
  }));
  $('#db-atualizar').addEventListener('click', loadDashboard);
  $('#db-minerar').addEventListener('click', async () => {
    try { await api('/api/admin/mine', { method: 'POST', body: {} }); globalMsg('Mineração iniciada. Acompanhe em Mineração.'); }
    catch (err) { globalMsg(err.message, false); }
    setTimeout(loadDashboard, 1000);
  });
}

// ── Números no topo de cada aba, no mesmo formato da tela inicial ──
const abaKpi = (ico, rot, val, sub = '') => `<div class="db-kpi aba-kpi"><span>${rot}</span><i class="db-kpi-ico">${dbIco(ico)}</i><b>${val}</b><small>${sub}</small></div>`;
let dashLidoEm = 0;
async function mostrarNumerosAba(aba) {
  const el = document.getElementById(`kpis-${aba}`);
  if (!el || aba === 'avisos' || aba === 'acessos') return;
  try {
    if (!DASH || Date.now() - dashLidoEm > 60000) { DASH = await api('/api/admin/dashboard'); dashLidoEm = Date.now(); }
    const d = DASH, k = d.kpis, p = d.pendencias, m = d.mineracao, x = d.abas || {};
    const n = dbNum;
    const M = {
      offers: () => [abaKpi('ofertas', 'Ofertas no ar', n(k.ofertas.no_ar), `${dbVar(k.ofertas.var)} ${n(k.ofertas.novas7d)} novas em 7 dias`),
        abaKpi('ofertas', 'Novas em 24 horas', n(k.ofertas.novas24h)), abaKpi('clique', 'Cliques em 7 dias', n(k.cliques.d7), `${dbVar(k.cliques.var)} sobre a semana anterior`),
        abaKpi('alerta', 'Descontos suspeitos', n(d.saude?.suspeitas), 'para conferir')],
      mining: () => [abaKpi('ok', 'Lojas funcionando', `${m.ok} de ${m.total}`), abaKpi('alerta', 'Lojas com problema', n(m.problemas.length), esc(m.problemas.map(l => l.nome).join(', '))),
        abaKpi('ofertas', 'Ofertas no ar', n(k.ofertas.no_ar)), abaKpi('ofertas', 'Novas em 24 horas', n(k.ofertas.novas24h))],
      social: () => [abaKpi('ok', 'Enviadas em 7 dias', n(x.social?.enviadas7)), abaKpi('alerta', 'Com erro em 7 dias', n(x.social?.erros7)), abaKpi('sino', 'Na fila', n(x.social?.fila))],
      users: () => [abaKpi('pessoas', 'Usuários', n(k.usuarios.total), `${dbVar(k.usuarios.var)} ${n(k.usuarios.novos7)} novos em 7 dias`), abaKpi('pessoas', 'Consumidores ativos', n(k.usuarios.consumidores)),
        abaKpi('sacola', 'Empresas ativas', n(k.usuarios.empresas)), abaKpi('alerta', 'Cadastros pendentes', n(p.cadastros))],
      atendimento: () => [abaKpi('sacola', 'Pedidos em 30 dias', n(k.pedidos.n)), abaKpi('dinheiro', 'Vendido pelas lojas', brl(k.pedidos.valor)), abaKpi('dinheiro', 'Taxa do site', brl(k.receita.taxa_pedidos)), abaKpi('sino', 'Chamados no SAC', n(p.sac_fila))],
      planos: () => [abaKpi('dinheiro', 'Assinaturas em 30 dias', brl(k.receita.assinaturas), `${n(k.receita.assinaturas_n)} pagamento(s)`), abaKpi('alerta', 'A confirmar', n(p.assinaturas)),
        abaKpi('pessoas', 'Afiliados ativos', n(x.clientes_ativos)), abaKpi('dinheiro', 'Receita em 30 dias', brl(k.receita.total), `${dbVar(k.receita.var)} sobre o mês anterior`)],
      ganhos: () => [abaKpi('dinheiro', 'Disponível para saque', brl(k.afiliados.disponivel), esc((k.afiliados.pode_sacar || []).join(', '))), abaKpi('dinheiro', 'A liberar', brl(k.afiliados.a_liberar)),
        abaKpi('dinheiro', 'Comissões em 30 dias', brl(k.receita.afiliados), `${dbVar(k.receita.afiliados_var)} ${n(k.receita.afiliados_n)} venda(s)`), abaKpi('sino', 'Avisos de saldo', n(p.avisos))],
      aff: () => { const f = x.links?.faltam || [], t = x.links?.total || 6; return [abaKpi('ok', 'Lojas com link', `${t - f.length} de ${t}`), abaKpi('alerta', 'Faltam', n(f.length), esc(f.join(', ')))]; },
      ads: () => [abaKpi('ok', 'Campanhas no ar', n(x.ads?.ativas)), abaKpi('ofertas', 'Campanhas cadastradas', n(x.ads?.total)), abaKpi('sino', 'Pedidos novos', n(p.leads))],
    };
    if (aba === 'clientes') {
      const l = await api('/api/admin/clientes');
      el.innerHTML = abaKpi('pessoas', 'Clientes ativos', n(l.filter(c => c.status !== 'bloqueado' && !c.vencido).length)) + abaKpi('alerta', 'Vencem em até 5 dias', n(p.clientes_vencendo))
        + abaKpi('ok', 'Aceitaram os Termos', `${n(l.filter(c => c.aceite_termos).length)} de ${n(l.length)}`) + abaKpi('ok', 'Postagens', n(l.reduce((s, c) => s + (c.postagens || 0), 0)));
    } else el.innerHTML = M[aba]().join('');
    el.hidden = false;
  } catch { el.hidden = true; }
}

// Ícone da loja no painel
const LOJAS_COM_LOGO = { mercadolivre: 'webp', amazon: 'webp', shopee: 'svg', magalu: 'svg', aliexpress: 'webp', kabum: 'svg' };
const lojaLogo = (idOuNome, nome) => {
  const id = STORE_LIST.find(x => x.id === idOuNome || x.name === idOuNome)?.id || idOuNome;
  const ext = LOJAS_COM_LOGO[id];
  if (!ext) return esc(nome);
  const img = (arq, cl) => `<img class="store-marca marca-${id}${cl}" src="/images/lojas/${arq}.${ext}" alt="${esc(nome)}" title="${esc(nome)}">`;
  return ['mercadolivre', 'amazon', 'kabum'].includes(id) ? img(id, ' tema-claro') + img(`${id}-escuro`, ' tema-escuro') : img(id, '');
};

const LOGOS_AFF = { 'Mercado Livre': 'mercadolivre', Amazon: 'amazon', Shopee: 'shopee', AliExpress: 'aliexpress', 'KaBuM!': 'kabum', Magalu: 'magalu' };
document.querySelectorAll('[data-body="aff"] .store-card > h4').forEach(h => {
  const id = LOGOS_AFF[h.textContent.trim()];
  if (id) h.innerHTML = lojaLogo(id, h.textContent.trim());
});

// ── Membros dos grupos ────
async function loadMembros() {
  const d = await api('/api/admin/membros?dias=30');
  const n = v => Number(v || 0).toLocaleString('pt-BR');
  const k = (r, v, ico = 'pessoas') => abaKpi(ico, r, v);
  $('#mb-kpis').innerHTML = k('Membros', d.grupos.some(g => g.total !== null) ? n(d.total) : '—') + k('Entradas em 30 dias', n(d.entradas)) + k('Saídas em 30 dias', n(d.saidas)) + k('Saldo', n(d.entradas - d.saidas));
  $('#mb-grupos').innerHTML = d.grupos.map(g => `<tr><td>${esc(g.nome)}</td><td>${g.total === null ? '—' : n(g.total)}</td><td>${n(g.entradas)}</td><td>${n(g.saidas)}</td></tr>`).join('')
    || '<tr><td colspan="4" class="hint">Sem dados ainda. Escolha os grupos em Redes sociais e toque em Atualizar o total agora.</td></tr>';
}
$('#mb-atualizar').addEventListener('click', async e => {
  const b = e.currentTarget; b.disabled = true;
  try { await api('/api/admin/membros/atualizar', { method: 'POST' }); await loadMembros(); }
  catch (err) { globalMsg(err.message, false); }
  b.disabled = false;
});

// ── Painel / lojas ────────────────────────────────────────────────────────────
const STATUS_LABEL = {
  ok: 'Funcionando', blocked: 'Bloqueada pela loja', error: 'Erro', not_configured: 'Falta configurar',
  manual: 'Somente manual', disabled: 'Desativada', running: 'Minerando...', stopped: 'Parada',
};
let pollTimer = null;

// Termos de marca e modelo aprendidos das ofertas das lojas com afiliado (valem para a busca de todas as lojas)
function termosMarcaLinha(t) {
  const texto = t.total ? `${t.hoje} hoje, ${t.total} no total${t.ultimos?.length ? ` · últimos: ${t.ultimos.slice(0, 6).map(x => x.q).join(', ')}` : ''}` : 'ligado, aprende uma vez por dia depois da mineração';
  return `<tr class="tab-msg"><td colspan="5">🏷️ Termos de marca e modelo aprendidos das ofertas (para todas as lojas): ${esc(texto)}</td></tr>`;
}

// Anúncios comuns do Mercado Livre (fora do catálogo), buscados pela extensão no Chrome do administrador
function mlChromeLinha(m) {
  let texto, ruim = false;
  if (!m.ligada) texto = 'Desligada.';
  else if (!m.ativa) { texto = 'Parada: abra o Chrome com a extensão do Ofertou! e entre no Painel uma vez. Sem ela, só entram os produtos de catálogo do Mercado Livre.'; ruim = true; }
  else if (m.erro) { texto = `Problema na última busca: ${m.erro}. Abra o Mercado Livre neste Chrome e confira se está logado.`; ruim = true; }
  else texto = m.ultima ? `Ligada, buscando os ${m.termos} termos em rodízio · ${m.gravadas} ofertas gravadas de ${m.encontradas} lidas · último termo "${m.ultimo_termo}" em ${fmtDate(m.ultima.replace('T', ' ').slice(0, 19))}` : 'Ligada, esperando a primeira busca.';
  const n = m.novos;
  const aprendidos = n?.ligado && n.total
    ? `<tr class="tab-msg"><td colspan="5">🌱 Termos novos aprendidos nas buscas: ${n.hoje} hoje, ${n.total} no total${n.ultimos?.length ? ` · últimos: ${esc(n.ultimos.slice(0, 6).map(x => x.q).join(', '))}` : ''}</td></tr>` : '';
  return `<tr class="tab-msg"><td colspan="5" class="${ruim ? 'ruim' : ''}">🧩 Anúncios comuns pelo seu Chrome: ${esc(texto)}</td></tr>${aprendidos}`;
}

async function loadStores() {
  const st = await api('/api/admin/stores');
  CATEGORIES = st.categories;
  $('#cupons-lista').innerHTML = (st.cupons || []).map(c => `<tr><td><b>${esc(/^ML\d+$/.test(c.codigo) ? 'Sem código (ativar no app)' : c.codigo)}</b></td>
    <td>${esc(STORE_LIST.find(s => s.id === c.store_id)?.name || c.store_id)}</td><td>${esc(c.texto || '—')}</td><td>${c.ofertas}</td>
    <td><a class="btn small" href="/?cupom=${encodeURIComponent(c.codigo)}" target="_blank" rel="noopener">Ver ofertas</a></td></tr>`).join('')
    || '<tr><td colspan="5" class="hint">Nenhum cupom ainda: eles aparecem depois da próxima mineração da KaBuM! e da Magalu.</td></tr>';
  const caixaLojas = $('#store-cards');
  caixaLojas.className = 'table-wrap';
  caixaLojas.innerHTML = `<table class="tab-lojas"><thead><tr><th>Loja</th><th>Situação</th><th>Última execução</th><th>Gravadas</th><th>Último sucesso</th></tr></thead><tbody>${st.stores.map(s => {
    const status = s.status || 'none';
    return `<tr><td class="tab-loja">${lojaLogo(s.id || s.name, s.name)}<small>${esc(s.method)}</small></td>
      <td><span class="badge b-${status}">${esc(STATUS_LABEL[status] || 'Ainda não rodou')}</span></td>
      <td class="num" data-l="Última execução">${s.automatic ? fmtDate(s.last_run_at) : '—'}</td>
      <td class="num" data-l="Gravadas">${s.automatic ? `${s.saved || 0} de ${s.found || 0}` : '—'}</td>
      <td class="num" data-l="Último sucesso">${s.automatic ? fmtDate(s.last_success_at) : '—'}</td></tr>
      ${s.message ? `<tr class="tab-msg"><td colspan="5" class="${status === 'ok' ? '' : 'ruim'}">${esc(s.message)}</td></tr>` : ''}
      ${s.id === 'mercadolivre' && st.ml_chrome ? mlChromeLinha(st.ml_chrome) : ''}${s.id === 'shopee' && st.termos_marca?.ligado ? termosMarcaLinha(st.termos_marca) : ''}`;
  }).join('')}</tbody></table>`;
  const lr = st.lastRun;
  $('#last-run').textContent = st.parando ? 'Parando a mineração… (termina a busca que está no meio)' : st.running ? 'Mineração em andamento...' :
    lr ? `Última mineração ${lr.parada ? 'parada' : 'terminou'} em ${new Date(lr.finishedAt).toLocaleString('pt-BR')}.` : 'Nenhuma mineração desde que o servidor iniciou.';
  $('#mine-now').disabled = st.running;
  $('#mine-stop').classList.toggle('hidden', !st.running);
  $('#mine-stop').disabled = Boolean(st.parando);
  $('#mine-stop').textContent = st.parando ? 'Parando…' : '■ Parar mineração';
  clearTimeout(pollTimer);
  if (st.running) pollTimer = setTimeout(loadStores, 4000);

  // Busca pontual: começa com as lojas ligadas na automática (mantém o que a pessoa já marcou)
  const marcadas = new Set([...document.querySelectorAll('#qm-lojas input:checked')].map(i => i.value));
  const primeiraVez = !document.querySelector('#qm-lojas input');
  $('#qm-lojas').innerHTML = st.stores.filter(s => s.automatic).map(s => `
    <label class="check"><input type="checkbox" value="${s.id}" ${(primeiraVez ? st.enabled[s.id] !== false : marcadas.has(s.id)) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('');

  $('#qm-todas').textContent = [...document.querySelectorAll('#qm-lojas input')].every(c => c.checked) ? 'desmarcar todas' : 'marcar todas';

  $('#enabled-stores').innerHTML = st.stores.filter(s => s.automatic).map(s => `
    <label class="check"><input type="checkbox" data-store="${s.id}" ${st.enabled[s.id] !== false ? 'checked' : ''}> ${esc(s.name)}</label>`).join('');
}

$('#mine-stop').addEventListener('click', async () => {
  if (!await OfertouUI.confirmar('Parar a mineração que está acontecendo agora? As ofertas já encontradas continuam gravadas; os termos que faltaram ficam para a próxima rodada.', { ok: 'Parar', perigo: true })) return;
  try {
    const r = await api('/api/admin/mine/parar', { method: 'POST' });
    globalMsg(r.parando ? 'Parando a mineração…' : r.motivo, r.parando);
    loadStores();
  } catch (err) { globalMsg(err.message, false); }
});

$('#mine-now').addEventListener('click', async () => {
  try { await api('/api/admin/mine', { method: 'POST', body: {} }); globalMsg('Mineração iniciada. Acompanhe o status abaixo.'); }
  catch (err) { globalMsg(err.message, false); }
  setTimeout(loadStores, 800);
});

$('#qm-lojas').addEventListener('change', () => {
  $('#qm-todas').textContent = [...document.querySelectorAll('#qm-lojas input')].every(c => c.checked) ? 'desmarcar todas' : 'marcar todas';
});
$('#qm-todas').addEventListener('click', () => {
  const caixas = [...document.querySelectorAll('#qm-lojas input')];
  const todas = caixas.every(c => c.checked);
  caixas.forEach(c => { c.checked = !todas; });
  $('#qm-todas').textContent = todas ? 'marcar todas' : 'desmarcar todas';
});

// ── Comissão extra do Mercado Livre: página do painel de afiliados copiada e colada ─────────────────────────
// Lê no próprio navegador: cada cartão de produto (bloco com um só link MLB) dá o código, o nome, os preços, a foto
// e as porcentagens de ganho (normal e extra). O servidor marca as ofertas do site e inclui as que faltam.
const MLX = { itens: [] };
const mlxPct = /(\d{1,2}(?:[.,]\d{1,2})?)\s*%/g;
const mlxDinheiro = /R\$\s?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/g;
const mlxNum = s => Number(String(s).replace(/\./g, '').replace(',', '.'));
function mlxCodigo(href) {
  const h = decodeURIComponent(href || '');
  const item = h.match(/item_id[:=]MLB-?(\d{6,})/i) || h.match(/[?&]wid=MLB-?(\d{6,})/i) || (!/\/p\/MLB/i.test(h) && h.match(/MLB-?(\d{6,})/i));
  const prod = h.match(/\/p\/MLB-?(\d{6,})/i);
  return { item: item ? `MLB${item[1]}` : null, produto: prod ? `MLB${prod[1]}` : null };
}
const mlxChave = c => c.item || c.produto;
// Texto do bloco com espaço entre os pedaços (o textContent junta "8%" com a palavra seguinte)
function mlxTexto(el) {
  const partes = [];
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) { const t = n.nodeValue.trim(); if (t) partes.push(t); }
  return partes.join(' ').replace(/\s+/g, ' ');
}
function mlxGanho(texto) {
  let base = 0, extra = 0, incluida = false;
  const achados = [...texto.matchAll(mlxPct)];
  achados.forEach((p, i) => {
    const v = Number(p[1].replace(',', '.'));
    if (!(v > 0 && v <= 60)) return;
    const ini = i ? achados[i - 1].index + achados[i - 1][0].length : Math.max(0, p.index - 30);
    const fim = Math.min(i < achados.length - 1 ? achados[i + 1].index : texto.length, p.index + p[0].length + 30);
    // O rótulo vem antes do número ("Ganho extra +6%"); depois, só conta se estiver colado ("4% extra")
    const antes = texto.slice(ini, p.index), depois = texto.slice(p.index + p[0].length, fim);
    if (/^\s*(off|de desconto|de cashback)/i.test(depois) || /(desconto|juros|cashback|cupom|avalia\w*)(\s+de)?\s*$/i.test(antes.slice(-14))) return;
    // Vale a palavra mais perto do número: "Ganho extra Ganhos 8%" → 8% é ganho normal; "Ganho extra +6%" → extra
    const ultima = re => { let i = -1; for (const m of antes.matchAll(re)) i = m.index; return i; };
    const pExtra = ultima(/extra|adicional|campanha|bônus|bonus/gi), pGanho = ultima(/ganh|comiss/gi);
    const ehExtra = (pExtra >= 0 && pExtra > pGanho && antes.length - pExtra <= 25) || /^\s*\)?\s*(a mais\s+)?(extra|adicional|de bônus|de bonus)/i.test(depois);
    if (ehExtra) { extra = Math.max(extra, v); if (/inclu|dos quais|sendo/i.test(antes.slice(-25))) incluida = true; }
    else if (pGanho >= 0 && antes.length - pGanho <= 30) base = Math.max(base, v);
  });
  if (!base && !extra) return null;
  return { comissao: Math.round((extra && !incluida ? base + extra : base || extra) * 100) / 100, extra };
}
function mlxLer(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const itens = new Map();
  for (const a of doc.querySelectorAll('a[href*="MLB"]')) {
    const cod = mlxCodigo(a.getAttribute('href'));
    const chave = mlxChave(cod);
    if (!chave || itens.has(chave)) continue;
    // Cartão = maior bloco em volta do link que ainda tem um produto só
    let card = null;
    for (let el = a.parentElement, i = 0; el && el !== doc.body && i < 8; el = el.parentElement, i++) {
      const outros = new Set([...el.querySelectorAll('a[href*="MLB"]')].map(x => mlxChave(mlxCodigo(x.getAttribute('href')))).filter(Boolean));
      if (outros.size > 1) break;
      card = el;
    }
    if (!card) continue;
    const texto = mlxTexto(card);
    const ganho = mlxGanho(texto);
    if (!ganho) continue;
    // Preços: valores em R$ que não são o ganho em dinheiro ("Ganhe R$ 12,00")
    const precos = [...texto.matchAll(mlxDinheiro)]
      .filter(m => !/(ganh|comiss|extra)[^$]{0,14}$/i.test(texto.slice(Math.max(0, m.index - 18), m.index)))
      .map(m => mlxNum(m[1])).filter(v => v > 0);
    const img = card.querySelector('img');
    const imagem = img && (img.getAttribute('data-src') || img.getAttribute('src') || '');
    const nome = [...card.querySelectorAll('a[href*="MLB"]')].map(x => mlxTexto(x)).sort((x, y) => y.length - x.length)[0]
      || img?.getAttribute('alt') || '';
    itens.set(chave, { ...cod, nome: nome.slice(0, 200), ...ganho,
      preco: precos.length ? Math.min(...precos) : null, preco_anterior: precos.length > 1 ? Math.max(...precos) : null,
      imagem: /^https:\/\//.test(imagem || '') ? imagem : null });
  }
  return [...itens.values()];
}
function mlxMostrar() {
  const n = MLX.itens.length, extras = MLX.itens.filter(i => i.extra > 0).length;
  $('#mlx-previa').hidden = !n;
  $('#mlx-info').innerHTML = n
    ? `<b>${n}</b> produto(s) com comissão encontrados, <b>${extras}</b> com comissão extra.`
    : '';
  $('#mlx-lista').innerHTML = MLX.itens.slice(0, 60).map(i => `<tr><td>${esc(i.nome || '—')}</td><td class="num">${esc(i.item || i.produto)}</td>
    <td class="num">${String(i.comissao).replace('.', ',')}%</td><td class="num">${i.extra ? `<b>+${String(i.extra).replace('.', ',')}%</b>` : '—'}</td></tr>`).join('')
    + (n > 60 ? `<tr><td colspan="4" class="hint">… e mais ${n - 60}.</td></tr>` : '');
}
function mlxProcessar(html, origem = 'colagem') {
  $('#mlx-resultado').textContent = '';
  if (!html) {
    MLX.itens = [];
    mlxMostrar();
    $('#mlx-cola').textContent = '';
    $('#mlx-resultado').textContent = 'A colagem veio sem os links dos produtos. Copie direto da página do Mercado Livre (Ctrl+A e Ctrl+C) e cole aqui com Ctrl+V (não use "colar sem formatação").';
    return;
  }
  MLX.itens = mlxLer(html);
  $('#mlx-cola').textContent = origem === 'extensao'
    ? `Página trazida pela extensão (${Math.max(1, Math.round(html.length / 1024))} KB).`
    : `Página colada (${Math.max(1, Math.round(html.length / 1024))} KB). Para trocar, clique aqui e cole de novo.`;
  mlxMostrar();
  if (!MLX.itens.length) $('#mlx-resultado').textContent = 'Não encontrei produtos com porcentagem de ganho nessa página. Confira se é a página dos produtos com ganho extra do painel de afiliados.';
  return MLX.itens.length;
}
$('#mlx-cola').addEventListener('paste', e => {
  e.preventDefault();
  mlxProcessar(e.clipboardData.getData('text/html'));
});
let extensaoInstalada = false, extensaoVersao = '', coletaEspera = null;
// Extensão do Chrome "Ofertou! Comissão extra ML" (pasta extensao-comissao/): conversa por mensagens nesta janela
const ML_HUB = 'https://www.mercadolivre.com.br/afiliados/hub?is_affiliate=true';
window.addEventListener('message', e => {
  if (e.source !== window || e.origin !== location.origin || !e.data || e.data.ofertouExt !== true) return;
  if (e.data.tipo === 'pode-ir-ofertas') clearTimeout(coletaEspera);
  if (e.data.tipo === 'pode-ir-ofertas') window.top.location.href = 'https://www.mercadolivre.com.br/ofertas?container_id=MLB779362-1&promotion_type=lightning';
  if (e.data.tipo === 'instalada') { extensaoInstalada = true; extensaoVersao = String(e.data.versao || ''); mostrarExtensao(); portaisAoAbrir(); }
  if (e.data.tipo === 'ganhos-portal') receberPortais(e.data.resultados);
  if (e.data.tipo === 'instalada') { $('#mlx-auto').hidden = false; $('#mlx-ext').hidden = true; $('#mlc-auto').hidden = false; $('#mlc-sem-ext').hidden = true; }
  if (e.data.tipo === 'pode-ir') window.top.location.href = ML_HUB;
  if (e.data.tipo === 'pode-ir-cupons') window.top.location.href = 'https://www.mercadolivre.com.br/cupons/filter?all=true&page=1';
  if (e.data.tipo === 'cupons') mlcImportar(e.data);
  if (e.data.tipo === 'ganho-estimado') {
    // "Ganho estimado" lido no painel do Mercado Livre: grava (substitui o anterior) e atualiza o cartão se estiver aberto
    api('/api/admin/ganhos/ml-estimado', { method: 'POST', body: { valor: e.data.valor } })
      .then(() => { if (!$('[data-body="ganhos"]')?.classList.contains('hidden')) loadGanhos(); })
      .catch(() => {});
  }
  if (e.data.tipo === 'pagina') {
    // Volta do Mercado Livre: mostra a aba, lê a página do mesmo jeito da colagem e importa sozinho
    if (location.hash !== '#mining') abrirAba('mining');
    $('#mlx-cola').closest('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (mlxProcessar(String(e.data.html || ''), 'extensao')) $('#mlx-importar').click();
    const filtro = { aplicado: 'Filtro "Ganhos extras" ligado pela extensão.', ja: 'O filtro "Ganhos extras" já estava ligado.', 'nao-achei': 'A extensão não achou o filtro "Ganhos extras" na página: vieram os produtos que estavam na tela.' }[e.data.filtro];
    if (filtro) $('#mlx-cola').textContent += ` ${filtro}`;
  }
});
// ── Cupons do Mercado Livre (extensão): grava os cupons em lotes e depois os produtos de cada cupom ──
const brl2 = v => v == null ? '—' : `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
let mlcGravando = false;
const mlcAvisoSaida = e => { e.preventDefault(); e.returnValue = ''; };
async function mlcImportar(d) {
  if (mlcGravando) return;
  mlcGravando = true;
  window.addEventListener('beforeunload', mlcAvisoSaida); // a gravação leva alguns minutos
  if (location.hash !== '#mining') abrirAba('mining');
  const out = $('#mlc-resultado');
  out.closest('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  const lista = Array.isArray(d.cupons) ? d.cupons : [];
  const produtos = d.produtos && typeof d.produtos === 'object' ? Object.entries(d.produtos) : [];
  const ofertas = Array.isArray(d.ofertas) ? d.ofertas : [];
  try {
    // Primeiro as ofertas (relâmpago e do dia): as relâmpago têm hora para acabar e não podem depender do resto
    let rel = 0, grav = 0, encerradas = 0, falhaOfertas = '';
    try {
      for (let i = 0; i < ofertas.length; i += 200) {
        out.textContent = `Gravando ofertas… ${Math.min(i + 200, ofertas.length)} de ${ofertas.length}`;
        const r = await api('/api/admin/mineracao/ml-ofertas', { method: 'POST', body: { itens: ofertas.slice(i, i + 200) } });
        grav += r.gravados; rel += r.relampagos;
      }
      // Só as lidas nas páginas de relâmpago dizem quais relâmpago continuam
      const relampagos = ofertas.filter(o => o.relampago !== false);
      if (relampagos.length) encerradas = (await api('/api/admin/mineracao/ml-ofertas', { method: 'POST', body: { vistos: relampagos.map(o => o.produto || o.item), completa: d.ofertas_completa === true } })).encerradas;
    } catch (err) { falhaOfertas = err.message; }
    for (let i = 0; i < lista.length; i += 200) {
      out.textContent = `Gravando cupons… ${Math.min(i + 200, lista.length)} de ${lista.length}`;
      await api('/api/admin/mineracao/ml-cupons', { method: 'POST', body: { cupons: lista.slice(i, i + 200) } });
    }
    if (!lista.length && d.motivo === 'ok') await api('/api/admin/mineracao/ml-cupons', { method: 'POST', body: { cupons: [], leitura_ok: true } });
    const esgotados = Array.isArray(d.esgotados) ? d.esgotados : [];
    const fora = esgotados.length ? await api('/api/admin/mineracao/ml-cupons', { method: 'POST', body: { esgotados } }) : { ofertas: 0 };
    let gravados = 0, recebidos = 0, falhasProdutos = 0;
    for (const [n, [campanha, itens]] of produtos.entries()) {
      out.textContent = `Gravando produtos… cupom ${n + 1} de ${produtos.length}. Deixe esta página aberta.`;
      try {
        const r = await api('/api/admin/mineracao/ml-cupons', { method: 'POST', body: { campanha, itens: itens.slice(0, 150) } });
        gravados += r.gravados; recebidos += r.recebidos;
      } catch { falhasProdutos++; } // um cupom com problema não derruba os outros
    }
    const ativos = lista.filter(c => c.ativo).length;
    out.innerHTML = `<b>${lista.length}</b> cupons lidos (${ativos} ativos na sua conta${d.aplicados ? `, ${d.aplicados} aplicados agora pela extensão` : ''}) · <b>${gravados}</b> ofertas gravadas com cupom de ${recebidos} produtos "com Cupom" em ${produtos.length} cupons`
      + (esgotados.length ? ` · ${esgotados.length} esgotados ignorados${fora.ofertas ? ` (${fora.ofertas} ofertas perderam o cupom)` : ''}` : '')
      + (d.motivo === 'parado' ? ' · mineração parada por você' : d.motivo === 'sem-dados' ? ' · a central de cupons não abriu (faça login no Mercado Livre)' : d.motivo === 'verificacao' ? ' · o Mercado Livre pediu verificação ou limitou os pedidos, então a leitura parou aqui. Abra o Mercado Livre, resolva e colete de novo mais tarde' : '')
      + (d.listasFalhas ? ` · ${d.listasFalhas} listas de produtos não abriram e foram puladas` : '')
      + (falhasProdutos ? ` · ${falhasProdutos} cupons não gravaram os produtos` : '');
    if (falhaOfertas) out.innerHTML += ` · <b>as ofertas relâmpago não gravaram:</b> ${esc(falhaOfertas)}`;
    else if (ofertas.length) out.innerHTML += ` · <b>${grav}</b> ofertas lidas, <b>${rel}</b> relâmpago${encerradas ? `, ${encerradas} encerradas` : ''}`;
    else if (d.ofertas) out.innerHTML += ' · nenhuma oferta lida (confira se o Chrome está logado no Mercado Livre)';
    carregarRadar();
    if (!falhaOfertas) window.postMessage({ ofertouPainel: true, tipo: 'coleta-gravada' }, location.origin);
  } catch (err) { out.textContent = `Erro ao gravar: ${err.message}`; }
  mlcGravando = false;
  window.removeEventListener('beforeunload', mlcAvisoSaida);
  mlcCarregar();
  loadStores();
}
let MLC = [];
async function mlcCarregar() {
  try { MLC = await api('/api/admin/mineracao/ml-cupons'); } catch { MLC = []; }
  mlcMostrar();
}
function mlcMostrar() {
  const so = $('#mlc-so-ativos').checked;
  const l = MLC.filter(c => !so || c.ativo);
  $('#mlc-total').textContent = MLC.length ? `${MLC.length} cupons · ${MLC.filter(c => c.ativo).length} ativos · ${MLC.reduce((s, c) => s + c.produtos, 0)} ofertas com cupom` : '';
  $('#mlc-lista').innerHTML = l.slice(0, 400).map(c => `<tr>
    <td><b>${esc(c.titulo)}</b>${c.subtitulo ? `<br><span class="hint" style="margin:0">${esc(c.subtitulo)}</span>` : ''}${c.previa?.length ? `<br><span class="hint" style="margin:0" title="${esc(c.previa.join(' · '))}">ex.: ${esc(c.previa[0].slice(0, 60))}</span>` : ''}</td>
    <td>${c.tipo === 'pct' ? `${String(c.valor).replace('.', ',')}%` : c.tipo === 'valor' ? brl2(c.valor) : '—'}</td>
    <td>${brl2(c.minimo)}</td><td>${brl2(c.limite)}</td><td>${esc(c.validade || '—')}</td>
    <td>${c.ativo ? (c.link ? `<a href="${esc(c.link)}" target="_blank" rel="noopener">Ativo · ver produtos ↗</a>` : 'Ativo') : '<span class="hint" style="margin:0">Aplicar no ML</span>'}</td>
    <td>${c.produtos ? `<a href="/?cupom=ML${esc(c.campanha)}" target="_blank" rel="noopener">${c.produtos}</a>` : '0'}</td></tr>`).join('')
    || '<tr><td colspan="7" class="hint">Nenhum cupom ainda: toque em "Minerar cupons do Mercado Livre".</td></tr>';
}
$('#mlc-so-ativos').addEventListener('change', mlcMostrar);
const mlcN = (id, min, max, pad) => Math.min(Math.max(parseInt($(id).value, 10) || pad, min), max);
try { const g = JSON.parse(localStorage.getItem('ofertou_ml_cupons') || '{}'); if (g.cupons === 100) delete g.cupons; /* padrão antigo: agora são 300 */ for (const k of ['paginas', 'cupons', 'pagprod', 'maxaplicar']) if (g[k] != null) $(`#mlc-${k}`).value = g[k]; if (g.aplicar != null) $('#mlc-aplicar').checked = g.aplicar; } catch { /* sem armazenamento */ }
$('#mlc-buscar').addEventListener('click', () => {
  const p = { paginas: mlcN('#mlc-paginas', 1, 100, 70), cupons: mlcN('#mlc-cupons', 0, 2000, 300), paginasProd: mlcN('#mlc-pagprod', 1, 10, 2),
    aplicar: $('#mlc-aplicar').checked, maxAplicar: mlcN('#mlc-maxaplicar', 0, 2000, 300) };
  try { localStorage.setItem('ofertou_ml_cupons', JSON.stringify({ paginas: p.paginas, cupons: p.cupons, pagprod: p.paginasProd, aplicar: p.aplicar, maxaplicar: p.maxAplicar })); } catch { /* */ }
  $('#mlc-buscar').disabled = true;
  window.postMessage({ ofertouPainel: true, tipo: 'buscar-cupons', ...p }, location.origin);
  setTimeout(() => { $('#mlc-buscar').disabled = false; }, 3000);
});
mlcCarregar();

// Coleta completa do Mercado Livre (botão do aviso e da Mineração)
function coletarMl() {
  if (!extensaoInstalada) {
    abrirAba('mining');
    dobraAbrir('mining', 'Extensão do Chrome');
    $('#ext-painel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return globalMsg('Baixe e instale a extensão do Chrome para coletar o Mercado Livre: o passo a passo está aqui em Mineração.', false);
  }
  const [maior, menor] = extensaoVersao.split('.').map(Number);
  const RECARREGAR = 'Baixe a extensão de novo em Mineração, descompacte por cima da mesma pasta, toque em recarregar em chrome://extensions e atualize esta página.';
  if (!(maior > 2 || (maior === 2 && menor >= 11))) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return globalMsg(`Sua extensão está desatualizada e a coleta pode travar. ${RECARREGAR}`, false);
  }
  clearTimeout(coletaEspera);
  coletaEspera = setTimeout(() => globalMsg(`A extensão não respondeu. ${RECARREGAR}`, false), 3000);
  window.postMessage({ ofertouPainel: true, tipo: 'coletar-tudo', paginas: 100, cupons: mlcN('#mlc-cupons', 0, 2000, 300),
    paginasProd: mlcN('#mlc-pagprod', 1, 10, 2) }, location.origin);
}
$('#ml-coleta-ir').addEventListener('click', coletarMl);
$('#ml-coleta-botao').addEventListener('click', coletarMl);
// Situação da extensão neste navegador, comparada com a versão disponível para baixar
let extensaoDisponivel = '';
const numVersao = v => String(v || '').split('.').reduce((t, n) => t * 1000 + (Number(n) || 0), 0);
function mostrarExtensao() {
  const el = $('#ext-status');
  if (!el) return;
  const disp = extensaoDisponivel ? `versão ${extensaoDisponivel}` : 'versão mais nova';
  if (!extensaoInstalada) { el.textContent = `Não instalada neste navegador. Disponível: ${disp}.`; el.className = 'ext-status atencao'; return; }
  const atual = extensaoVersao && (!extensaoDisponivel || numVersao(extensaoVersao) >= numVersao(extensaoDisponivel));
  el.textContent = atual ? `Instalada e atualizada (versão ${extensaoVersao}).` : `Instalada, mas desatualizada (versão ${extensaoVersao || 'antiga'}). Disponível: ${disp}.`;
  el.className = `ext-status ${atual ? 'ok' : 'atencao'}`;
}
const RL_SIT = { ok: 'Funcionando', blocked: 'Bloqueada: tenta de novo em 2 horas', error: 'Com erro', off: 'Desligada', aguardando: 'Aguardando a primeira leitura' };
async function carregarRadar() {
  let d;
  try { d = await api('/api/admin/relampago'); } catch { return; }
  extensaoDisponivel = d.extensao?.versao || '';
  mostrarExtensao();
  const c = d.coleta;
  $('#ml-coleta-aviso').hidden = !c.pendente;
  const nomes = { ofertas: 'as ofertas', cupons: 'os cupons' };
  $('#ml-coleta-texto').textContent = c.pendente ? `Faltam ${c.falta.map(k => nomes[k]).join(' e ')} das ${c.hora}h. O aviso some quando a extensão entregar a coleta.` : '';
  const quando = ms => (ms ? new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'nunca');
  $('#ml-coleta-resumo').textContent = `Última coleta: ofertas ${quando(c.ofertas_em)}; cupons ${quando(c.cupons_em)}.`;
  $('#rl-no-ar').textContent = `${d.no_ar} oferta(s) relâmpago no ar agora.`;
  $('#rl-lojas').innerHTML = d.lojas.map(l => `<tr><td>${esc(l.nome)}</td><td>${l.minutos} min</td><td>${esc(RL_SIT[l.status] || l.status)}${l.mensagem ? `<br><small>${esc(l.mensagem).slice(0, 140)}</small>` : ''}</td><td>${l.em ? `${quando(l.em)}: ${l.lidas} lidas, ${l.relampagos} marcadas pela loja` : '—'}</td></tr>`).join('');
}
mostrarExtensao();
carregarRadar();
setInterval(carregarRadar, 5 * 60 * 1000);

// Palavras proibidas na mineração
function mostrarProibidas(d, aviso = '') {
  $('#pp-lista').innerHTML = d.palavras.map(p => `<li><span>${esc(p)}</span><button type="button" data-tirar="${esc(p)}" aria-label="Tirar ${esc(p)} da lista" title="Tirar da lista">×</button></li>`).join('');
  const resumo = `${d.palavras.length} palavra(s) na lista. ${d.fora_do_ar} oferta(s) fora do ar por causa dela.`;
  $('#pp-msg').textContent = aviso ? `${aviso} ${resumo}` : resumo;
}
const resultadoProibidas = d => [d.ocultadas ? `${d.ocultadas} oferta(s) saíram do ar.` : '', d.devolvidas ? `${d.devolvidas} oferta(s) voltaram.` : ''].filter(Boolean).join(' ');
async function enviarProibidas(corpo, feito) {
  try {
    const d = await api('/api/admin/palavras-proibidas', { method: 'POST', body: corpo });
    mostrarProibidas(d, `${feito} ${resultadoProibidas(d)}`.trim());
    return true;
  } catch (err) {
    $('#pp-msg').textContent = err.message;
    return false;
  }
}
$('#pp-form').addEventListener('submit', async e => {
  e.preventDefault();
  const campo = $('#pp-nova'), botao = e.target.querySelector('button');
  botao.disabled = true;
  if (await enviarProibidas({ adicionar: campo.value }, 'Adicionado.')) campo.value = '';
  botao.disabled = false;
});
$('#pp-lista').addEventListener('click', e => {
  const b = e.target.closest('[data-tirar]');
  if (b) enviarProibidas({ remover: b.dataset.tirar }, `"${b.dataset.tirar}" saiu da lista.`);
});
api('/api/admin/palavras-proibidas').then(d => mostrarProibidas(d)).catch(() => {});

window.postMessage({ ofertouPainel: true, tipo: 'ola' }, location.origin);
if (new URLSearchParams(location.search).has('ml-importar') || new URLSearchParams(location.search).has('ml-cupons')) history.replaceState(null, '', `${location.pathname}${location.hash}`);
// Quantas vezes rolar a página do Mercado Livre (a lista carrega mais produtos a cada rolagem); fica guardado
const mlxRolagens = () => Math.min(Math.max(parseInt($('#mlx-rolagens').value, 10) || 10, 1), 100);
try { const r = localStorage.getItem('ofertou_ml_rolagens'); if (r) $('#mlx-rolagens').value = r; } catch { /* sem armazenamento */ }
$('#mlx-rolagens').addEventListener('change', () => { $('#mlx-rolagens').value = mlxRolagens(); try { localStorage.setItem('ofertou_ml_rolagens', mlxRolagens()); } catch { /* */ } });
$('#mlx-buscar').addEventListener('click', () => {
  $('#mlx-buscar').disabled = true;
  window.postMessage({ ofertouPainel: true, tipo: 'buscar', rolagens: mlxRolagens() }, location.origin);
  setTimeout(() => { $('#mlx-buscar').disabled = false; }, 3000);
});
$('#mlx-cola').addEventListener('keydown', e => { if (!(e.ctrlKey || e.metaKey)) e.preventDefault(); }); // a caixa só aceita colar
$('#mlx-limpar-caixa').addEventListener('click', () => { MLX.itens = []; $('#mlx-cola').textContent = ''; $('#mlx-resultado').textContent = ''; mlxMostrar(); });
$('#mlx-importar').addEventListener('click', async () => {
  const b = $('#mlx-importar');
  b.disabled = true;
  const total = { marcados: 0, com_extra: 0, novos: 0, limpos: 0, fora: [], ids: [] };
  try {
    // Em partes de 80 (o pedido tem limite de tamanho); depois, se marcado, tira a extra das campanhas que acabaram
    const partes = [];
    for (let i = 0; i < MLX.itens.length; i += 80) partes.push(MLX.itens.slice(i, i + 80));
    for (const [i, itens] of partes.entries()) {
      $('#mlx-resultado').textContent = `Importando… (${i + 1} de ${partes.length})`;
      const r = await api('/api/admin/mineracao/ml-comissao-extra', { method: 'POST', body: { itens } });
      for (const k of ['marcados', 'com_extra', 'novos']) total[k] += r[k];
      total.fora.push(...r.fora);
      total.ids.push(...r.ids);
    }
    if ($('#mlx-limpar').checked && total.ids.length) {
      const r = await api('/api/admin/mineracao/ml-comissao-extra', { method: 'POST', body: { limpar_exceto: total.ids } });
      total.limpos = r.limpos;
    }
    $('#mlx-resultado').innerHTML = `Pronto: <b>${total.marcados}</b> produto(s) marcados no site (<b>${total.com_extra}</b> com comissão extra)`
      + `${total.novos ? `, sendo <b>${total.novos}</b> novos no site` : ''}${total.limpos ? `; comissão extra retirada de ${total.limpos} que não estavam na lista` : ''}.`
      + (total.fora.length ? `<br>Não entraram (sem desconto ou o Mercado Livre não deixou consultar): ${total.fora.slice(0, 8).map(esc).join(', ')}${total.fora.length > 8 ? '…' : ''}` : '')
      + '<br>Os selos e o filtro "Só comissão extra" atualizam em até 1 minuto na página de ofertas.';
  } catch (err) { $('#mlx-resultado').textContent = err.message; }
  finally { b.disabled = false; }
});

$('#quick-mine').addEventListener('submit', async e => {
  e.preventDefault();
  const q = e.target.query.value.trim();
  const out = $('#quick-result');
  const lojas = [...document.querySelectorAll('#qm-lojas input:checked')].map(i => i.value);
  if (!lojas.length) { out.textContent = 'Marque pelo menos uma loja.'; return; }
  out.textContent = `Minerando "${q}"... (pode levar até 1 minuto)`;
  e.target.querySelector('button').disabled = true;
  try {
    const r = await api('/api/admin/mine', { method: 'POST', body: { query: q, stores: lojas } });
    out.innerHTML = (r.results || []).filter(x => x.status !== 'skipped' && x.status !== 'disabled')
      .map(x => `${esc(STORE_LIST.find(s => s.id === x.store)?.name || x.store)}: <b>${x.saved}</b> gravadas (${esc(STATUS_LABEL[x.status] || x.status)})${!x.saved && x.message ? ` — ${esc(x.message)}` : ''}`).join(' · ') || 'Nenhuma loja automática ativa.';
    loadStores();
  } catch (err) { out.textContent = err.message; }
  e.target.querySelector('button').disabled = false;
});

// Adicionar termo de mineração no padrão da lista: minúsculas, sem acento, "termo | categoria" (categoria opcional).
// Acrescenta no fim da lista e já salva.
function adicionarTermo() {
  const ta = document.querySelector('textarea[name="search_terms"]');
  const termo = $('#nt-termo').value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[|\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
  const cat = $('#nt-cat').value;
  const msg = (t, ok) => { $('#nt-msg').textContent = t; $('#nt-msg').style.color = ok ? 'var(--green)' : 'var(--red)'; };
  if (termo.length < 2) return msg('Digite o termo (pelo menos 2 letras).');
  const linhas = ta.value.split('\n').map(l => l.trim()).filter(Boolean);
  if (linhas.some(l => l.split('|')[0].trim().toLowerCase() === termo)) return msg(`"${termo}" já está na lista.`);
  linhas.push(cat ? `${termo} | ${cat}` : termo);
  ta.value = linhas.join('\n');
  ta.scrollTop = ta.scrollHeight;
  $('#nt-termo').value = '';
  msg(`"${termo}" adicionado. Salvando…`, true);
  contarTermos();
  ta.closest('form').requestSubmit();
}
$('#nt-add').addEventListener('click', adicionarTermo);
$('#nt-termo').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); adicionarTermo(); } });

// ── Configurações ─────────────────────────────────────────────────────────────
async function loadSettings() {
  SETTINGS = await api('/api/admin/settings');
  if (typeof updateRedirectUri === 'function') updateRedirectUri();
  $$('.settings-form').forEach(form => {
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.dataset.secret !== undefined) {
        el.value = '';
        el.placeholder = SETTINGS[`${el.name}_set`] ? '•••••••• (configurado — deixe vazio para manter)' : 'não configurado';
      } else if (el.type === 'checkbox' && el.dataset.setting !== undefined) {
        el.checked = SETTINGS[el.name] === '1';
      } else if (el.name in SETTINGS) {
        el.value = SETTINGS[el.name];
      }
    }
  });
  let redesAgenda = [];
  try { redesAgenda = JSON.parse(SETTINGS.agenda_redes || '[]'); } catch { /* vazio */ }
  $$('[data-agenda-rede]').forEach(c => { c.checked = redesAgenda.includes(c.dataset.agendaRede); });
  if (typeof updateWaProvider === 'function') updateWaProvider();
  contarTermos();
  if ($('#modelo-texto') && !$('#modelo-texto').value.trim() && window.OfertouModelo) $('#modelo-texto').value = OfertouModelo.PADRAO; // vazio = padrão: mostra o texto dele
  previaModelo();
  carregarGruposConvite();
  carregarGrupoAutomacao();
}

// Grupo de automação
async function carregarGrupoAutomacao() {
  if (!$('#ga-grupo')) return;
  try {
    const d = await api('/api/admin/grupo-automacao');
    $('#ga-ajuda').textContent = d.ajuda.replace(/\*/g, '');
    const sel = $('#ga-grupo');
    if (d.controle && ![...sel.options].some(o => o.value === d.controle)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(d.controle)}">${esc(d.controle)} (escolhido)</option>`);
    sel.value = d.controle;
  } catch { /* sem permissão */ }
}
$('#ga-carregar')?.addEventListener('click', async () => {
  $('#ga-msg').textContent = 'Carregando os grupos do número…';
  try {
    const d = await api('/api/admin/whatsapp/grupos');
    const atual = SETTINGS.wa_grupo_controle || '';
    $('#ga-grupo').innerHTML = '<option value="">— escolha o grupo de automação —</option>' + d.grupos.map(g => `<option value="${esc(g.id)}" ${g.id === atual ? 'selected' : ''}>${esc(g.nome)}</option>`).join('');
    $('#ga-msg').textContent = `${d.grupos.length} grupo(s). Escolha um e clique em Salvar grupo.`;
  } catch (err) { $('#ga-msg').textContent = err.message; }
});
// Teste da Capi
$('#capi-perguntar')?.addEventListener('click', async () => {
  const q = $('#capi-pergunta').value.trim();
  if (!q) return;
  try {
    const r = await api('/api/admin/capi/perguntar', { method: 'POST', body: { texto: q } });
    $('#capi-resposta').hidden = false;
    $('#capi-resposta').textContent = r.texto ? `[${r.confianca === 'alta' ? 'certeza alta' : r.confianca === 'media' ? 'certeza média' : 'não sabe'}]\n\n${r.texto}` : '[não sabe] Não encontrou no Guia do usuário: no SAC, ela oferece um atendente.';
  } catch (err) { globalMsg(err.message, false); }
});
$('#capi-pergunta')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#capi-perguntar').click(); } });

// Barra do topo: colar link → gera o link de afiliado (e pode virar oferta manual); texto → busca a oferta no site
$('#top-busca').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('#top-busca-q').value.trim(), box = $('#top-busca-res');
  if (!q) return;
  if (!/^https?:\/\//i.test(q)) { window.open(`/?q=${encodeURIComponent(q)}`, '_blank'); return; }
  box.hidden = false; box.innerHTML = '<p class="hint" style="margin:0">Gerando o link…</p>';
  try {
    const d = await api('/api/postagens/converter', { method: 'POST', body: { url: q } });
    box.innerHTML = `<div><span class="hint" style="margin:0">${esc(d.loja)} · link de afiliado do site</span><code>${esc(d.link)}</code>${d.aviso ? `<span class="hint" style="margin:0;color:var(--yellow)">${esc(d.aviso)}</span>` : ''}</div>
      <div class="row"><button class="btn primary small" type="button" data-tb="copiar">Copiar link</button>
      <button class="btn small" type="button" data-tb="manual">Adicionar como oferta manual</button>
      <button class="btn small" type="button" data-tb="fechar">Fechar</button></div>`;
    box.onclick = ev => {
      const a = ev.target.closest('[data-tb]')?.dataset.tb;
      if (a === 'copiar') navigator.clipboard.writeText(d.link).then(() => globalMsg('Link copiado.'));
      if (a === 'manual') {
        document.querySelector('[data-tab="offers"]').click();
        const f = $('#manual-form'); f.url.value = q; f.scrollIntoView({ behavior: 'smooth', block: 'start' }); f.querySelector('input:not([name=url])')?.focus();
        box.hidden = true;
      }
      if (a === 'fechar') { box.hidden = true; $('#top-busca-q').value = ''; }
    };
  } catch (err) { box.innerHTML = `<p class="hint" style="margin:0;color:var(--red)">${esc(err.message)}</p>`; }
});
$('#top-busca-q').addEventListener('paste', () => setTimeout(() => { if (/^https?:\/\//i.test($('#top-busca-q').value.trim())) $('#top-busca').requestSubmit(); }, 50));
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !$('#app').classList.contains('hidden')) { e.preventDefault(); $('#top-busca-q').focus(); }
  if (e.key === 'Escape') $('#top-busca-res').hidden = true;
});
document.addEventListener('click', e => { if (!e.target.closest('.top-busca-area')) $('#top-busca-res').hidden = true; });

// Modelo da mensagem: prévia com uma oferta de exemplo
const EXEMPLO_MODELO = { produto: 'Air Fryer Mondial 4L Family Inox', preco_de: '499,90', preco: '289,90', desconto: '42', economia: '210,00',
  loja: 'Mercado Livre', link: 'https://tanoofertou.com.br/o/123456', cupom: 'OFERTOU10', conferido: '26/10, 09:30' };
function previaModelo() {
  if (!$('#modelo-previa') || !window.OfertouModelo) return;
  $('#modelo-previa').textContent = OfertouModelo.aplicar($('#modelo-texto').value, EXEMPLO_MODELO);
  montarModelos();
}
document.addEventListener('input', e => { if (e.target.id === 'modelo-texto') previaModelo(); });

  // Os 3 modelos prontos: cartões com a prévia; tocar num deles coloca o texto na caixa (depois é só salvar)
  function montarModelos() {
    const box = document.getElementById('modelos-escolha');
    if (!box || !window.OfertouModelo) return;
    const atual = (document.getElementById('modelo-texto').value || '').trim();
    const escolhido = OfertouModelo.MODELOS.find(m => m.texto.trim() === atual || (!atual && m.id === 'padrao'));
    box.innerHTML = OfertouModelo.MODELOS.map(m => `<button type="button" class="modelo-card${escolhido && escolhido.id === m.id ? ' on' : ''}" role="radio" aria-checked="${escolhido && escolhido.id === m.id}" data-modelo="${m.id}">
      <span class="modelo-card-tit">${m.nome}${escolhido && escolhido.id === m.id ? ' <em>em uso</em>' : ''}</span><span class="modelo-card-desc">${m.desc}</span>
      <span class="modelo-card-ex">${OfertouModelo.aplicar(m.texto, EXEMPLO_MODELO).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span></button>`).join('')
      + (atual && !escolhido ? '<p class="modelo-proprio">✏️ Você está usando um modelo próprio (editado).</p>' : '');
  }
  document.addEventListener('click', e => {
    const c = e.target.closest('[data-modelo]');
    if (!c) return;
    const m = OfertouModelo.MODELOS.find(x => x.id === c.dataset.modelo);
    document.getElementById('modelo-texto').value = m.texto;
    previaModelo(); montarModelos();
  });


// Página do grupo: contagem de entradas de cada link
async function carregarGruposConvite(d) {
  if (!$('#grupos-convite-body')) return;
  $('#grupo-endereco').textContent = `${(SETTINGS.site_url || location.origin).replace(/\/+$/, '')}/grupo`;
  try {
    const { grupos } = d || await api('/api/admin/grupos-convite');
    $('#grupos-convite-body').innerHTML = grupos.length ? grupos.map(g => `<tr><td><b>${esc(g.nome)}</b><br><span class="hint" style="margin:0">${esc(g.link)}</span></td>
      <td class="num">${g.entradas.toLocaleString('pt-BR')}</td><td class="num">${g.limite ? g.limite.toLocaleString('pt-BR') : 'sem limite'}</td>
      <td>${g.lotado ? '<span class="badge b-banned">Lotado</span>' : '<span class="badge b-active">Recebendo</span>'}</td></tr>`).join('')
      : '<tr><td colspan="4" class="hint">Nenhum grupo cadastrado (use links https://chat.whatsapp.com/… ou https://t.me/…).</td></tr>';
  } catch { /* sem permissão */ }
}
$('#grupos-zerar')?.addEventListener('click', async () => {
  if (!await OfertouUI.confirmar('Zerar a contagem de entradas de todos os grupos? O rodízio recomeça do primeiro grupo.', { ok: 'Zerar' })) return;
  try { carregarGruposConvite(await api('/api/admin/grupos-convite/zerar', { method: 'POST' })); globalMsg('Contagem zerada.'); } catch (err) { globalMsg(err.message, false); }
});

// Quantos termos estão cadastrados (e quanto tempo a mineração leva para passar por todos)
function contarTermos() {
  const ta = document.querySelector('textarea[name="search_terms"]');
  if (!ta) return;
  const linhas = ta.value.split('\n').map(l => l.trim()).filter(Boolean);
  const unicos = new Set(linhas.map(l => l.split('|')[0].trim().toLowerCase()));
  const comCat = linhas.filter(l => l.includes('|')).length;
  $('#termos-total').textContent = `${linhas.length.toLocaleString('pt-BR')} ${linhas.length === 1 ? 'termo' : 'termos'}`;
  const form = ta.closest('form');
  const porRodada = Math.max(1, Number(form.mining_terms_per_run?.value) || 60);
  const intervalo = Math.max(1, Number(form.mining_interval_min?.value) || 120);
  const rodadas = Math.ceil(linhas.length / porRodada);
  const horas = (rodadas * intervalo) / 60;
  $('#termos-ciclo').textContent = linhas.length
    ? `${comCat.toLocaleString('pt-BR')} com categoria · ${(linhas.length - comCat).toLocaleString('pt-BR')} automáticos${unicos.size < linhas.length ? ` · ${linhas.length - unicos.size} repetido(s)` : ''} · ${rodadas} rodada(s) de ${porRodada} para passar por todos (cerca de ${horas < 1 ? `${Math.round(horas * 60)} min` : `${horas.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} h`}).`
    : 'Nenhum termo cadastrado.';
}
document.addEventListener('input', e => {
  if (e.target.matches('textarea[name="search_terms"], input[name="mining_terms_per_run"], input[name="mining_interval_min"]')) contarTermos();
});

$$('.settings-form').forEach(form => form.addEventListener('submit', async e => {
  e.preventDefault();
  const body = {};
  for (const el of form.elements) if (el.name) body[el.name] = el.type === 'checkbox' && el.dataset.setting !== undefined ? (el.checked ? '1' : '0') : el.value;
  const storeChecks = $$('#enabled-stores input', form);
  if (storeChecks.length) body.stores_enabled = Object.fromEntries(storeChecks.map(c => [c.dataset.store, c.checked]));
  const agendaRedes = $$('[data-agenda-rede]', form);
  if (agendaRedes.length) body.agenda_redes = agendaRedes.filter(c => c.checked).map(c => c.dataset.agendaRede);
  try {
    const r = await api('/api/admin/settings', { method: 'PUT', body });
    globalMsg(r.refreshed ? `Salvo! ${r.refreshed} links de afiliado atualizados.` : 'Configurações salvas!');
    if (form.closest('[data-body="planos"]')) loadPedidos();
    await loadSettings();
  } catch (err) { globalMsg(err.message, false); }
}));

// ── Ofertas ───────────────────────────────────────────────────────────────────
let offerPage = 1;
async function loadOffers() {
  const params = new URLSearchParams({ q: $('#f-q').value, store: $('#f-store').value, state: $('#f-state').value, page: offerPage });
  const data = await api(`/api/admin/offers?${params}`);
  $('#offers-body').innerHTML = data.rows.length ? data.rows.map(o => `
    <tr>
      <td><img class="offer-img" src="/api/img/${o.id}" alt="" loading="lazy"></td>
      <td><div class="offer-title" title="${esc(o.produto)}">${esc(o.produto)}</div>
        <span class="tag">${o.fonte === 'manual' ? 'manual' : 'automática'}</span> <span class="tag">${esc(o.categoria)}${o.subcategoria ? ' · ' + esc(o.subcategoria) : ''}</span>
        ${o.oculto ? '<span class="tag">oculta</span>' : o.ativo ? '' : '<span class="tag">expirada</span>'}</td>
      <td class="num"><b>${brl(o.preco_atual)}</b><br><span class="old">${brl(o.preco_anterior)}</span> <b style="color:var(--green)">-${o.desconto_pct}%</b></td>
      <td class="hide-sm">${esc(o.plataforma)}</td>
      <td class="hide-sm num">${fmtDate(o.last_seen_at)}</td>
      <td class="hide-sm">${o.link_clicks}</td>
      <td class="num">
        <a class="btn small" href="${esc(o.affiliate_url || o.original_url)}" target="_blank" rel="noopener" title="Abrir link de afiliado">↗</a>
        <button class="btn small" data-act="toggle" data-id="${o.id}" data-hidden="${o.oculto}">${o.oculto ? 'Mostrar' : 'Ocultar'}</button>
        <button class="btn small danger" data-act="del" data-id="${o.id}">Excluir</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="7" class="hint">Nenhuma oferta nesta lista.</td></tr>';
  const pages = Math.max(1, Math.ceil(data.total / data.perPage));
  $('#pager').innerHTML = `${data.total} ofertas · página ${data.page} de ${pages}
    <button class="btn small" ${data.page <= 1 ? 'disabled' : ''} data-page="${data.page - 1}">←</button>
    <button class="btn small" ${data.page >= pages ? 'disabled' : ''} data-page="${data.page + 1}">→</button>`;
}

$('#pager').addEventListener('click', e => {
  const p = e.target.dataset.page;
  if (p) { offerPage = Number(p); loadOffers(); }
});
let qTimer;
$('#f-q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { offerPage = 1; loadOffers(); }, 300); });
$('#f-store').addEventListener('change', () => { offerPage = 1; loadOffers(); });
$('#f-state').addEventListener('change', () => { offerPage = 1; loadOffers(); });

$('#offers-body').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  try {
    if (btn.dataset.act === 'toggle') {
      await api(`/api/admin/offers/${id}`, { method: 'PATCH', body: { oculto: btn.dataset.hidden !== '1' } });
    } else if (btn.dataset.act === 'del') {
      if (!await OfertouUI.confirmar('Excluir esta oferta do banco? Se ela aparecer de novo na loja, será minerada novamente.')) return;
      await api(`/api/admin/offers/${id}`, { method: 'DELETE' });
    }
    loadOffers();
  } catch (err) { globalMsg(err.message, false); }
});

$('#manual-form').addEventListener('submit', async e => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  try {
    await api('/api/admin/offers', { method: 'POST', body });
    globalMsg('Oferta adicionada e já está no ar!');
    e.target.reset();
    e.target.dias.value = SETTINGS.manual_offer_days || 3;
    loadOffers();
  } catch (err) { globalMsg(err.message, false); }
});

// ── Conta ─────────────────────────────────────────────────────────────────────
$('#pass-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  if (f.next.value !== f.confirm.value) return globalMsg('As senhas novas não conferem.', false);
  try { await api('/api/admin/password', { method: 'POST', body: { current: f.current.value, next: f.next.value } }); f.reset(); globalMsg('Senha alterada!'); }
  catch (err) { globalMsg(err.message, false); }
});

boot().catch(err => { document.body.innerHTML = `<p style="padding:20px">Erro ao abrir o painel: ${esc(err.message)}</p>`; });

// ── Usuários do site ──────────────────────────────────────────────────────────
const U_STATUS = { onboarding: 'Cadastro incompleto', pending: 'Aguardando aprovação', active: 'Ativo', suspended: 'Suspenso', banned: 'Banido', rejected: 'Recusado' };
let userPage = 1;

async function loadUsers() {
  const params = new URLSearchParams({ q: $('#u-q').value, tipo: $('#u-tipo').value, status: $('#u-status').value, page: userPage });
  const data = await api(`/api/admin/users?${params}`);
  setPendingBadge(data.pending);
  $('#users-body').innerHTML = data.rows.length ? data.rows.map(u => `
    <tr>
      <td><b>${esc(u.tipo === 'empresa' ? (u.empresa_nome || u.nome) : u.nome)}</b><br><span class="hint" style="margin:0">${emailUsuario(u)}</span></td>
      <td>${tipoLabel(u.tipo)}</td>
      <td><span class="badge b-${u.status}">${esc(U_STATUS[u.status] || u.status)}</span>${u.bloqueio_publicacao ? ' <span class="tag">sem publicar</span>' : ''}${u.pode_postar ? ' <span class="tag">posta nas redes</span>' : ''}${u.pode_sac ? ' <span class="tag">atendente SAC</span>' : ''}</td>
      <td class="hide-sm">${u.loja_nome ? `<a href="/loja/${esc(u.loja_slug)}" target="_blank">${esc(u.loja_nome)}</a>${u.loja_oculta ? ' <span class="tag">oculta</span>' : ''}<br><span class="hint" style="margin:0">${u.produtos} produto(s)</span>` : '—'}</td>
      <td class="hide-sm num">${fmtDate(u.created_at)}</td>
      <td class="num">
        ${u.status === 'pending' ? `<button class="btn small primary" data-uact="aprovar" data-id="${u.id}">Aprovar</button> <button class="btn small danger" data-uact="recusar" data-id="${u.id}">Recusar</button>` : ''}
        <button class="btn small" data-uopen="${u.id}">Gerenciar</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="6" class="hint">Nenhum usuário encontrado.</td></tr>';
  const pages = Math.max(1, Math.ceil(data.total / data.perPage));
  $('#users-pager').innerHTML = `${data.total} usuário(s) · página ${data.page} de ${pages}
    <button class="btn small" ${data.page <= 1 ? 'disabled' : ''} data-upage="${data.page - 1}">←</button>
    <button class="btn small" ${data.page >= pages ? 'disabled' : ''} data-upage="${data.page + 1}">→</button>`;
}

const tipoLabel = t => ({ empresa: 'Empresa', consumidor: 'Consumidor', afiliado: 'Usuário da ferramenta' }[t] || 'Não escolhido');

// Endereço de retorno do Google, para copiar e colar no Google Cloud.
function updateRedirectUri() {
  const base = (SETTINGS.site_url || location.origin).replace(/\/+$/, '');
  $('#google-redirect').textContent = `${base}/auth/google/callback`;
}
$('#copy-redirect').addEventListener('click', () => navigator.clipboard.writeText($('#google-redirect').textContent).then(() => globalMsg('Endereço copiado.')));

function setPendingBadge(n) {
  $('#pending-badge').textContent = n;
  $('#pending-badge').classList.toggle('hidden', !n);
}

async function loadModLog() {
  const rows = await api('/api/admin/moderacao');
  $('#mod-log').innerHTML = rows.length ? rows.map(r => `<div><b>${fmtDate(r.created_at)}</b> · ${esc(r.user_email || '—')} · ${esc(r.acao.replace(/_/g, ' '))}${r.detalhe ? ` — ${esc(r.detalhe)}` : ''}</div>`).join('')
    : '<span class="hint">Nenhuma ação registrada.</span>';
}

let uqTimer;
$('#u-q').addEventListener('input', () => { clearTimeout(uqTimer); uqTimer = setTimeout(() => { userPage = 1; loadUsers(); }, 300); });
$('#u-tipo').addEventListener('change', () => { userPage = 1; loadUsers(); });
$('#u-status').addEventListener('change', () => { userPage = 1; loadUsers(); });
$('#users-pager').addEventListener('click', e => { const p = e.target.dataset.upage; if (p) { userPage = Number(p); loadUsers(); } });

// Executa uma ação de moderação, pedindo motivo/dias quando faz sentido.
async function userAction(id, acao) {
  const body = { acao };
  const needsReason = ['recusar', 'suspender', 'banir', 'bloquear_publicacao', 'excluir_publicacoes', 'excluir_loja', 'excluir'];
  if (acao === 'suspender') {
    const dias = await OfertouUI.perguntar('Suspender por quantos dias?', '7');
    if (!dias) return false;
    body.dias = Number(dias);
  }
  if (acao === 'excluir') {
    if (!await OfertouUI.confirmar('Excluir este perfil? A conta, a loja e todos os produtos serão apagados. Não dá para desfazer.')) return false;
    body.bloquear_email = await OfertouUI.confirmar('Bloquear também este e-mail para que não possa se cadastrar de novo?');
  }
  if (acao === 'excluir_publicacoes' && !await OfertouUI.confirmar('Excluir TODOS os produtos publicados por este usuário?')) return false;
  if (acao === 'excluir_loja' && !await OfertouUI.confirmar('Excluir a loja deste usuário? A página da loja, os produtos, os catálogos e as avaliações serão apagados. A conta continua existindo. Não dá para desfazer.')) return false;
  if (acao === 'banir' && !await OfertouUI.confirmar('Banir este usuário? Ele perde o acesso e a loja sai do ar.')) return false;
  if (needsReason.includes(acao)) {
    const motivo = await OfertouUI.perguntar('Motivo (aparece para o usuário quando aplicável):', '');
    if (motivo === null) return false;
    body.motivo = motivo;
  }
  await api(`/api/admin/users/${id}/acao`, { method: 'POST', body });
  return true;
}

$('#users-body').addEventListener('click', async e => {
  const act = e.target.closest('[data-uact]');
  const open = e.target.closest('[data-uopen]');
  try {
    if (act && await userAction(act.dataset.id, act.dataset.uact)) { globalMsg('Feito.'); loadUsers(); loadModLog(); }
    if (open) openUser(open.dataset.uopen);
  } catch (err) { globalMsg(err.message, false); }
});

function fmtDoc(v, tipo) {
  if (!v) return '—';
  return tipo === 'cpf'
    ? v.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
    : v.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
}
function fmtPhone(v) {
  if (!v) return '—';
  const n = v.slice(2);
  const tel = `(${v.slice(0, 2)}) ${n.length > 8 ? `${n.slice(0, 5)}-${n.slice(5)}` : `${n.slice(0, 4)}-${n.slice(4)}`}`;
  return `${esc(tel)} <a href="https://wa.me/55${esc(v)}" target="_blank" rel="noopener">WhatsApp</a>`;
}
function fmtBirth(v) {
  if (!v) return '—';
  const [y, m, d] = v.split('-');
  const age = Math.floor((Date.now() - new Date(`${v}T00:00:00Z`)) / 31557600000);
  return `${d}/${m}/${y} (${age} anos)`;
}
function fmtAddr(u, p) {
  if (!u[`${p}logradouro`]) return '—';
  const cep = String(u[`${p}cep`] || '').replace(/(\d{5})(\d{3})/, '$1-$2');
  return esc(`${u[`${p}logradouro`]}, ${u[`${p}numero`]}${u[`${p}complemento`] ? ` — ${u[`${p}complemento`]}` : ''}, ${u[`${p}bairro`]}, ${u[`${p}cidade`]}/${u[`${p}uf`]} — CEP ${cep}`);
}

// Caixa "Plano" da ficha do usuário
function ligarPlano(u, preencher, l) {
  preencher();
  $('#ud-validade').onchange = () => { $('#ud-ate-campo').hidden = $('#ud-validade').value !== 'data'; };
  $('#ud-plano-aplicar').onclick = async () => {
    const plano = $('#ud-plano').value, validade = $('#ud-validade').value, ate = $('#ud-ate').value;
    const nome = $('#ud-plano').selectedOptions[0]?.textContent.split(' — ')[0] || 'sem plano';
    const p = (PLANOS_UD || []).find(x => x.id === plano);
    const NOMES = { consumidor: 'consumidor', empresa: 'empresa', afiliado: 'usuário da ferramenta' };
    const novoTipo = !p ? u.tipo : p.conta !== 'usuario' ? 'afiliado' : (u.tipo && p.perfis.includes(u.tipo) ? u.tipo : p.perfil);
    const muda = p && u.tipo && novoTipo !== u.tipo
      ? ` A conta passa de ${NOMES[u.tipo] || u.tipo} para ${NOMES[novoTipo] || novoTipo}${u.tipo === 'empresa' && l ? ' e a loja sai do ar (nada é apagado; volta se a conta voltar a ser empresa)' : ''}.` : '';
    if (!await OfertouUI.confirmar(plano ? `Trocar o plano desta conta para "${nome}"?${muda}` : 'Tirar o plano desta conta?')) return;
    const b = $('#ud-plano-aplicar'); b.disabled = true;
    try {
      await api(`/api/admin/users/${u.id}/plano`, { method: 'POST', body: { plano, validade, ate } });
      globalMsg(plano ? `Plano trocado para ${nome}.${muda ? ' Tipo da conta atualizado.' : ''}` : 'Plano removido.');
      openUser(u.id); loadUsers(); loadModLog();
    } catch (err) { $('#ud-plano-msg').textContent = err.message; $('#ud-plano-msg').style.color = 'var(--red)'; b.disabled = false; }
  };
}

let PLANOS_UD = []; // planos carregados na ficha do usuário (para avisar se a conta muda de tipo)
// Cadastro rápido ainda sem e-mail: o endereço guardado é provisório (.invalid); mostra o celular no lugar
const emailUsuario = u => (/\.invalid$/i.test(u.email || '') ? `<i>sem e-mail · cadastro rápido</i>${u.telefone ? ` · ${esc(u.telefone)}` : ''}` : esc(u.email));
// Moedas do usuário (ficha → quadro "Moedas da Loja de cosméticos")
document.addEventListener('click', async e => {
  const b = e.target.closest('#ud-moedas-aplicar');
  if (!b) return;
  const caixa = b.closest('[data-moedas-uid]'), msg = $('#ud-moedas-msg');
  const valor = parseInt($('#ud-moedas-valor').value, 10);
  if (!Number.isFinite(valor) || valor < 0) { msg.textContent = 'Informe a quantidade de moedas.'; msg.style.color = 'var(--red)'; return; }
  b.disabled = true;
  try {
    const r = await api(`/api/admin/users/${caixa.dataset.moedasUid}/moedas`, { method: 'POST',
      body: { modo: $('#ud-moedas-modo').value, valor, motivo: $('#ud-moedas-motivo').value } });
    $('#ud-moedas-saldo').textContent = Number(r.moedas).toLocaleString('pt-BR');
    $('#ud-moedas-valor').value = ''; $('#ud-moedas-motivo').value = '';
    msg.textContent = 'Saldo salvo.'; msg.style.color = 'var(--green)';
  } catch (err) { msg.textContent = err.message; msg.style.color = 'var(--red)'; }
  b.disabled = false;
});

async function openUser(id) {
  const d = await api(`/api/admin/users/${id}`);
  const u = d.user, l = d.loja;
  $('#ud-title').textContent = u.tipo === 'empresa' ? (u.empresa_nome || u.nome) : u.nome;
  const btn = (acao, label, cls = '') => `<button class="btn small ${cls}" data-dact="${acao}">${label}</button>`;
  const actions = [];
  if (u.status === 'pending') actions.push(btn('aprovar', 'Aprovar cadastro', 'primary'), btn('recusar', 'Recusar cadastro', 'danger'));
  if (u.status === 'active') actions.push(btn('suspender', 'Suspender (punir)'), btn('banir', 'Banir', 'danger'));
  if (u.status === 'active') actions.push(u.pode_postar ? btn('remover_postagens', 'Tirar permissão de postagens') : btn('permitir_postagens', 'Permitir postagens nas redes', 'primary'));
  if (u.status === 'active') actions.push(u.pode_sac ? btn('remover_sac', 'Tirar de atendente do SAC') : btn('permitir_sac', 'Permitir atender o SAC', 'primary'));
  if (['suspended', 'banned', 'rejected'].includes(u.status)) actions.push(btn('reativar', 'Reativar conta', 'primary'));
  if (u.tipo === 'empresa') {
    actions.push(u.bloqueio_publicacao ? btn('liberar_publicacao', 'Liberar publicações') : btn('bloquear_publicacao', 'Impedir de publicar'));
    if (d.produtos.length) actions.push(btn('excluir_publicacoes', 'Excluir todas as publicações', 'danger'));
    if (d.loja) actions.push(btn('excluir_loja', 'Excluir loja', 'danger'));
  }
  actions.push(btn('excluir', 'Excluir perfil', 'danger'));

  const preencherPlano = async () => {
    const atualP = u.plano ? `${esc(u.plano)}` : 'sem plano';
    const vence = !u.assinatura_ate ? '' : u.assinatura_ate.startsWith('9999') ? ' · sem vencimento' : ` · vence em ${new Date(u.assinatura_ate.replace(' ', 'T') + 'Z').toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}${u.assinatura_ate < new Date().toISOString().replace('T', ' ') ? ' (vencido)' : ''}`;
    try {
      const pl = (await api('/api/admin/planos')).planos; PLANOS_UD = pl;
      const nome = id => pl.find(p => p.id === id)?.nome || id;
      $('#ud-plano-atual').textContent = (u.plano ? nome(u.plano) : 'sem plano') + vence;
      $('#ud-plano').innerHTML = '<option value="">Sem plano</option>' + pl.map(p => `<option value="${esc(p.id)}" ${p.id === u.plano ? 'selected' : ''}>${esc(p.nome)} — ${p.gratis ? 'grátis' : brl(p.preco)}${p.sem_vencimento ? ' · sem vencimento' : ` · ${p.dias} dias`} · ${esc(p.tipo_nome)}${p.ativo ? '' : ' (fora de venda)'}</option>`).join('');
    } catch (err) { $('#ud-plano-atual').textContent = atualP + vence; $('#ud-plano-msg').textContent = err.message; }
  };
  $('#ud-body').innerHTML = `
    <dl class="kv">
      <dt>Tipo</dt><dd>${tipoLabel(u.tipo)}</dd>
      <dt>Nome completo</dt><dd>${esc(u.nome)}</dd>
      <dt>CPF</dt><dd>${fmtDoc(u.cpf, 'cpf')}</dd>
      <dt>Nascimento</dt><dd>${fmtBirth(u.data_nascimento)}</dd>
      <dt>E-mail</dt><dd>${emailUsuario(u)}</dd>
      <dt>Celular</dt><dd>${fmtPhone(u.telefone)}</dd>
      <dt>Endereço</dt><dd>${fmtAddr(u, '')}</dd>
      ${u.tipo === 'empresa' ? `
      <dt>Tipo de loja</dt><dd>${u.empresa_tipo === 'pf' ? 'Pessoa física (vende com o CPF)' : 'Pessoa jurídica (CNPJ)'}</dd>
      <dt>Razão social</dt><dd>${esc(u.razao_social || '—')}</dd>
      <dt>Nome fantasia</dt><dd>${esc(u.empresa_nome || '—')}</dd>
      <dt>CNPJ</dt><dd>${fmtDoc(u.cnpj, 'cnpj')}</dd>
      <dt>Inscrição estadual</dt><dd>${esc(u.inscricao_estadual || '—')}</dd>
      <dt>Telefone da empresa</dt><dd>${fmtPhone(u.telefone_empresa)}</dd>
      <dt>Ramo</dt><dd>${esc(u.ramo || '—')}</dd>
      <dt>Site</dt><dd>${u.site_empresa ? `<a href="${esc(u.site_empresa)}" target="_blank" rel="noopener nofollow">${esc(u.site_empresa)}</a>` : '—'}</dd>
      <dt>Endereço da empresa</dt><dd>${fmtAddr(u, 'emp_')}</dd>` : ''}
      <dt>Aceite dos termos</dt><dd>${fmtDate(u.aceite_termos_em)}${u.aceite_versao ? ` · versão ${esc(u.aceite_versao)}` : ''}</dd>
      <dt>Aceites (LGPD, Termos e Termos do Parceiro)</dt><dd>${fmtDate(u.aceite_privacidade_em)}${(d.consentimentos || []).length ? `<br><span class="hint" style="margin:0">${d.consentimentos.map(c => `${fmtDate(c.created_at)} · ${esc(c.origem)} · versão ${esc(c.versao)}${c.parceiro ? ` · Termos do Parceiro (${esc(c.parceiro.replace(',', ' e '))})` : ''} · IP ${esc(c.ip || '—')}`).join('<br>')}</span>` : ''}</dd>
      <dt>Situação</dt><dd><span class="badge b-${u.status}">${esc(U_STATUS[u.status])}</span>
        ${u.suspenso_ate ? ` até ${fmtDate(u.suspenso_ate)}` : ''}${u.status_motivo ? ` — ${esc(u.status_motivo)}` : ''}
        ${u.bloqueio_publicacao ? ' <span class="tag">impedido de publicar</span>' : ''}
        ${u.pode_postar ? ' <span class="tag">pode postar nas redes</span>' : ''}</dd>
      <dt>Cadastro</dt><dd>${fmtDate(u.created_at)}</dd>
      <dt>Último acesso</dt><dd>${fmtDate(u.last_login_at)}</dd>
    </dl>
    <div class="mod-actions">${actions.join('')}</div>
    <div class="store-card plano-box" data-uid="${u.id}">
      <h4>Plano</h4>
      <p class="hint" style="margin:2px 0 10px">Atual: <b id="ud-plano-atual">…</b></p>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">
        <label class="field">Trocar para <select id="ud-plano"><option value="">Carregando planos…</option></select></label>
        <label class="field">Validade <select id="ud-validade">
          <option value="plano">Duração do plano (a partir de hoje)</option>
          <option value="sem">Sem vencimento</option>
          <option value="data">Até uma data…</option></select></label>
        <label class="field" id="ud-ate-campo" hidden>Vence em <input type="date" id="ud-ate"></label>
      </div>
      <div class="row" style="margin-top:10px;gap:8px"><button class="btn primary small" type="button" id="ud-plano-aplicar">Aplicar plano</button>
        <span class="hint" style="margin:0" id="ud-plano-msg"></span></div>
    </div>
    <div class="store-card" data-moedas-uid="${u.id}">
      <h4>Moedas da Loja de cosméticos</h4>
      <p class="hint" style="margin:2px 0 10px">Saldo atual: <b id="ud-moedas-saldo">${Number(d.moedas || 0).toLocaleString('pt-BR')}</b> moedas</p>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px">
        <label class="field">O que fazer <select id="ud-moedas-modo">
          <option value="somar">Adicionar moedas</option>
          <option value="tirar">Tirar moedas</option>
          <option value="definir">Definir o saldo exato</option></select></label>
        <label class="field">Quantidade <input type="number" id="ud-moedas-valor" min="0" max="10000000" step="1" placeholder="Ex.: 500"></label>
        <label class="field">Motivo (aparece no extrato da pessoa) <input type="text" id="ud-moedas-motivo" maxlength="80" placeholder="Ex.: Prêmio do sorteio"></label>
      </div>
      <div class="row" style="margin-top:10px;gap:8px"><button class="btn primary small" type="button" id="ud-moedas-aplicar">Salvar saldo</button>
        <span class="hint" style="margin:0" id="ud-moedas-msg"></span></div>
    </div>
    ${l ? `
      <div class="store-card">
        <h4>Loja: ${esc(l.nome)} ${l.oculta ? '<span class="badge b-banned">Oculta</span>' : '<span class="badge b-active">Visível</span>'}</h4>
        <div class="hint" style="margin:4px 0 8px">
          <a href="/loja/${esc(l.slug)}" target="_blank">/loja/${esc(l.slug)}</a>
          ${l.site_url ? ` · site: ${esc(l.site_url)}` : ''}
          ${l.feed_url ? `<br>Importação: ${esc(l.feed_url)} (${esc(l.feed_status || '—')}${l.feed_mensagem ? `: ${esc(l.feed_mensagem)}` : ''})` : ''}
        </div>
        <div class="mod-actions">
          <button class="btn small" data-lhide="${l.id}" data-oculta="${l.oculta ? 0 : 1}">${l.oculta ? 'Mostrar loja' : 'Ocultar loja'}</button>
          ${l.feed_url ? `<button class="btn small" data-lsync="${l.id}">Sincronizar importação</button>` : ''}
        </div>
      </div>` : ''}
    ${d.produtos.length ? `
      <div>
        <h4 style="margin:0 0 8px">Publicações (${d.produtos.length})</h4>
        <div class="table-wrap"><table>
          <thead><tr><th>Produto</th><th>Preço</th><th class="hide-sm">Origem</th><th>Situação</th><th></th></tr></thead>
          <tbody>${d.produtos.map(p => `<tr>
            <td><div class="offer-title">${esc(p.produto)}</div></td>
            <td class="num"><span class="old">${brl(p.preco_anterior)}</span><br><b>${brl(p.preco_atual)}</b> -${p.desconto_pct}%</td>
            <td class="hide-sm">${p.fonte === 'feed' ? 'importado' : 'manual'}</td>
            <td>${p.oculto ? '<span class="tag">oculto</span>' : p.no_prazo ? 'no ar' : '<span class="tag">expirado</span>'}</td>
            <td class="num"><a class="btn small" href="${esc(p.affiliate_url)}" target="_blank" rel="noopener">↗</a>
              <button class="btn small" data-phide="${p.id}" data-hidden="${p.oculto}">${p.oculto ? 'Mostrar' : 'Ocultar'}</button>
              <button class="btn small danger" data-pdel="${p.id}">Excluir</button></td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>` : ''}
    ${(() => {
      const a = d.atividade || {};
      const m = a.metricas;
      return `${m ? `<div class="store-card"><h4>Números da loja</h4><dl class="kv">
          <dt>Compras finalizadas pelo site</dt><dd><b>${m.finalizacoes.total}</b> (${brl(m.finalizacoes.valor)}) · ${m.finalizacoes.d30} em 30 dias</dd>
          <dt>Pedidos recebidos</dt><dd>${m.pedidos.total}</dd><dt>Conversas de atendimento</dt><dd>${m.conversas}</dd>
          <dt>Acessos à página</dt><dd>${m.acessos.pagina.total} (${m.acessos.pagina.d30} em 30 dias)</dd>
          <dt>Produtos abertos no catálogo</dt><dd>${m.acessos.produto.total} (${m.acessos.produto.d30} em 30 dias)</dd>
          <dt>Cliques no site oficial</dt><dd>${m.acessos.site.total} · links dos produtos: ${m.acessos.link.total}</dd></dl></div>` : ''}
        ${a.pedidos_recebidos?.length ? `<div><h4 style="margin:0 0 8px">Pedidos recebidos pela loja (${a.pedidos_recebidos.length})</h4><div class="table-wrap"><table><thead><tr><th>Pedido</th><th>Data</th><th>Loja</th><th>Cliente</th><th>Produto</th><th>Total</th><th>Pagamento</th><th>Situação</th></tr></thead><tbody>${linhasPedidos(a.pedidos_recebidos)}</tbody></table></div></div>` : ''}
        <div><h4 style="margin:0 0 8px">Pedidos feitos (${(a.pedidos_feitos || []).length})</h4><div class="table-wrap"><table><thead><tr><th>Pedido</th><th>Data</th><th>Loja</th><th>Cliente</th><th>Produto</th><th>Total</th><th>Pagamento</th><th>Situação</th></tr></thead><tbody>${linhasPedidos(a.pedidos_feitos || [])}</tbody></table></div></div>
        <div><h4 style="margin:0 0 8px">Conversas (${(a.conversas || []).length})</h4><div class="table-wrap"><table><thead><tr><th>Ticket</th><th>Tipo</th><th>De</th><th>Para</th><th>Mensagens</th><th>Situação</th><th>Última</th></tr></thead><tbody>${linhasConversas(a.conversas || [])}</tbody></table></div></div>`;
    })()}
    <div>
      <h4 style="margin:0 0 8px">Histórico</h4>
      <div class="log-list">${d.historico.length ? d.historico.map(h => `<div><b>${fmtDate(h.created_at)}</b> · ${esc(h.acao.replace(/_/g, ' '))}${h.detalhe ? ` — ${esc(h.detalhe)}` : ''}</div>`).join('') : '<span class="hint">Sem registros.</span>'}</div>
    </div>`;
  $('#user-dlg').dataset.id = id;
  ligarPlano(u, preencherPlano, l);
  if (!$('#user-dlg').open) $('#user-dlg').showModal();
}

$('#user-dlg').addEventListener('click', async e => {
  const dlg = $('#user-dlg');
  if (e.target === dlg || e.target.closest('[data-close]')) return dlg.close();
  const id = dlg.dataset.id;
  const b = e.target.closest('button');
  if (!b) return;
  try {
    if (b.dataset.dact) {
      if (!(await userAction(id, b.dataset.dact))) return;
      if (b.dataset.dact === 'excluir') { dlg.close(); loadUsers(); loadModLog(); return globalMsg('Perfil excluído.'); }
    } else if (b.dataset.lhide) {
      const motivo = b.dataset.oculta === '1' ? await OfertouUI.perguntar('Motivo para ocultar a loja (opcional):', '') : '';
      if (motivo === null) return;
      await api(`/api/admin/lojas/${b.dataset.lhide}/visibilidade`, { method: 'POST', body: { oculta: b.dataset.oculta === '1', motivo } });
    } else if (b.dataset.lsync) {
      b.disabled = true; b.textContent = 'Sincronizando…';
      const r = await api(`/api/admin/lojas/${b.dataset.lsync}/sincronizar`, { method: 'POST', body: {} });
      globalMsg(r.error ? `Erro na importação: ${r.error}` : `${r.saved || 0} produto(s) importado(s).`, !r.error);
    } else if (b.dataset.phide) {
      await api(`/api/admin/offers/${b.dataset.phide}`, { method: 'PATCH', body: { oculto: b.dataset.hidden !== '1' } });
    } else if (b.dataset.pdel) {
      if (!await OfertouUI.confirmar('Excluir esta publicação?')) return;
      await api(`/api/admin/offers/${b.dataset.pdel}`, { method: 'DELETE' });
    } else return;
    await openUser(id);
    loadUsers(); loadModLog();
  } catch (err) { globalMsg(err.message, false); }
});

// ── Atendimento: conversas, pedidos às lojas e números das empresas ────────
const ST_PED = { aguardando_pagamento: 'b-pending', pagamento_informado: 'b-pending', pago: 'b-active', enviado: 'b-active', concluido: 'b-active', cancelado: 'b-banned' };
const ST_CONV = { pendente: ['b-pending', 'Pedido de mensagem'], aceita: ['b-active', 'Ativa'], recusada: ['b-none', 'Recusada'], bloqueada: ['b-banned', 'Bloqueada'] };
const linhasPedidos = lista => lista.length ? lista.map(p => `<tr data-tk="pedido" data-id="${p.id}">
    <td><b>${esc(p.codigo)}</b></td><td class="num">${fmtDate(p.created_at)}</td><td>${esc(p.loja.nome || '—')}</td><td>${esc(p.comprador.nome)}</td>
    <td><div class="offer-title">${p.quantidade}x ${esc(p.produto)}</div></td><td class="num">${brl(p.total)}</td><td>${esc(p.metodo_nome)}</td>
    <td><span class="badge ${ST_PED[p.status] || ''}">${esc(p.status_nome)}</span></td></tr>`).join('') : '<tr><td colspan="8" class="hint">Nenhum pedido.</td></tr>';
const linhasConversas = lista => lista.length ? lista.map(c => `<tr data-tk="conversa" data-id="${c.id}">
    <td><b>${esc(c.ticket)}</b></td><td>${c.tipo === 'loja' ? 'Atendimento de loja' : 'Pessoal'}</td><td>${esc(c.a.nome)}</td><td>${esc(c.b.nome)}</td>
    <td class="num">${c.mensagens}</td><td><span class="badge ${(ST_CONV[c.status] || [])[0] || ''}">${esc((ST_CONV[c.status] || [])[1] || c.status)}</span></td>
    <td class="num">${fmtDate(c.ultima_msg_at || c.created_at)}</td></tr>`).join('') : '<tr><td colspan="7" class="hint">Nenhuma conversa.</td></tr>';
async function buscarTicket() {
  const q = $('#at-busca').value.trim();
  const box = $('#at-resultado');
  $('#at-limpar').hidden = !q;
  if (!q) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '<p class="hint">Buscando…</p>';
  const d = await api(`/api/admin/atendimento?q=${encodeURIComponent(q)}`);
  const total = d.pedidos.length + d.conversas.length;
  box.innerHTML = !total ? `<div class="msg err" style="margin:0">Nada encontrado para "${esc(q)}".</div>`
    : `<p class="hint" style="margin:0 0 6px"><b>${d.pedidos.length}</b> pedido(s) e <b>${d.conversas.length}</b> conversa(s) para "${esc(q)}". Clique para abrir.</p>
      ${d.pedidos.length ? `<div class="table-wrap"><table><thead><tr><th>Pedido</th><th>Data</th><th>Loja</th><th>Cliente</th><th>Produto</th><th>Total</th><th>Pagamento</th><th>Situação</th></tr></thead><tbody>${linhasPedidos(d.pedidos)}</tbody></table></div>` : ''}
      ${d.conversas.length ? `<div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Ticket</th><th>Tipo</th><th>De</th><th>Para</th><th>Mensagens</th><th>Situação</th><th>Última</th></tr></thead><tbody>${linhasConversas(d.conversas)}</tbody></table></div>` : ''}`;
  // Um resultado só: abre direto
  if (total === 1) { const tr = box.querySelector('tr[data-tk]'); if (tr) tr.click(); }
}
async function loadAtendimento() {
  const d = await api('/api/admin/atendimento');
  $('#at-lojas').innerHTML = d.lojas.length ? d.lojas.map(l => `<tr>
    <td><a href="/loja/${esc(l.slug)}" target="_blank">${esc(l.nome)}</a>${l.oculta ? ' <span class="tag">oculta</span>' : ''}${l.aceita_pedidos ? '' : ' <span class="tag">sem pedidos</span>'}</td>
    <td class="num"><b>${l.finalizacoes.total}</b> <span class="hint" style="margin:0">(${l.finalizacoes.d30} em 30d)</span></td>
    <td class="num">${brl(l.finalizacoes.valor)}</td><td class="num">${l.pedidos}</td><td class="num">${l.conversas}</td>
    <td class="num">${l.acessos30} / ${l.acessos}</td><td class="num">${l.produtos30}</td><td class="num">${l.site30}</td>
    <td>${l.mp_conectado ? `<span class="badge b-active">Conectado</span>${l.mp_erro ? '<br><span class="hint" style="margin:0">renovação falhou</span>' : ''}` : '<span class="badge b-pending">Não conectado</span>'}</td>
    <td class="num">${l.taxas.total ? `${brl(l.taxas.total)}<br><span class="hint" style="margin:0">${l.taxas.pedidos} pedido(s)</span>` : '—'}</td></tr>`).join('')
    : '<tr><td colspan="10" class="hint">Nenhuma loja cadastrada.</td></tr>';
  const tx = d.taxa;
  $('#taxa-situacao').innerHTML = `Taxa atual: <b>${String(tx.pct).replace('.', ',')}%</b> · Endereço de retorno para cadastrar na aplicação: <code>${esc(tx.retorno)}</code><br>`
    + (tx.gateway_ok ? '<b>Ativo</b>: as lojas já podem conectar o Mercado Pago.'
      : `<b style="color:var(--yellow)">Inativo</b> — ${[!tx.app_ok && 'cole o Client ID e o Client Secret', !tx.site_https && 'publique o site com https (Site → Endereço do site)'].filter(Boolean).join(' e ')}; até lá o botão Fazer pedido não aparece.`);
  $('#at-pedidos').innerHTML = linhasPedidos(d.pedidos);
  $('#at-conversas').innerHTML = linhasConversas(d.conversas);
}
$('#at-form').addEventListener('submit', e => { e.preventDefault(); buscarTicket().catch(err => globalMsg(err.message, false)); });
$('#at-limpar').addEventListener('click', () => { $('#at-busca').value = ''; buscarTicket(); $('#at-busca').focus(); });
$('#at-busca').addEventListener('search', () => { if (!$('#at-busca').value) buscarTicket(); });
async function abrirTicket(tipo, id) {
  const body = $('#tk-body');
  if (tipo === 'conversa') {
    const c = await api(`/api/admin/conversas/${id}`);
    $('#tk-title').textContent = `${c.ticket} — ${c.tipo === 'loja' ? 'Atendimento de loja' : 'Conversa pessoal'}`;
    body.innerHTML = `<dl class="kv"><dt>Iniciada por</dt><dd>${esc(c.a.nome)}${c.a.slug ? ` (<a href="/perfil/${esc(c.a.slug)}" target="_blank">perfil</a>)` : ''}</dd>
      <dt>Para</dt><dd>${esc(c.b.nome)}</dd><dt>Situação</dt><dd>${esc((ST_CONV[c.status] || [])[1] || c.status)}${c.bloqueada_por ? ` por ${esc(c.bloqueada_por)}` : ''}</dd>
      <dt>Criada em</dt><dd>${fmtDate(c.created_at)}</dd>${c.respondida_em ? `<dt>Respondida em</dt><dd>${fmtDate(c.respondida_em)}</dd>` : ''}
      ${c.apagada_por.length ? `<dt>Apagada por</dt><dd>${esc(c.apagada_por.join(' e '))} (só para quem apagou; o histórico abaixo continua guardado)</dd>` : ''}</dl>
      <div class="actions" style="justify-content:flex-start;margin:0 0 10px"><button class="btn small danger" type="button" data-tk-apagar="${c.id}">Apagar histórico</button></div>
      <div class="tk-msgs">${c.mensagens.length ? c.mensagens.map(m => `<div class="tk-msg${m.autor ? '' : ' sis'}"><b>${esc(m.autor_nome)}</b>${esc(m.texto)}<small>${fmtDate(m.created_at)}${m.pedido_id ? ` · <a href="#" data-tk-pedido="${m.pedido_id}">pedido</a>` : ''}</small></div>`).join('') : '<span class="hint">Sem mensagens.</span>'}</div>`;
  } else {
    const p = await api(`/api/admin/pedidos-loja/${id}`);
    $('#tk-title').textContent = `Pedido ${p.codigo} — ${p.status_nome}`;
    body.innerHTML = `<dl class="kv"><dt>Loja</dt><dd><a href="/loja/${esc(p.loja.slug)}" target="_blank">${esc(p.loja.nome)}</a></dd>
      <dt>Cliente</dt><dd>${esc(p.comprador.nome)}</dd><dt>Produto</dt><dd>${p.quantidade}x ${esc(p.produto)} (${brl(p.preco_unit)} cada)</dd>
      <dt>Total</dt><dd><b>${brl(p.total)}</b></dd><dt>Pagamento</dt><dd>${esc(p.metodo_nome)}</dd>
      <dt>Observação</dt><dd>${esc(p.observacao || '—')}</dd><dt>Criado em</dt><dd>${fmtDate(p.created_at)}</dd>
      <dt>Pago em</dt><dd>${fmtDate(p.pago_em)}</dd><dt>Concluído em</dt><dd>${fmtDate(p.concluido_em)}</dd></dl>
      <h4 style="margin:0">Histórico do pedido</h4>
      <div class="tk-msgs">${p.eventos.map(e => `<div class="tk-msg"><b>${esc(e.evento.replace(/_/g, ' '))}</b>${esc(e.quem_nome)}${e.detalhe ? ` — ${esc(e.detalhe)}` : ''}<small>${fmtDate(e.created_at)}</small></div>`).join('')}</div>
      ${p.conversa_id ? `<div><button class="btn small" type="button" data-tk-conversa="${p.conversa_id}">Ver a conversa do pedido</button></div>` : ''}`;
  }
  if (!$('#tk-dlg').open) $('#tk-dlg').showModal();
}
document.addEventListener('click', e => {
  const tr = e.target.closest('tr[data-tk]');
  if (tr) return abrirTicket(tr.dataset.tk, tr.dataset.id).catch(err => globalMsg(err.message, false));
  const lp = e.target.closest('[data-tk-pedido]');
  if (lp) { e.preventDefault(); return abrirTicket('pedido', lp.dataset.tkPedido).catch(err => globalMsg(err.message, false)); }
  const ap = e.target.closest('[data-tk-apagar]');
  if (ap) {
    (async () => {
      if (!await OfertouUI.confirmar('As mensagens e as ocorrências de moderação desta conversa serão apagadas de vez, também para as pessoas da conversa. Não dá para desfazer. Bloqueios e pedidos continuam valendo.', { titulo: 'Apagar o histórico desta conversa?', ok: 'Apagar histórico', perigo: true })) return;
      await api(`/api/admin/conversas/${ap.dataset.tkApagar}/historico`, { method: 'DELETE' });
      $('#tk-dlg').close();
      globalMsg('Histórico da conversa apagado.', true);
      loadAtendimento().catch(() => {});
    })().catch(err => globalMsg(err.message, false));
    return;
  }
  const lc = e.target.closest('[data-tk-conversa]');
  if (lc) return abrirTicket('conversa', lc.dataset.tkConversa).catch(err => globalMsg(err.message, false));
});
$('#tk-dlg').addEventListener('click', e => { if (e.target === $('#tk-dlg') || e.target.closest('[data-close]')) $('#tk-dlg').close(); });

// ── Planos à venda (criar, editar, excluir) ──────────────────────────────────
let PL = null;
let PLANO_NOME = {};
const PL_TIPO_TXT = {
  consumidor: 'Conta de consumidor no site, liberada na hora após o pagamento.',
  empresa: 'Conta de empresa: página da loja no site, com anúncios e importação de catálogo.',
  ferramenta: 'Acesso à ferramenta de afiliado (/cliente): links próprios e postagem automática nas redes.',
};
async function loadPlanos() {
  PL = await api('/api/admin/planos');
  PLANO_NOME = Object.fromEntries(PL.planos.map(p => [p.id, p.nome]));
  const sim = v => v ? '✓' : '—';
  $('#pl-lista').innerHTML = PL.planos.length ? PL.planos.map(p => {
    const pf = p.recursos.perfil;
    return `<div class="store-card pl-card${p.ativo ? '' : ' pl-off'}">
      <h4>${esc(p.nome)} ${p.destaque ? `<span class="badge b-active">${esc(p.destaque)}</span>` : ''} ${p.ativo ? '' : '<span class="badge b-none">fora da venda</span>'}</h4>
      <div class="pl-preco">${p.gratis ? 'Grátis' : brl(p.preco)} <span class="hint" style="margin:0">/ ${p.dias ? `${p.dias} dias` : 'sem vencimento'}</span></div>
      ${(p.ciclos || []).length > 1 ? `<div class="hint" style="margin:2px 0">${p.ciclos.slice(1).map(c => `${esc(c.nome)}: ${brl(c.preco)}`).join(' · ')}</div>` : ''}
      ${!p.gratis && (p.teste_dias || p.desconto_auto) ? `<div class="hint" style="margin:2px 0">${p.teste_dias ? `${p.teste_dias} dias grátis` : ''}${p.teste_dias && p.desconto_auto ? ' · ' : ''}${p.desconto_auto ? `${String(p.desconto_auto).replace('.', ',')}% na renovação automática` : ''}</div>` : ''}
      <div class="hint" style="margin:4px 0">${esc(p.tipo_nome)} · código <code>${esc(p.id)}</code> · <b>${p.assinantes}</b> assinante${p.assinantes === 1 ? '' : 's'}</div>
      <div class="pl-mini">Vitrine ${pf.vitrine} · resumo ${pf.bio} · links ${pf.links} · capa ${sim(pf.capa)} · degradê ${sim(pf.gradiente)} · endereço ${sim(pf.slug_livre)} · moldura ${sim(pf.moldura)}${p.tipos.includes('empresa') ? ` · produtos ${p.recursos.max_produtos || 'padrão'}` : ''} · ${Number(p.recursos.moedas || 0).toLocaleString('pt-BR')} moedas</div>
      <div class="actions" style="justify-content:flex-start;margin-top:10px">
        <button class="btn small" type="button" data-pl-editar="${esc(p.id)}">Editar</button>
        <button class="btn small danger" type="button" data-pl-excluir="${esc(p.id)}">Excluir</button>
      </div></div>`;
  }).join('') : '<p class="hint">Nenhum plano. Clique em <b>+ Criar plano</b>.</p>';
}

function plAbrir(p) {
  const f = $('#pl-form');
  f.reset();
  f.dataset.id = p ? p.id : '';
  $('#pl-title').textContent = p ? `Editar plano — ${p.nome}` : 'Novo plano';
  $('#pl-msg').innerHTML = '';
  const pf = p ? p.recursos.perfil : PL.padrao;
  const tiposAtuais = p ? p.tipos : ['consumidor'];
  const travado = Boolean(p && p.assinantes);
  $('#pl-tipos').innerHTML = Object.entries(PL.tipos).map(([id, t]) => `<label class="pl-tipo">
    <input type="checkbox" name="tipos" value="${id}"${tiposAtuais.includes(id) ? ' checked' : ''}${travado ? ' disabled' : ''}>
    <span><b>${esc(t.nome)}</b><br><span class="hint" style="margin:0">${esc(PL_TIPO_TXT[id] || '')}</span>
    <ul>${(PL.funcoes[id] || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul></span></label>`).join('');
  $('#pl-tipo-aviso').textContent = travado ? 'Este plano tem assinantes: os tipos de acesso não podem mudar (crie um plano novo para isso).' : '';
  const v = {
    nome: p?.nome || '', preco: p && !p.gratis ? String(p.preco).replace('.', ',') : '', dias: p?.dias || 30, ordem: p?.ordem ?? (PL.planos.length + 1) * 10,
    max_produtos: p?.recursos.max_produtos || 0, moedas: p?.recursos.moedas ?? 1000, chamada: p?.chamada || '', ideal: p?.ideal || '', destaque: p?.destaque || '',
    icone: p?.icone || 'consumidor', beneficios: (p?.beneficios || []).join('\n'),
    link_pagamento: p?.link_pagamento || '', produto_app: p?.produto_app || '',
    p_vitrine: pf.vitrine, p_bio: pf.bio, p_links: pf.links, p_selo: pf.selo || '',
    preco_trimestral: String((p?.ciclos || []).find(c => c.id === 'trimestral')?.preco ?? '').replace('.', ','),
    preco_anual: String((p?.ciclos || []).find(c => c.id === 'anual')?.preco ?? '').replace('.', ','),
    teste_dias: p?.teste_dias || 0, desconto_auto: String(p?.desconto_auto || 0).replace('.', ','),
  };
  for (const [k, val] of Object.entries(v)) if (f.elements[k]) f.elements[k].value = val;
  f.elements.ativo.checked = p ? p.ativo : true;
  f.elements.gratis.checked = Boolean(p?.gratis);
  f.elements.sem_vencimento.checked = Boolean(p?.sem_vencimento);
  for (const k of ['capa', 'cores_extras', 'gradiente', 'slug_livre', 'moldura']) f.elements[`p_${k}`].checked = Boolean(pf[k]);
  plTipoMudou();
  $('#pl-dlg').showModal();
}
const plTipos = () => $$('#pl-tipos [name="tipos"]:checked').map(i => i.value);
function plTipoMudou() {
  const f = $('#pl-form');
  $$('.pl-so-empresa').forEach(el => el.classList.toggle('hidden', !plTipos().includes('empresa')));
  f.elements.preco.disabled = f.elements.gratis.checked;
  if (f.elements.gratis.checked) f.elements.sem_vencimento.checked = true; // grátis é sempre permanente
  f.elements.sem_vencimento.disabled = f.elements.gratis.checked;
  f.elements.dias.disabled = f.elements.sem_vencimento.checked;
}
function plDados() {
  const f = $('#pl-form');
  const e = f.elements;
  return {
    nome: e.nome.value, preco: e.preco.value, gratis: e.gratis.checked, dias: e.dias.value, sem_vencimento: e.sem_vencimento.checked,
    ordem: e.ordem.value, ativo: e.ativo.checked, tipos: plTipos(), max_produtos: e.max_produtos.value, moedas: e.moedas.value,
    chamada: e.chamada.value, ideal: e.ideal.value, destaque: e.destaque.value, icone: e.icone.value, beneficios: e.beneficios.value,
    link_pagamento: e.link_pagamento.value, produto_app: e.produto_app.value,
    preco_trimestral: e.preco_trimestral.value, preco_anual: e.preco_anual.value, teste_dias: e.teste_dias.value, desconto_auto: e.desconto_auto.value,
    perfil: { vitrine: e.p_vitrine.value, bio: e.p_bio.value, links: e.p_links.value, selo: e.p_selo.value,
      capa: e.p_capa.checked, cores_extras: e.p_cores_extras.checked, gradiente: e.p_gradiente.checked, slug_livre: e.p_slug_livre.checked, moldura: e.p_moldura.checked },
  };
}
$('#pl-novo').addEventListener('click', () => plAbrir(null));
$('#pl-lista').addEventListener('click', async e => {
  const ed = e.target.closest('[data-pl-editar]');
  if (ed) return plAbrir(PL.planos.find(p => p.id === ed.dataset.plEditar));
  const ex = e.target.closest('[data-pl-excluir]');
  if (!ex) return;
  const p = PL.planos.find(x => x.id === ex.dataset.plExcluir);
  const aviso = p.assinantes
    ? `O plano "${p.nome}" tem ${p.assinantes} assinante(s). Ele sai da venda agora, mas continua valendo para essas pessoas até o fim do prazo pago. Continuar?`
    : `Excluir o plano "${p.nome}"? Ele sai da página e da compra. Não dá para desfazer.`;
  if (!await OfertouUI.confirmar(aviso)) return;
  try {
    const r = await api(`/api/admin/planos/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
    globalMsg(r.arquivado ? `Plano retirado da venda (continua valendo para ${r.assinantes} assinante(s) até vencer).` : 'Plano excluído.');
    loadPlanos();
  } catch (err) { globalMsg(err.message, false); }
});
$('#pl-tipos').addEventListener('change', e => {
  if (e.target.name !== 'tipos') return;
  const f = $('#pl-form');
  const t = plTipos();
  if (!f.dataset.id && t.length) f.elements.icone.value = PL.tipos[t.includes('empresa') ? 'empresa' : t.includes('consumidor') ? 'consumidor' : 'ferramenta'].icone;
  plTipoMudou();
});
$('#pl-form').addEventListener('change', e => { if (['gratis', 'sem_vencimento'].includes(e.target.name)) plTipoMudou(); });
$('#pl-sugerir').addEventListener('click', async () => {
  const f = $('#pl-form');
  if (f.elements.beneficios.value.trim() && !await OfertouUI.confirmar('Trocar os benefícios escritos pelos gerados a partir das funções?')) return;
  const r = await api('/api/admin/planos/sugerir-beneficios', { method: 'POST', body: plDados() });
  f.elements.beneficios.value = r.beneficios.join('\n');
});
$('#pl-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  try {
    const id = f.dataset.id;
    await api(id ? `/api/admin/planos/${encodeURIComponent(id)}` : '/api/admin/planos', { method: id ? 'PUT' : 'POST', body: plDados() });
    $('#pl-dlg').close();
    globalMsg(id ? 'Plano atualizado.' : 'Plano criado. Ele já aparece na página inicial e na compra.');
    loadPlanos();
  } catch (err) { flash($('#pl-msg'), err.message, false); }
});
$('#pl-dlg').addEventListener('click', e => { if (e.target.closest('[data-close]')) $('#pl-dlg').close(); });

// ── Planos e pagamentos ───────────────────────────────────────────────────────
const PED_STATUS = { pendente: ['b-pending', 'Aguardando'], aprovado: ['b-active', 'Aprovado'], recusado: ['b-banned', 'Recusado'],
  cancelado: ['b-none', 'Cancelado'], expirado: ['b-none', 'Expirado'] };
const PED_METODO = { gratis: 'Plano grátis', teste: 'Período grátis', assinatura: 'Renovação automática (Mercado Pago)', pix: 'Pix (Mercado Pago)', mercadopago: 'Cartão (Mercado Pago)', pix_manual: 'Pix pela chave', transferencia: 'Transferência', link: 'Link de pagamento', combinar: 'A combinar', app_store: 'App Store (app)', play_store: 'Google Play (app)' };
const PED_MANUAL = ['pix_manual', 'transferencia', 'link', 'combinar'];
async function loadPedidos() {
  const d = await api('/api/admin/pagamentos');
  const pend = d.pedidos.filter(p => p.status === 'pendente' && PED_MANUAL.includes(p.metodo)).length;
  $('#pedidos-badge').textContent = pend;
  $('#pedidos-badge').classList.toggle('hidden', !pend);
  const m = d.metodos;
  $('#pag-situacao').innerHTML = `Recebendo por: ${m.algum ? m.lista.map(x => `<b>${esc(x.nome)}</b>${x.automatico ? ' (automático)' : ''}`).join(', ') : '<b style="color:var(--red)">nenhuma forma configurada — o cliente finaliza o pedido e o pagamento fica "a combinar" (você confirma aqui)</b>'}
    · E-mail de confirmação: ${d.email ? '<b>configurado</b>' : '<b style="color:var(--yellow)">não configurado</b>'}`;
  $('#pedidos-body').innerHTML = d.pedidos.length ? d.pedidos.map(p => {
    const [cls, txt] = PED_STATUS[p.status] || ['b-none', p.status];
    return `<tr>
      <td class="num">${fmtDate(p.created_at)}</td>
      <td><b>${esc(p.nome || '—')}</b><br><span class="hint" style="margin:0">${esc(p.email)}</span></td>
      <td>${esc(PLANO_NOME[p.plano] || p.plano)}<br><span class="hint" style="margin:0">${p.dias ? `${p.dias} dias` : 'sem vencimento'}</span></td>
      <td class="num">${brl(p.valor)}</td>
      <td>${esc(PED_METODO[p.metodo] || p.metodo)}${p.mp_payment_id ? `<br><span class="hint" style="margin:0">MP ${esc(p.mp_payment_id)}</span>` : ''}</td>
      <td><span class="badge ${cls}">${txt}</span>${p.status === 'aprovado' ? `<br><span class="hint" style="margin:0">até ${fmtDia(p.validade_ate)}${p.email_enviado ? ' · e-mail enviado' : ''}</span>` : ''}
        ${p.reembolso_status ? `<br><span class="badge" style="color:var(--red)">${p.reembolso_status === 'reembolsado' ? 'Reembolsado' : 'Reembolso a fazer'}</span>${p.reembolso_obs ? `<br><span class="hint" style="margin:0">${esc(p.reembolso_obs)}</span>` : ''}` : ''}</td>
      <td class="num">
        ${['pendente', 'expirado'].includes(p.status) ? `<button class="btn small primary" data-ped="confirmar" data-id="${p.id}">Confirmar pagamento</button>
          <button class="btn small danger" data-ped="cancelar" data-id="${p.id}">Cancelar</button>` : ''}
        ${p.status === 'aprovado' ? `<button class="btn small" data-ped="email" data-id="${p.id}">Reenviar e-mail</button>` : ''}
        ${p.reembolso_status === 'solicitado' ? `<button class="btn small primary" data-ped="reembolsado" data-id="${p.id}">Marcar reembolso feito</button>` : ''}
      </td></tr>`;
  }).join('') : '<tr><td colspan="7" class="hint">Nenhum pedido ainda.</td></tr>';
}
$('#pedidos-body').addEventListener('click', async e => {
  const b = e.target.closest('[data-ped]');
  if (!b) return;
  const id = b.dataset.id;
  try {
    if (b.dataset.ped === 'reembolsado') {
      if (!await OfertouUI.confirmar('Confirmar que você já devolveu o valor desta compra para o cliente?')) return;
      await api(`/api/admin/pagamentos/${id}/reembolsado`, { method: 'POST', body: {} });
      globalMsg('Reembolso marcado como feito.'); loadPedidos(); return;
    }
    if (b.dataset.ped === 'confirmar') {
      if (!await OfertouUI.confirmar('Confirmar que o pagamento deste pedido foi recebido? A conta será liberada na hora.')) return;
      await api(`/api/admin/pagamentos/${id}/confirmar`, { method: 'POST', body: {} });
      globalMsg('Pagamento confirmado e acesso liberado.');
    } else if (b.dataset.ped === 'cancelar') {
      if (!await OfertouUI.confirmar('Cancelar este pedido?')) return;
      await api(`/api/admin/pagamentos/${id}/cancelar`, { method: 'POST', body: {} });
    } else if (b.dataset.ped === 'email') {
      await api(`/api/admin/pagamentos/${id}/email`, { method: 'POST', body: {} });
      globalMsg('E-mail reenviado.');
    }
    loadPedidos();
  } catch (err) { globalMsg(err.message, false); }
});
$('#email-teste-btn').addEventListener('click', async () => {
  try { await api('/api/admin/email/teste', { method: 'POST', body: { para: $('#email-teste').value } }); globalMsg('E-mail de teste enviado.'); }
  catch (err) { globalMsg(err.message, false); }
});

// ── Ganhos dos programas de afiliados ─────────────────────────────────────────
const GN_STATUS = { pendente: ['b-pending', 'Pendente'], confirmada: ['b-active', 'Confirmada'], paga: ['b-none', 'Paga'], cancelada: ['b-banned', 'Cancelada'] };
let GN = null;
const gnMoeda = (v, moeda) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: moeda || 'BRL' });
const gnDia = s => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString('pt-BR') : '—');

// De onde vem cada aviso: dá a cor do aviso e o nome em cima do título
const NOME_ORIGEM = { dinheiro: 'Saldo para sacar', postagens: 'Postagens', whatsapp: 'WhatsApp', mercadolivre: 'Mercado Livre', cupons: 'Cupons', pagamentos: 'Planos e pagamentos', sistema: 'Sistema' };
function origemDoAviso(n) {
  if (n.tipo === 'saldo') return 'dinheiro';
  if (n.tipo === 'ml-coleta') return 'mercadolivre';
  if (n.tipo === 'arrependimento' || n.tipo === 'assinatura') return 'pagamentos';
  if (n.tipo === 'envio') {
    if (/^envio-whatsapp/.test(n.chave || '')) return 'whatsapp';
    if (/^envio-cupons/.test(n.chave || '')) return 'cupons';
    return 'postagens';
  }
  return 'sistema';
}
async function loadGanhos() {
  const plat = $('#gn-filtro-plat').value || '';
  const st = $('#gn-filtro-status').value || '';
  GN = await api(`/api/admin/ganhos?plataforma=${encodeURIComponent(plat)}&status=${encodeURIComponent(st)}`);
  const P = Object.fromEntries(GN.plataformas.map(p => [p.id, p]));
  // Avisos
  $('#gn-avisos-panel').hidden = !GN.notificacoes.length;
  $('#gn-avisos').innerHTML = GN.notificacoes.map(n => { const origem = origemDoAviso(n); return `
    <div class="gn-aviso" data-origem="${origem}"><div class="gn-aviso-txt"><span class="gn-origem">${esc(NOME_ORIGEM[origem])}</span><b>${esc(n.titulo)}</b><span class="hint" style="margin:0">${esc(n.texto || '')} · ${fmtDate(n.created_at)}</span></div>
      <div class="gn-aviso-acoes">${!n.link ? '' : n.link.startsWith('/') ? `<a class="btn small primary" href="${esc(n.link)}" data-gn-ir>Ver no painel</a>` : `<a class="btn small primary" href="${esc(n.link)}" target="_blank" rel="noopener">Abrir portal ↗</a>`}
      <button class="btn small" data-gn-lida="${n.id}">Ok</button></div></div>`; }).join('');
  // Sincronização: situação de cada programa (automático pela API ou pela planilha)
  const nomes = Object.fromEntries(GN.plataformas.map(p => [p.id, p.nome]));
  $('#gn-sync').disabled = GN.sync.rodando;
  $('#gn-sync').textContent = GN.sync.rodando ? 'Sincronizando…' : 'Sincronizar agora';
  $('#gn-sync-lista').innerHTML = Object.entries(GN.sync.plataformas).map(([id, x]) => `<div class="gn-sync-item">
    <span class="gn-ponto ${!x.automatica ? 'manual' : x.ok === true ? 'ok' : x.ok === false ? 'erro' : ''}"></span>
    <div><b>${esc(nomes[id] || id)}</b><small>${esc(x.mensagem || '')}</small>
    <span class="gn-tag">${x.extensao ? `🧩 Pela extensão do Chrome${x.em ? ` · ${fmtDate(x.em.replace('T', ' ').slice(0, 19))}` : ''}` : x.automatica ? `🔄 Automática${x.em ? ` · ${fmtDate(x.em.replace('T', ' ').slice(0, 19))}` : ''}` : '📄 Pela planilha do portal'}</span></div></div>`).join('');
  // Cartões das plataformas
  $('#gn-plataformas').innerHTML = GN.plataformas.map(p => {
    const pct = p.minimo > 0 ? Math.min(100, Math.round((p.disponivel / p.minimo) * 100)) : (p.disponivel > 0 ? 100 : 0);
    return `<div class="gn-card${p.pode_sacar ? ' is-pronto' : ''}${p.ativo ? '' : ' is-off'}">
      <div class="gn-card-topo"><b>${lojaLogo(p.id, p.nome)}</b>${p.pode_sacar ? '<span class="badge b-active">Pode sacar</span>' : ''}</div>
      <div class="gn-saldos"><div class="gn-saldo">${gnMoeda(p.disponivel, p.moeda)}<small>disponível</small></div><div class="gn-saldo gn-saldo-liberar">${gnMoeda(p.a_liberar, p.moeda)}<small>a liberar</small></div></div>
      <div class="gn-barra" title="${pct}% do mínimo"><span style="width:${pct}%"></span></div>
      <div class="hint" style="margin:6px 0 0">Mínimo: <b>${p.minimo ? gnMoeda(p.minimo, p.moeda) : 'não informado'}</b>${p.falta > 0 ? ` · faltam ${gnMoeda(p.falta, p.moeda)}` : ''}</div>
      <div class="hint" style="margin:2px 0 0">Recebido: <b>${gnMoeda(p.recebido, p.moeda)}</b>${p.proxima_liberacao ? ` · próxima liberação: ${/^\d{4}-/.test(p.proxima_liberacao) ? gnDia(p.proxima_liberacao) : esc(p.proxima_liberacao)}` : ''}</div>
      ${p.leitura?.em ? `<div class="hint gn-estimado">📡 Saldo lido do portal em ${fmtDate(p.leitura.em)}</div>` : p.estimado ? `<div class="hint gn-estimado">📡 A liberar = ganho estimado no painel do Mercado Livre, lido em ${fmtDate(p.estimado.em)}</div>` : ''}
      <div class="hint" style="margin:2px 0 0">${p.vendas} venda(s) · libera em ${p.dias_liberacao} dias</div>
      <div class="gn-card-acoes">
        <button class="btn small${p.pode_sacar ? ' primary' : ''}" data-gn-saque="${p.id}">Registrar saque</button>
        <button class="btn small" data-gn-regras="${p.id}">Regras</button>
        ${p.portal ? `<a class="btn small" href="${esc(p.portal)}" target="_blank" rel="noopener">Portal ↗</a>` : ''}
      </div></div>`;
  }).join('');
  // Selects de plataforma
  const opcoes = GN.plataformas.map(p => `<option value="${p.id}">${esc(p.nome)}</option>`).join('');
  for (const sel of ['#gn-csv-plat', '#gn-nova-plat']) { const v = $(sel).value; $(sel).innerHTML = opcoes; if (v) $(sel).value = v; }
  const vf = $('#gn-filtro-plat').value;
  $('#gn-filtro-plat').innerHTML = `<option value="">Todas as plataformas</option>${opcoes}`;
  $('#gn-filtro-plat').value = vf;
  // Vendas
  $('#gn-vendas').innerHTML = GN.vendas.length ? GN.vendas.map(v => {
    const p = P[v.plataforma] || {};
    const [cls] = GN_STATUS[v.status] || ['b-none'];
    return `<tr>
      <td class="num">${gnDia(v.data_venda)}</td><td>${esc(p.nome || v.plataforma)}</td>
      <td>${esc(v.produto || v.pedido || '—')}${v.pedido && v.produto ? `<br><span class="hint" style="margin:0">${esc(v.pedido)}</span>` : ''}</td>
      <td class="num">${v.valor_venda ? gnMoeda(v.valor_venda, p.moeda) : '—'}</td>
      <td class="num"><b>${gnMoeda(v.comissao, p.moeda)}</b></td>
      <td><select class="gn-status ${cls}" data-gn-status="${v.id}">${Object.entries(GN_STATUS).map(([k, [, t]]) => `<option value="${k}"${k === v.status ? ' selected' : ''}>${t}</option>`).join('')}</select></td>
      <td class="num">${v.status === 'confirmada' ? gnDia(v.liberada_em) : '—'}</td>
      <td class="num"><button class="btn small danger" data-gn-del="${v.id}" title="Excluir">✕</button></td></tr>`;
  }).join('') : '<tr><td colspan="8" class="hint">Nenhuma venda registrada ainda. Importe a planilha do portal ou adicione à mão.</td></tr>';
  // Saques
  $('#gn-saques').innerHTML = GN.saques.length ? GN.saques.map(s => `<tr><td class="num">${gnDia(s.data)}</td><td>${esc((P[s.plataforma] || {}).nome || s.plataforma)}</td>
    <td class="num">${gnMoeda(s.valor, (P[s.plataforma] || {}).moeda)}</td><td>${esc(s.observacao || '')}</td>
    <td class="num"><button class="btn small danger" data-gn-del-saque="${s.id}">✕</button></td></tr>`).join('')
    : '<tr><td colspan="5" class="hint">Nenhum saque registrado.</td></tr>';
  atualizarSino(GN.notificacoes.length);
  portaisSeVelhos(30);
}

// Mercado Livre e Magalu: a extensão lê o saldo e as vendas no portal, sem abrir página nenhuma
const NOME_PORTAL = { mercadolivre: 'Mercado Livre', magalu: 'Magalu' };
let portalLendo = false, portalEspera = null, portalAvisar = false, portalTentou = 0, portalAbriu = false;
const extensaoLeGanhos = () => { const [a, b] = extensaoVersao.split('.').map(Number); return a > 2 || (a === 2 && b >= 12); };
function lerPortais(avisar = false) {
  if (!extensaoInstalada || !extensaoLeGanhos() || portalLendo) return false;
  portalLendo = true; portalAvisar = avisar; portalTentou = Date.now();
  clearTimeout(portalEspera);
  portalEspera = setTimeout(() => { portalLendo = false; if (avisar) globalMsg('A extensão não respondeu. Recarregue a extensão em chrome://extensions e atualize esta página.', false); }, 180000);
  window.postMessage({ ofertouPainel: true, tipo: 'ler-ganhos' }, location.origin);
  return true;
}
function portaisSeVelhos(minutos) {
  if (!GN || Date.now() - portalTentou < 30 * 60000) return;
  const velho = GN.plataformas.filter(p => ['mercadolivre', 'magalu'].includes(p.id)).some(p => {
    const em = p.leitura?.lido_em;
    return !em || Date.now() - new Date(`${em.replace(' ', 'T')}Z`).getTime() > minutos * 60000;
  });
  if (velho) lerPortais();
}
// Ao abrir o painel, mesmo sem entrar em Ganhos: mantém o saldo e os avisos de saque em dia
async function portaisAoAbrir() {
  if (portalAbriu || !extensaoLeGanhos()) return;
  portalAbriu = true;
  try { GN = GN || await api('/api/admin/ganhos'); portaisSeVelhos(6 * 60); } catch { /* tenta ao abrir Ganhos */ }
}
async function receberPortais(resultados = {}) {
  clearTimeout(portalEspera);
  const partes = [];
  let erros = 0;
  for (const id of ['mercadolivre', 'magalu']) {
    const r = resultados[id] || { erro: resultados.erro || 'A extensão não respondeu.' };
    try {
      const x = await api('/api/admin/ganhos/portal', { method: 'POST', body: { plataforma: id, ...r } });
      if (r.erro) { erros++; partes.push(`${NOME_PORTAL[id]}: ${r.erro}`); } else partes.push(`${NOME_PORTAL[id]}: ${x.novas} venda(s) nova(s), ${x.atualizadas} atualizada(s)`);
    } catch (err) { erros++; partes.push(`${NOME_PORTAL[id]}: ${err.message}`); }
  }
  portalLendo = false;
  if (portalAvisar) globalMsg(partes.join(' · '), !erros);
  if (!$('[data-body="ganhos"]')?.classList.contains('hidden')) loadGanhos(); else GN = null;
}

// Janela simples para saque e regras
function gnJanela(titulo, campos, aoSalvar) {
  $('#gn-dlg-titulo').textContent = titulo;
  $('#gn-dlg-campos').innerHTML = campos;
  const form = $('#gn-dlg-form');
  form.onsubmit = async e => {
    e.preventDefault();
    try { await aoSalvar(Object.fromEntries(new FormData(form))); $('#gn-dlg').close(); loadGanhos(); } catch (err) { OfertouUI.avisar(err.message); }
  };
  $('#gn-dlg').showModal();
}
$('#gn-dlg-cancelar').addEventListener('click', () => $('#gn-dlg').close());
$('#gn-dlg-fechar').addEventListener('click', () => $('#gn-dlg').close());
$('#gn-sync').addEventListener('click', async () => {
  const b = $('#gn-sync');
  b.disabled = true; b.textContent = 'Sincronizando…';
  try {
    const r = await api('/api/admin/ganhos/sincronizar', { method: 'POST' });
    if (r.erro) globalMsg(r.erro, false);
    else {
      const total = Object.values(r).reduce((a, x) => a + (x.novas || 0), 0);
      globalMsg(`Sincronização concluída: ${total} venda(s) nova(s).`);
    }
  } catch (err) { globalMsg(err.message, false); }
  if (extensaoInstalada && !extensaoLeGanhos()) globalMsg('Para ler o Mercado Livre e a Magalu, atualize a extensão: baixe de novo em Mineração, descompacte por cima da mesma pasta e toque em recarregar em chrome://extensions.', false);
  else if (!extensaoInstalada) globalMsg('Para ler o Mercado Livre e a Magalu, abra este painel no Chrome com a extensão instalada (Mineração → Extensão do Chrome).', false);
  else lerPortais(true);
  loadGanhos();
});

// "Ver no painel": o aviso já está no painel, então é só trocar de aba (o endereço com # não troca sozinho)
$('#gn-avisos').addEventListener('click', e => {
  const a = e.target.closest('a[data-gn-ir]');
  const aba = a && /^\/admin#([\w-]+)$/.exec(a.getAttribute('href'))?.[1];
  if (!aba || !document.querySelector(`.tab[data-tab="${aba}"]`)) return;
  e.preventDefault();
  abrirAba(aba);
  window.scrollTo(0, 0);
});
$('[data-body="ganhos"]').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  const P = GN ? Object.fromEntries(GN.plataformas.map(p => [p.id, p])) : {};
  try {
    if (b.dataset.gnSaque) {
      const p = P[b.dataset.gnSaque];
      gnJanela(`Registrar saque — ${p.nome}`, `
        <p class="hint">Use depois de sacar no portal (ou quando o pagamento automático cair na conta). Disponível agora: <b>${gnMoeda(p.disponivel, p.moeda)}</b>.</p>
        <label class="field">Valor (${esc(p.moeda)}) <input name="valor" inputmode="decimal" value="${String(p.disponivel).replace('.', ',')}" required></label>
        <label class="field" style="margin-top:8px">Data <input type="date" name="data" value="${new Date().toISOString().slice(0, 10)}"></label>
        <label class="field" style="margin-top:8px">Observação <input name="observacao" maxlength="200" placeholder="Ex.: saque para o Mercado Pago"></label>`,
      dados => api('/api/admin/ganhos/saques', { method: 'POST', body: { ...dados, plataforma: p.id } }));
    } else if (b.dataset.gnRegras) {
      const p = P[b.dataset.gnRegras];
      gnJanela(`Regras — ${p.nome}`, `
        <p class="hint">Confira no portal do programa e ajuste: os valores mudam com o tempo.</p>
        <label class="field">Valor mínimo para saque (${esc(p.moeda)}) <input name="minimo" inputmode="decimal" value="${String(p.minimo).replace('.', ',')}"></label>
        <label class="field" style="margin-top:8px">Dias até a comissão ficar disponível <input type="number" name="dias_liberacao" min="0" max="365" value="${p.dias_liberacao}"></label>
        <label class="field" style="margin-top:8px">Como o dinheiro chega <input name="pagamento" maxlength="300" value="${esc(p.pagamento || '')}"></label>
        <label class="field" style="margin-top:8px">Link do portal <input type="url" name="portal" value="${esc(p.portal || '')}"></label>
        <label class="field" style="margin-top:8px">Acompanhar esta plataforma <select name="ativo"><option value="1"${p.ativo ? ' selected' : ''}>Sim</option><option value="0"${p.ativo ? '' : ' selected'}>Não</option></select></label>`,
      dados => api(`/api/admin/ganhos/plataformas/${p.id}`, { method: 'PUT', body: { ...dados, ativo: dados.ativo === '1' } }));
    } else if (b.dataset.gnDel) {
      if (!await OfertouUI.confirmar('Excluir esta venda?')) return;
      await api(`/api/admin/ganhos/vendas/${b.dataset.gnDel}`, { method: 'DELETE' }); loadGanhos();
    } else if (b.dataset.gnDelSaque) {
      if (!await OfertouUI.confirmar('Excluir este saque? O saldo volta a contar esse valor.')) return;
      await api(`/api/admin/ganhos/saques/${b.dataset.gnDelSaque}`, { method: 'DELETE' }); loadGanhos();
    } else if (b.dataset.gnLida) {
      await api(`/api/admin/notificacoes/${b.dataset.gnLida}/lida`, { method: 'POST', body: {} }); loadGanhos();
    } else if (b.id === 'gn-avisos-lidos') {
      await api('/api/admin/notificacoes/lidas', { method: 'POST', body: {} }); loadGanhos();
    }
  } catch (err) { globalMsg(err.message, false); }
});
$('#gn-vendas').addEventListener('change', async e => {
  const sel = e.target.closest('[data-gn-status]');
  if (!sel) return;
  try { await api(`/api/admin/ganhos/vendas/${sel.dataset.gnStatus}`, { method: 'PATCH', body: { status: sel.value } }); loadGanhos(); }
  catch (err) { globalMsg(err.message, false); }
});
$('#gn-filtro-plat').addEventListener('change', loadGanhos);
$('#gn-filtro-status').addEventListener('change', loadGanhos);
$('#gn-nova').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/admin/ganhos/vendas', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset(); globalMsg('Venda registrada.'); loadGanhos();
  } catch (err) { globalMsg(err.message, false); }
});

// Importação do CSV: prévia com as colunas sugeridas → escolha → importação
let gnCsv = null;
const GN_CAMPOS = [['data_venda', 'Data da venda *'], ['comissao', 'Comissão *'], ['status', 'Situação'], ['pedido', 'Pedido / ID'], ['produto', 'Produto'], ['valor_venda', 'Valor da venda']];
$('#gn-csv-arq').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  if (f.size > 8 * 1024 * 1024) { globalMsg('Arquivo grande demais (máx. 8 MB).', false); return; }
  gnCsv = await f.text();
  try {
    const res = await fetch('/api/admin/ganhos/csv/previa', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: gnCsv });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    const opcoes = ['<option value="-1">— não usar —</option>', ...d.cabecalho.map((h, i) => `<option value="${i}">${esc(h || `Coluna ${i + 1}`)}</option>`)].join('');
    $('#gn-csv-info').textContent = `${d.total} linha(s) encontradas. Confira qual coluna é cada informação (sugerimos pelo nome):`;
    $('#gn-csv-campos').innerHTML = GN_CAMPOS.map(([k, t]) => `<label class="field">${t} <select data-gn-col="${k}">${opcoes}</select></label>`).join('');
    GN_CAMPOS.forEach(([k]) => { $(`[data-gn-col="${k}"]`).value = String(d.sugestao[k] ?? -1); });
    $('#gn-csv-previa').innerHTML = `<thead><tr>${d.cabecalho.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${d.exemplos.map(l => `<tr>${l.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
    $('#gn-csv-mapa').hidden = false;
  } catch (err) { globalMsg(err.message, false); }
});
$('#gn-csv-importar').addEventListener('click', async () => {
  if (!gnCsv) return;
  const mapa = Object.fromEntries(GN_CAMPOS.map(([k]) => [k, Number($(`[data-gn-col="${k}"]`).value)]).filter(([, v]) => v >= 0));
  try {
    const res = await fetch(`/api/admin/ganhos/csv/importar?plataforma=${encodeURIComponent($('#gn-csv-plat').value)}&mapa=${encodeURIComponent(JSON.stringify(mapa))}`,
      { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: gnCsv });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    globalMsg(`Importado: ${d.novas} nova(s), ${d.atualizadas} atualizada(s)${d.ignoradas ? `, ${d.ignoradas} linha(s) ignorada(s) sem data ou comissão` : ''}.`);
    $('#gn-csv-mapa').hidden = true; $('#gn-csv-arq').value = ''; gnCsv = null;
    loadGanhos();
  } catch (err) { globalMsg(err.message, false); }
});

// Sininho do topo: avisos não lidos (confere a cada 5 min)
function atualizarSino(n) {
  $('#sino-badge').textContent = n;
  $('#sino-badge').classList.toggle('hidden', !n);
  $('#ganhos-badge').textContent = n;
  $('#ganhos-badge').classList.toggle('hidden', !n);
}
async function conferirSino() {
  try {
    const r = await fetch('/api/admin/notificacoes', { cache: 'no-store' });
    if (r.ok) atualizarSino((await r.json()).itens.length);
  } catch { /* sem conexão */ }
}
$('#sino').addEventListener('click', () => $('.tab[data-tab="ganhos"]').click());
conferirSino();
setInterval(conferirSino, 5 * 60 * 1000);

// ── Clientes da ferramenta ────────────────────────────────────────────────────
const fmtDia = s => (String(s).startsWith('9999') ? 'sem vencimento' : s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString('pt-BR') : '—');
async function loadClientes() {
  const rows = await api('/api/admin/clientes');
  $('#cli-body').innerHTML = rows.length ? rows.map(c => {
    const sit = c.status === 'bloqueado' ? '<span class="badge b-banned">Bloqueado</span>'
      : c.vencido ? '<span class="badge b-pending">Vencido</span>' : '<span class="badge b-active">Ativo</span>';
    return `<tr>
      <td><b>${esc(c.nome)}</b><br><span class="hint" style="margin:0">${esc(c.email)}</span>${c.observacoes ? `<br><span class="hint" style="margin:0">${esc(c.observacoes)}</span>` : ''}</td>
      <td>${sit}</td>
      <td>${c.aceite_termos
        ? `<span class="badge b-active" title="Termos do Afiliado, versão ${esc(c.aceite_termos.versao)}${c.aceite_termos.ip ? ` · IP ${esc(c.aceite_termos.ip)}` : ''}">Aceito</span><br><span class="hint" style="margin:0">${fmtDate(c.aceite_termos.em)}</span>`
        : '<span class="badge b-pending">Ainda não aceitou</span>'}</td>
      <td class="num">${fmtDia(c.validade)}</td>
      <td class="num">${fmtDate(c.last_login_at)}</td>
      <td class="num">${c.postagens}</td>
      <td class="num">
        <button class="btn small primary" data-cli="renovar" data-id="${c.id}">+30 dias</button>
        <button class="btn small" data-cli="renovar-x" data-id="${c.id}">Renovar…</button>
        <button class="btn small" data-cli="${c.status === 'bloqueado' ? 'ativar' : 'bloquear'}" data-id="${c.id}">${c.status === 'bloqueado' ? 'Desbloquear' : 'Bloquear'}</button>
        <button class="btn small" data-cli="senha" data-id="${c.id}">Nova senha</button>
        <button class="btn small danger" data-cli="excluir" data-id="${c.id}">Excluir</button>
      </td></tr>`;
  }).join('') : '<tr><td colspan="7" class="hint">Nenhum cliente cadastrado.</td></tr>';
}

$('#cli-criar').addEventListener('click', async () => {
  const f = $('#cli-form');
  const body = Object.fromEntries(new FormData(f));
  try {
    await api('/api/admin/clientes', { method: 'POST', body });
    flash($('#cli-msg'), `Cliente cadastrado. Envie a ele: endereço ${location.origin}/cliente, e-mail ${body.email} e a senha inicial.`);
    f.reset(); f.dias.value = 30;
    loadClientes();
  } catch (err) { flash($('#cli-msg'), err.message, false); }
});

$('#cli-body').addEventListener('click', async e => {
  const b = e.target.closest('[data-cli]');
  if (!b) return;
  const id = b.dataset.id;
  try {
    if (b.dataset.cli === 'renovar') await api(`/api/admin/clientes/${id}/renovar`, { method: 'POST', body: { dias: 30 } });
    else if (b.dataset.cli === 'renovar-x') {
      const dias = await OfertouUI.perguntar('Renovar por quantos dias?', '30');
      if (!dias) return;
      await api(`/api/admin/clientes/${id}/renovar`, { method: 'POST', body: { dias } });
    } else if (b.dataset.cli === 'bloquear' || b.dataset.cli === 'ativar') {
      await api(`/api/admin/clientes/${id}/status`, { method: 'POST', body: { status: b.dataset.cli === 'bloquear' ? 'bloqueado' : 'ativo' } });
    } else if (b.dataset.cli === 'senha') {
      const senha = await OfertouUI.perguntar('Nova senha do cliente (mínimo 8 caracteres):', '');
      if (!senha) return;
      await api(`/api/admin/clientes/${id}`, { method: 'PUT', body: { senha } });
      globalMsg('Senha alterada. O cliente precisa entrar de novo.');
    } else if (b.dataset.cli === 'excluir') {
      if (!await OfertouUI.confirmar('Excluir este cliente? As configurações, a fila e o acesso dele serão apagados.')) return;
      await api(`/api/admin/clientes/${id}`, { method: 'DELETE' });
    }
    loadClientes();
  } catch (err) { globalMsg(err.message, false); }
});

// ── Redes sociais ─────────────────────────────────────────────────────────────
const REDE_NOME = { telegram: 'Telegram', facebook: 'Facebook', instagram: 'Instagram', x: 'X (Twitter)', whatsapp: 'WhatsApp' };

// WhatsApp: grupos de destino salvos.
function updateWaProvider() {
  let g = [];
  try { g = JSON.parse(SETTINGS.whatsapp_groups || '[]'); } catch { /* vazio */ }
  $('#wa-chosen').innerHTML = g.length ? `Grupos de destino salvos: <b>${g.map(x => esc(x.nome)).join(', ')}</b>${g.some(x => x.categorias?.length || x.lojas?.length) ? ' (alguns só recebem os tipos ou as lojas escolhidas)' : ''}` : 'Nenhum grupo de destino escolhido ainda.';
}

// Salva o formulário do WhatsApp antes de testar (para usar o que está digitado).
async function saveWaForm() {
  const form = $('#wa-load').form;
  const body = {};
  for (const el of form.elements) if (el.name) body[el.name] = el.value;
  await api('/api/admin/settings', { method: 'PUT', body });
  await loadSettings();
}

$('#wa-test').addEventListener('click', async () => {
  try {
    await saveWaForm();
    const r = await api('/api/admin/whatsapp/status');
    flash($('#wa-msg'), r.mensagem, r.conectado);
  } catch (err) { flash($('#wa-msg'), err.message, false); }
});

$('#wa-load').addEventListener('click', async () => {
  const b = $('#wa-load');
  b.disabled = true; b.textContent = 'Carregando…';
  try {
    await saveWaForm();
    const r = await api('/api/admin/whatsapp/grupos');
    if (!$('#wa-groups').dataset.ligado) { $('#wa-groups').dataset.ligado = '1'; OfertouTemas.ligar($('#wa-groups')); }
    $('#wa-groups').innerHTML = r.grupos.length ? r.grupos.map(g => OfertouTemas.linha(g, r.temas, r.lojas)).join('')
      : '<span class="hint">Nenhum grupo criado e administrado por este número.</span>';
    $('#wa-ocultos').textContent = OfertouTemas.avisoOcultos(r.ocultos);
    $('#wa-groups-box').classList.remove('hidden');
    $('#wa-msg').innerHTML = '';
  } catch (err) { flash($('#wa-msg'), err.message, false); }
  b.disabled = false; b.textContent = 'Carregar grupos do número';
});

$('#wa-save-groups').addEventListener('click', async () => {
  const grupos = OfertouTemas.ler($('#wa-groups'));
  try {
    await api('/api/admin/settings', { method: 'PUT', body: { whatsapp_groups: grupos } });
    await loadSettings();
    flash($('#wa-msg'), `${grupos.length} grupo(s) de destino salvos.`);
  } catch (err) { flash($('#wa-msg'), err.message, false); }
});

// Agendamento e fila
const FILA_STATUS = { pendente: 'Na fila', postado: 'Postado', erro: 'Erro', expirado: 'Saiu do ar' };
async function loadAgenda() {
  const { estado, fila } = await api('/api/admin/agenda');
  const ult = estado.ultimaExecucao;
  $('#agenda-estado').innerHTML = `${estado.ativa ? `<b>Ligado</b> · horários ${estado.horarios.join(', ')} · próximo: <b>${esc(estado.proximo || '—')}</b>` : '<b>Desligado</b>'}
    · ${estado.pendentes} oferta(s) na fila${estado.rodando ? ' · <b>publicando agora…</b>' : ''}
    ${ult ? `<br>Última rodada (${esc(ult.motivo)}): ${ult.feitos.filter(f => f.ok).length} de ${ult.feitos.length} publicadas em ${fmtDate(ult.em.replace('T', ' ').slice(0, 19))}${ult.conferidos ? ` · ${ult.conferidos} com preço conferido na loja na hora` : ''}${ult.pulados?.length ? ` · ${ult.pulados.length} pulada(s) por mudança na loja, no tema ou foto recusada` : ''}` : ''}
    ${estado.problema ? `<br><b>Atenção:</b> ${esc(estado.problema.mensagem)}` : ''}`;
  $('#fila-body').innerHTML = fila.length ? fila.map(q => `<tr>
      <td><span class="offer-title">${esc(q.produto || `oferta #${q.offer_id}`)}</span></td>
      <td><span class="badge ${q.status === 'postado' ? 'b-ok' : q.status === 'erro' ? 'b-error' : q.status === 'pendente' ? 'b-pending' : 'b-none'}">${FILA_STATUS[q.status] || q.status}</span></td>
      <td class="num">${fmtDate(q.created_at)}</td>
      <td class="hint" style="max-width:340px">${esc(q.resultado || '')}</td>
      <td>${q.status === 'pendente' ? `<button class="btn small danger" type="button" data-fila-del="${q.id}">Tirar</button>` : ''}</td></tr>`).join('')
    : '<tr><td colspan="5" class="hint">A fila está vazia.</td></tr>';
}
$('#fila-body').addEventListener('click', async e => {
  const b = e.target.closest('[data-fila-del]');
  if (!b) return;
  try { await api(`/api/admin/agenda/fila/${b.dataset.filaDel}`, { method: 'DELETE' }); loadAgenda(); } catch (err) { globalMsg(err.message, false); }
});
$('#fila-limpar').addEventListener('click', async () => {
  if (!await OfertouUI.confirmar('Tirar todas as ofertas que estão esperando na fila?')) return;
  try { await api('/api/admin/agenda/fila', { method: 'DELETE' }); loadAgenda(); } catch (err) { globalMsg(err.message, false); }
});
$('#agenda-run').addEventListener('click', async () => {
  try {
    await api('/api/admin/agenda/executar', { method: 'POST', body: {} });
    globalMsg('Rodada iniciada. As ofertas serão publicadas com o intervalo configurado; acompanhe no histórico.');
    setTimeout(loadAgenda, 1500);
  } catch (err) { globalMsg(err.message, false); }
});

async function loadSocialLog() {
  loadAgenda().catch(() => {});
  const rows = await api('/api/postagens/historico');
  $('#social-log').innerHTML = rows.length ? rows.map(r => `<tr>
      <td class="num">${fmtDate(r.created_at)}</td>
      <td><span class="offer-title">${esc(r.produto || '—')}</span></td>
      <td>${esc(REDE_NOME[r.rede] || r.rede)}</td>
      <td>${r.ok ? '<span class="badge b-ok">Publicado</span>' : `<span class="badge b-error">Erro</span> <span class="hint">${esc(r.mensagem || '')}</span>`}</td>
      <td>${esc(r.autor || '—')}</td></tr>`).join('')
    : '<tr><td colspan="5" class="hint">Nenhuma postagem automática ainda.</td></tr>';
}

// ── Publicidade ───────────────────────────────────────────────────────────────
const AD_STATUS = { no_ar: 'No ar', agendada: 'Agendada', encerrada: 'Encerrada', pausada: 'Pausada' };
let ADS = { espacos: {}, campanhas: [], pedidos: [], novos: 0 };
const fmtDay = s => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—');
const isoDay = s => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }) : '');
const okAdImg = src => /^(\/uploads\/[a-f0-9]{32}\.(jpg|png|webp)|https:\/\/)/.test(src || '');

// Acessos suspeitos (varredura de IP)
const AC_RISCO = { alta: 'Alto', media: 'Médio', baixa: 'Baixo' };
const fmtHora = s => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : '—');
const acTempo = m => (m < 60 ? `${m} min` : `${(m / 60).toFixed(1).replace('.', ',')} h`);
let acGeoTimer = null;
async function loadAcessosBase() {
  const g = await api('/api/admin/acessos/geoip');
  $('#ac-base').innerHTML = g.atualizando ? 'Baixando e preparando a base… (alguns minutos; pode continuar usando o painel)'
    : g.pronta ? `Base <b>${esc(g.versao)}</b> · ${Number(g.faixas).toLocaleString('pt-BR')} faixas · atualizada em ${fmtHora(g.atualizada_em.replace('T', ' ').slice(0, 19))}`
    : '<b>Base ainda não baixada.</b> Sem ela, a varredura não sabe a cidade dos IPs. Clique em "Atualizar a base agora".';
  if (g.erro) $('#ac-base').innerHTML += `<br><span style="color:var(--red)">Última tentativa falhou: ${esc(g.erro)}</span>`;
  $('#ac-base-atualizar').disabled = g.atualizando;
  clearTimeout(acGeoTimer);
  if (g.atualizando) acGeoTimer = setTimeout(() => loadAcessosBase().catch(() => {}), 5000);
  return g;
}
$('#ac-base-atualizar').addEventListener('click', async () => {
  try { await api('/api/admin/acessos/geoip/atualizar', { method: 'POST' }); loadAcessosBase(); } catch (err) { globalMsg(err.message, false); }
});
const acConta = c => `<b>${esc(c.nome)}</b>${c.email ? `<br><span class="hint" style="margin:0">${esc(c.email)}</span>` : ''}<br><span class="hint" style="margin:0">${c.cliente ? 'Cliente da ferramenta' : c.tipo === 'admin' ? 'Login do painel' : esc(c.tipo || '')}</span>`;
$('#ac-form').addEventListener('submit', async e => {
  e.preventDefault();
  const q = new URLSearchParams(new FormData(e.target));
  $('#ac-body').innerHTML = '<tr><td colspan="7" class="hint">Analisando os acessos…</td></tr>';
  try {
    const d = await api(`/api/admin/acessos/varredura?${q}`);
    $('#ac-geo').innerHTML = d.geo.pronta ? '' : '<b style="color:var(--yellow)">A base de localização ainda não foi baixada (veja embaixo): sem ela, nenhuma cidade é identificada.</b>';
    const altas = d.contas.filter(c => c.gravidade === 'alta').length;
    $('#ac-resumo').innerHTML = `<p class="hint">${d.analisados.toLocaleString('pt-BR')} registros analisados${d.limite ? ' (limite atingido: escolha um período menor)' : ''} · <b>${d.contas.length}</b> conta(s) com acessos distantes · <b>${altas}</b> de risco alto.</p>`;
    $('#ac-body').innerHTML = d.contas.length ? d.contas.map(c => {
      const ex = c.exemplos[0];
      return `<tr>
        <td>${acConta(c)}</td>
        <td><span class="ac-risco ac-${c.gravidade}">${AC_RISCO[c.gravidade]}</span>${c.velocidade_max >= 900 ? '<br><span class="hint" style="margin:0">viagem impossível</span>' : ''}${c.alternancias ? `<br><span class="hint" style="margin:0">${c.alternancias} ida(s) e volta(s)</span>` : ''}</td>
        <td class="num">${c.ocorrencias}<br><span class="hint" style="margin:0">${c.ips} IPs</span></td>
        <td><div class="ac-lugares">${c.lugares.slice(0, 6).map(l => `<span>${esc(l.lugar)} · ${l.vezes}</span>`).join('')}</div></td>
        <td class="ac-ex">${fmtHora(ex.de.em)} · ${esc(ex.de.texto)}<br>→ ${fmtHora(ex.para.em)} · ${esc(ex.para.texto)}<br><span class="hint" style="margin:0">${ex.km != null ? `${ex.km.toLocaleString('pt-BR')} km em ${acTempo(ex.minutos)}` : `outro país em ${acTempo(ex.minutos)}`}</span></td>
        <td>${fmtHora(c.ultimo_acesso)}</td>
        <td class="num" style="white-space:nowrap"><button class="btn small" type="button" data-ac-hist="${esc(c.dono)}">Histórico</button>
          ${c.id && !c.cliente ? `<button class="btn small" type="button" data-ac-ficha="${c.id}">Ficha</button>` : ''}
          <button class="btn small danger" type="button" data-ac-dispensar="${esc(c.dono)}" title="Tira esta conta da lista; ela só volta se tiver acessos distantes de novo">Dispensar</button></td></tr>`;
    }).join('') : '<tr><td colspan="7" class="hint">Nenhuma conta com acessos distantes nesse período.</td></tr>';
  } catch (err) { $('#ac-body').innerHTML = `<tr><td colspan="7" class="hint">${esc(err.message)}</td></tr>`; }
});
$('#ac-body').addEventListener('click', async e => {
  const h = e.target.closest('[data-ac-hist]'), f = e.target.closest('[data-ac-ficha]'), x = e.target.closest('[data-ac-dispensar]');
  if (f) return openUser(Number(f.dataset.acFicha));
  if (x) {
    if (!await OfertouUI.confirmar('Dispensar este alerta? A conta sai da lista e só volta se tiver acessos de lugares distantes de novo, a partir de agora.', { ok: 'Dispensar' })) return;
    try { await api('/api/admin/acessos/dispensar', { method: 'POST', body: { dono: x.dataset.acDispensar } }); x.closest('tr').remove(); globalMsg('Alerta dispensado.'); }
    catch (err) { globalMsg(err.message, false); }
    return;
  }
  if (!h) return;
  try {
    const d = await api(`/api/admin/acessos/historico?dono=${encodeURIComponent(h.dataset.acHist)}&horas=${$('#ac-form').horas.value}`);
    $('#ac-hist').classList.remove('hidden');
    $('#ac-hist-tit').textContent = `Histórico de acessos — ${d.nome}`;
    $('#ac-hist-sub').textContent = `${d.acessos.length} registro(s), do mais novo para o mais antigo. Cada linha é um IP a cada 30 minutos de uso, ou uma entrada na conta.`;
    $('#ac-hist-body').innerHTML = d.acessos.map(a => `<tr><td>${fmtHora(a.em)}</td><td>${esc(a.texto)}</td><td><code>${esc(a.ip)}</code></td><td>${a.evento === 'login' ? 'Entrou na conta' : 'Acesso'}</td><td class="hint" style="margin:0;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(a.navegador || '')}">${esc(a.navegador || '—')}</td></tr>`).join('') || '<tr><td colspan="5" class="hint">Sem registros.</td></tr>';
    $('#ac-hist').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) { globalMsg(err.message, false); }
});
$('#ac-ip-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const d = await api(`/api/admin/acessos/ip?ip=${encodeURIComponent(e.target.ip.value.trim())}`);
    $('#ac-ip-res').innerHTML = `<p><b>${esc(d.ip)}</b>: ${esc(d.local?.texto || 'local desconhecido (base sem esse IP ou ainda não baixada)')}</p>`
      + (d.contas.length ? `<div class="table-wrap"><table><thead><tr><th>Conta que usou este IP</th><th>Registros</th><th>Último</th></tr></thead><tbody>${d.contas.map(c => `<tr><td>${acConta(c)}</td><td class="num">${c.n}</td><td>${fmtHora(c.ultimo)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">Nenhuma conta usou este IP nos últimos 6 meses.</p>');
  } catch (err) { globalMsg(err.message, false); }
});

// Alertas de ofertas no WhatsApp particular
function mostrarAwa(d) {
  $('#awa-ativo').value = d.ativo ? '1' : '0';
  $('#awa-resumo').innerHTML = `<b>${d.pessoas}</b> pessoa(s) recebendo · <b>${d.enviados_hoje}</b> mensagem(ns) hoje${d.ativo && !d.disponivel ? ' · <span style="color:var(--red)">configure o WhatsApp acima para funcionar</span>' : ''}`;
}
async function loadAwa() { try { mostrarAwa(await api('/api/admin/alertas-whatsapp')); } catch { /* sem permissão */ } }
$('#awa-ativo').addEventListener('change', async e => {
  try { mostrarAwa(await api('/api/admin/alertas-whatsapp', { method: 'POST', body: { ativo: e.target.value === '1' } })); globalMsg('Alertas no WhatsApp ' + (e.target.value === '1' ? 'ligados.' : 'desligados.')); }
  catch (err) { globalMsg(err.message, false); }
});

// Avisos na entrada (janelas da tela de ofertas)
let AV = null;
const AV_SIT = { no_ar: ['b-active', 'No ar'], agendado: ['b-pending', 'Agendado'], pausado: ['b-pending', 'Pausado'], encerrado: ['b-rejected', 'Encerrado'] };
function aplicarAvisos(d) {
  AV = d;
  const f = $('#av-form');
  if (!$('#av-tipo').options.length) {
    const opts = o => Object.entries(o).map(([v, n]) => `<option value="${v}">${esc(n)}</option>`).join('');
    $('#av-tipo').innerHTML = opts(d.tipos); $('#av-publico').innerHTML = opts(d.publicos); $('#av-freq').innerHTML = opts(d.frequencias);
    f.tipo.value = 'novidade'; avTipo();
  }
  $('#av-max').textContent = d.max;
  const noAr = d.avisos.filter(a => a.situacao === 'no_ar').length;
  const kpiAv = document.getElementById('kpis-avisos');
  if (kpiAv) {
    const soma = c => dbNum(d.avisos.reduce((s, a) => s + (Number(a[c]) || 0), 0));
    kpiAv.innerHTML = abaKpi('ok', 'No ar agora', dbNum(noAr), `de ${dbNum(d.avisos.length)} criado(s)`) + abaKpi('pessoas', 'Vezes vistos', soma('visualizacoes')) + abaKpi('clique', 'Cliques', soma('cliques'));
    kpiAv.hidden = false;
  }
  $('#avisos-badge').textContent = noAr; $('#avisos-badge').classList.toggle('hidden', !noAr);
  const periodo = a => (a.inicio || a.fim ? `${a.inicio ? fmtDay(a.inicio) : 'já'} → ${a.fim ? fmtDay(a.fim) : 'sem fim'}` : 'Sempre');
  $('#av-body').innerHTML = d.avisos.length ? d.avisos.map(a => {
    const [cls, nome] = AV_SIT[a.situacao] || AV_SIT.pausado;
    return `<tr>
      <td><div class="av-linha">${a.imagem ? `<img src="${esc(a.imagem)}" alt="">` : ''}<span><b>${esc(a.titulo)}</b>${a.cupom ? `<br><code>${esc(a.cupom)}</code>` : ''}</span></div></td>
      <td>${esc(d.tipos[a.tipo])}</td><td>${esc(d.publicos[a.publico])}</td><td>${periodo(a)}</td><td>${esc(d.frequencias[a.frequencia])}</td>
      <td class="num">${a.visualizacoes}</td><td class="num">${a.cliques}</td>
      <td><span class="badge ${cls}">${nome}</span></td>
      <td class="num" style="white-space:nowrap"><button class="btn small" type="button" data-av-ver="${a.id}">Prévia</button>
        <button class="btn small" type="button" data-av-ligar="${a.id}">${a.ativo ? 'Pausar' : 'Pôr no ar'}</button>
        <button class="btn small" type="button" data-av-editar="${a.id}">Editar</button>
        <button class="btn small danger" type="button" data-av-excluir="${a.id}">Excluir</button></td></tr>`;
  }).join('') : '<tr><td colspan="9" class="hint">Nenhum aviso ainda. Crie o primeiro acima.</td></tr>';
}
async function loadAvisos() { aplicarAvisos(await api('/api/admin/avisos')); }
function avTipo() { $('#av-cupom-linha').classList.toggle('hidden', $('#av-form').tipo.value !== 'cupom'); }
function avImagem(url) {
  const f = $('#av-form'); f.imagem.value = url || '';
  $('#av-img-previa').hidden = !url; if (url) $('#av-img-previa').src = url;
  $('#av-img-tirar').hidden = !url; $('#av-img-enviar').textContent = url ? 'Trocar imagem' : 'Enviar imagem';
}
function limparAviso() {
  const f = $('#av-form'); f.reset(); f.id.value = ''; f.tipo.value = 'novidade'; avTipo(); avImagem('');
  $('#av-salvar').textContent = 'Publicar aviso'; $('#av-titulo-form').textContent = 'Novo aviso'; $('#av-cancelar').hidden = true;
}
const avDoForm = () => { const d = Object.fromEntries(new FormData($('#av-form'))); return { ...d, id: d.id || 0, versao: 0 }; };
$('#av-tipo').addEventListener('change', avTipo);
$('#av-img-enviar').addEventListener('click', () => $('#av-img-arq').click());
$('#av-img-tirar').addEventListener('click', () => avImagem(''));
$('#av-img-arq').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) return globalMsg('A imagem pode ter no máximo 3 MB.', false);
  try {
    const res = await fetch('/api/admin/publicidade/upload', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'Falha no envio.');
    avImagem(d.url);
  } catch (err) { globalMsg(err.message, false); }
});
$('#av-previa').addEventListener('click', () => {
  const a = avDoForm();
  if (!a.titulo.trim()) return globalMsg('Escreva o título para ver a prévia.', false);
  if (a.tipo !== 'cupom') a.cupom = '';
  if (a.link && !a.botao_texto) a.botao_texto = 'Saiba mais';
  OfertouAvisos.mostrar([a], { previa: true });
});
$('#av-form').addEventListener('submit', async e => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  try {
    aplicarAvisos(await api(d.id ? `/api/admin/avisos/${d.id}` : '/api/admin/avisos', { method: d.id ? 'PUT' : 'POST', body: d }));
    globalMsg(d.id ? 'Aviso salvo.' : 'Aviso publicado.'); limparAviso();
  } catch (err) { globalMsg(err.message, false); }
});
$('#av-cancelar').addEventListener('click', limparAviso);
$('#av-body').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  const id = Number(b.dataset.avVer || b.dataset.avLigar || b.dataset.avEditar || b.dataset.avExcluir);
  const a = AV.avisos.find(x => x.id === id); if (!a) return;
  try {
    if (b.dataset.avVer) OfertouAvisos.mostrar([a], { previa: true });
    else if (b.dataset.avLigar) aplicarAvisos(await api(`/api/admin/avisos/${id}`, { method: 'PATCH', body: { ativo: !a.ativo } }));
    else if (b.dataset.avExcluir) {
      if (!await OfertouUI.confirmar(`Excluir o aviso "${a.titulo}"?`, { perigo: true, ok: 'Excluir' })) return;
      aplicarAvisos(await api(`/api/admin/avisos/${id}`, { method: 'DELETE' }));
    } else {
      const f = $('#av-form');
      for (const k of ['id', 'tipo', 'titulo', 'texto', 'cupom', 'botao_texto', 'link', 'publico', 'frequencia', 'ordem']) f[k].value = a[k] ?? '';
      f.inicio.value = isoDay(a.inicio); f.fim.value = isoDay(a.fim); f.ativo.value = a.ativo ? '1' : '0';
      avTipo(); avImagem(a.imagem);
      $('#av-salvar').textContent = 'Salvar alterações'; $('#av-titulo-form').textContent = 'Editar aviso'; $('#av-cancelar').hidden = false;
      f.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  } catch (err) { globalMsg(err.message, false); }
});

// Vídeos patrocinados (moedas da Loja de cosméticos)
let VPS = [];
function renderVideosPat() {
  $('#vp-body').innerHTML = VPS.length ? VPS.map(v => `<tr>
    <td><b>${esc(v.titulo)}</b><br><a class="hint" style="margin:0" href="${esc(v.url)}" target="_blank" rel="noopener">abrir vídeo</a></td><td>${esc(v.anunciante)}</td>
    <td class="num">${v.duracao_s} s</td><td class="num">${v.moedas}</td><td class="num">${v.visualizacoes}</td>
    <td>${v.ativo ? '<span class="badge b-active">No ar</span>' : '<span class="badge b-pending">Pausado</span>'}</td>
    <td class="num"><button class="btn small" type="button" data-vp-editar="${v.id}">Editar</button> <button class="btn small danger" type="button" data-vp-excluir="${v.id}">Excluir</button></td></tr>`).join('')
    : '<tr><td colspan="7" class="hint">Nenhum vídeo cadastrado.</td></tr>';
}
async function loadVideosPat() { VPS = await api('/api/admin/videos-patrocinados'); renderVideosPat(); }
function limparVp() { const f = $('#vp-form'); f.reset(); f.id.value = ''; $('#vp-salvar').textContent = 'Adicionar vídeo'; $('#vp-cancelar').hidden = true; }
$('#vp-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, d = Object.fromEntries(new FormData(f));
  try {
    VPS = await api(d.id ? `/api/admin/videos-patrocinados/${d.id}` : '/api/admin/videos-patrocinados', { method: d.id ? 'PUT' : 'POST', body: d });
    renderVideosPat(); limparVp(); globalMsg('Vídeo salvo.');
  } catch (err) { globalMsg(err.message, false); }
});
$('#vp-cancelar').addEventListener('click', limparVp);
$('#vp-body').addEventListener('click', async e => {
  const ed = e.target.closest('[data-vp-editar]'), ex = e.target.closest('[data-vp-excluir]');
  if (ed) {
    const v = VPS.find(x => x.id === Number(ed.dataset.vpEditar)), f = $('#vp-form');
    for (const k of ['id', 'titulo', 'anunciante', 'url', 'duracao_s', 'moedas', 'ativo']) f[k].value = v[k];
    $('#vp-salvar').textContent = 'Salvar alterações'; $('#vp-cancelar').hidden = false; f.scrollIntoView({ block: 'center' });
  } else if (ex) {
    if (!await OfertouUI.confirmar('Excluir este vídeo patrocinado?')) return;
    try { VPS = await api(`/api/admin/videos-patrocinados/${ex.dataset.vpExcluir}`, { method: 'DELETE' }); renderVideosPat(); } catch (err) { globalMsg(err.message, false); }
  }
});

async function loadAds() {
  loadVideosPat().catch(() => {});
  ADS = await api('/api/admin/publicidade');
  $('#leads-badge').textContent = ADS.novos;
  $('#leads-badge').classList.toggle('hidden', !ADS.novos);
  const sel = $('#ad-espaco');
  if (!sel.options.length) sel.innerHTML = Object.entries(ADS.espacos).map(([id, e]) => `<option value="${id}">${esc(e.nome)}</option>`).join('');
  $('#ads-body').innerHTML = ADS.campanhas.length ? ADS.campanhas.map(c => {
    const ctr = c.impressoes ? ((c.cliques / c.impressoes) * 100).toFixed(1).replace('.', ',') + '%' : '—';
    return `<tr>
      <td>${okAdImg(c.imagem) ? `<img class="ad-thumb" src="${esc(c.imagem)}" alt="">` : '—'}${c.video ? '<span class="tag">▶ vídeo</span>' : ''}</td>
      <td><b>${esc(c.anunciante)}</b>${c.contato ? `<br><span class="hint" style="margin:0">${esc(c.contato)}</span>` : ''}</td>
      <td>${esc(ADS.espacos[c.espaco]?.nome || c.espaco)}</td>
      <td class="num">${fmtDay(c.inicio)} a ${fmtDay(c.fim)}</td>
      <td><span class="badge b-${c.situacao}">${AD_STATUS[c.situacao]}</span></td>
      <td class="num">${Number(c.impressoes).toLocaleString('pt-BR')}</td>
      <td class="num">${Number(c.cliques).toLocaleString('pt-BR')} <span class="hint">(${ctr})</span></td>
      <td class="num">
        <button class="btn small" data-adedit="${c.id}">Editar</button>
        <button class="btn small" data-adtoggle="${c.id}" data-ativo="${c.ativo}">${c.ativo ? 'Pausar' : 'Ativar'}</button>
        <button class="btn small danger" data-addel="${c.id}">Excluir</button>
      </td></tr>`;
  }).join('') : '<tr><td colspan="8" class="hint">Nenhuma campanha cadastrada.</td></tr>';
  $('#leads-body').innerHTML = ADS.pedidos.length ? ADS.pedidos.map(l => `<tr style="${l.status === 'novo' ? '' : 'opacity:.6'}">
      <td class="num">${fmtDate(l.created_at)}</td>
      <td><b>${esc(l.empresa)}</b><br><span class="hint" style="margin:0">${esc(l.nome)}</span></td>
      <td><a href="mailto:${esc(l.email)}">${esc(l.email)}</a>${l.telefone ? `<br><a href="https://wa.me/55${esc(l.telefone)}" target="_blank" rel="noopener">${esc(l.telefone)}</a>` : ''}</td>
      <td>${esc(ADS.espacos[l.espaco]?.nome || 'Não definido')}</td>
      <td style="max-width:320px;white-space:pre-wrap">${esc(l.mensagem || '—')}</td>
      <td class="num">
        <button class="btn small" data-leadst="${l.id}" data-st="${l.status === 'novo' ? 'atendido' : 'novo'}">${l.status === 'novo' ? 'Marcar atendido' : 'Reabrir'}</button>
        <button class="btn small" data-leadnew="${l.id}">Criar campanha</button>
        <button class="btn small danger" data-leaddel="${l.id}">Excluir</button>
      </td></tr>`).join('') : '<tr><td colspan="6" class="hint">Nenhum pedido recebido.</td></tr>';
}

let editingAd = null;
function updateAdForm() {
  const f = $('#ad-form');
  const e = ADS.espacos[f.espaco.value] || {};
  $('#ad-size-desk').textContent = e.tamanho ? `— recomendado ${e.tamanho} px (JPG, PNG ou WEBP até 3 MB)` : '';
  $('#ad-size-mob').textContent = e.mobile ? `— recomendado ${e.mobile} px` : '';
  $('#ad-mobile-field').classList.toggle('hidden', !e.mobile);
  $('#ad-prev').src = okAdImg(f.imagem.value) ? f.imagem.value : '';
  $('#ad-prev-m').src = okAdImg(f.imagem_mobile.value) ? f.imagem_mobile.value : '';
  const v = ADS.video || {};
  $('#ad-video-req').textContent = v.maxSegundos
    ? `— sem som, até ${v.maxSegundos} s, até ${v.maxBytes / 1048576} MB (ideal ${v.idealBytes / 1048576} MB), ${v.formatos}, mesma proporção da imagem. A imagem acima vira a capa.`
    : '';
  $('#ad-video-mobile-field').classList.toggle('hidden', !e.mobile);
  $('#ad-video-tag').textContent = f.video.value ? 'vídeo enviado' : 'sem vídeo';
  $('#ad-video-m-tag').textContent = f.video_mobile.value ? 'vídeo enviado' : 'sem vídeo';
}

// Envio do vídeo do banner (o servidor confere formato, tamanho e duração).
let videoTarget = null;
$('#ad-form').addEventListener('click', e => {
  const up = e.target.closest('[data-upload-video]');
  const clr = e.target.closest('[data-clear-video]');
  if (clr) { $('#ad-form')[clr.dataset.clearVideo].value = ''; updateAdForm(); return; }
  if (!up) return;
  videoTarget = up.dataset.uploadVideo;
  $('#ad-video-file').value = '';
  $('#ad-video-file').click();
});
$('#ad-video-file').addEventListener('change', async () => {
  const file = $('#ad-video-file').files[0];
  if (!file || !videoTarget) return;
  const max = (ADS.video?.maxBytes) || 8388608;
  if (file.size > max) return flash($('#ad-msg'), `O vídeo pode ter no máximo ${max / 1048576} MB.`, false);
  const tag = videoTarget === 'video' ? '#ad-video-tag' : '#ad-video-m-tag';
  $(tag).textContent = 'enviando…';
  try {
    const res = await fetch('/api/admin/publicidade/video', { method: 'POST', headers: { 'Content-Type': file.type || 'video/mp4' }, body: file });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || (res.status === 413 ? 'Vídeo grande demais.' : 'Falha no envio.'));
    $('#ad-form')[videoTarget].value = d.url;
  } catch (err) { flash($('#ad-msg'), err.message, false); }
  updateAdForm();
});

function openAd(c = null, preset = {}) {
  const f = $('#ad-form');
  f.reset();
  editingAd = c ? c.id : null;
  $('#ad-title').textContent = c ? `Editar campanha — ${c.anunciante}` : 'Nova campanha';
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const v = c ? { ...c, inicio: isoDay(c.inicio), fim: isoDay(c.fim) } : { inicio: hoje, ativo: 1, ...preset };
  for (const k of ['anunciante', 'contato', 'espaco', 'link', 'imagem', 'imagem_mobile', 'video', 'video_mobile', 'texto_alt', 'observacoes', 'inicio', 'fim']) {
    if (v[k] != null) f[k].value = v[k];
  }
  f.ativo.checked = Boolean(v.ativo);
  $('#ad-msg').innerHTML = '';
  updateAdForm();
  $('#ad-dlg').showModal();
}

$('#ad-new').addEventListener('click', () => openAd());
$('#ad-form').espaco.addEventListener('change', updateAdForm);
$('#ad-form').imagem.addEventListener('input', updateAdForm);
$('#ad-form').imagem_mobile.addEventListener('input', updateAdForm);
$('#ad-dlg').addEventListener('click', e => { if (e.target.closest('[data-close]')) $('#ad-dlg').close(); });

// Envio da arte do banner (arquivo binário, mesmo validador das fotos dos anúncios)
let uploadTarget = null;
$('#ad-form').addEventListener('click', e => {
  const b = e.target.closest('[data-upload]');
  if (!b) return;
  uploadTarget = b.dataset.upload;
  $('#ad-file').value = '';
  $('#ad-file').click();
});
$('#ad-file').addEventListener('change', async () => {
  const file = $('#ad-file').files[0];
  if (!file || !uploadTarget) return;
  if (file.size > 3 * 1024 * 1024) return flash($('#ad-msg'), 'A imagem pode ter no máximo 3 MB.', false);
  try {
    const res = await fetch('/api/admin/publicidade/upload', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'Falha no envio.');
    $('#ad-form')[uploadTarget].value = d.url;
    updateAdForm();
  } catch (err) { flash($('#ad-msg'), err.message, false); }
});

$('#ad-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const body = Object.fromEntries(new FormData(f));
  body.ativo = f.ativo.checked;
  try {
    await api(editingAd ? `/api/admin/publicidade/${editingAd}` : '/api/admin/publicidade', { method: editingAd ? 'PUT' : 'POST', body });
    $('#ad-dlg').close();
    await loadAds();
    globalMsg('Campanha salva.');
  } catch (err) { flash($('#ad-msg'), err.message, false); }
});

$('[data-body="ads"]').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  try {
    if (d.adedit) return openAd(ADS.campanhas.find(c => c.id === Number(d.adedit)));
    if (d.leadnew) {
      const l = ADS.pedidos.find(x => x.id === Number(d.leadnew));
      return openAd(null, { anunciante: l.empresa, contato: [l.email, l.telefone].filter(Boolean).join(' · '), espaco: l.espaco || undefined });
    }
    if (d.adtoggle) await api(`/api/admin/publicidade/${d.adtoggle}`, { method: 'PATCH', body: { ativo: d.ativo !== '1' } });
    else if (d.addel) {
      if (!await OfertouUI.confirmar('Excluir esta campanha? As estatísticas dela também serão apagadas.')) return;
      await api(`/api/admin/publicidade/${d.addel}`, { method: 'DELETE' });
    } else if (d.leadst) await api(`/api/admin/pedidos-publicidade/${d.leadst}`, { method: 'PATCH', body: { status: d.st } });
    else if (d.leaddel) {
      if (!await OfertouUI.confirmar('Excluir este pedido?')) return;
      await api(`/api/admin/pedidos-publicidade/${d.leaddel}`, { method: 'DELETE' });
    } else return;
    await loadAds();
  } catch (err) { globalMsg(err.message, false); }
});
