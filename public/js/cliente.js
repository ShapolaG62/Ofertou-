/* Ofertou! — painel do cliente da ferramenta: links de afiliado, canais, agendamento e histórico DELE */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmtDate = s => (s ? new Date(String(s).replace(' ', 'T') + (String(s).includes('T') ? '' : 'Z')).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const fmtDay = s => (String(s).startsWith('9999') ? 'sem vencimento' : s ? new Date(String(s).replace(' ', 'T') + 'Z').toLocaleDateString('pt-BR') : '—');
  const REDE = { telegram: 'Telegram', facebook: 'Facebook', instagram: 'Instagram', x: 'X (Twitter)', whatsapp: 'WhatsApp' };
  const FILA = { pendente: 'Na fila', postado: 'Postado', erro: 'Erro', expirado: 'Saiu do ar' };
  // Produto da fila/histórico: miniatura + nome que abre a oferta no site + link da loja
  function celulaProduto(r, nome) {
    const foto = /^(https:\/\/|\/uploads\/)/i.test(r.imagem || '') ? `<img class="post-foto" src="${esc(r.imagem)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="post-foto"></span>';
    const titulo = r.offer_id ? `<a class="post-nome" href="/oferta/${Number(r.offer_id)}" target="_blank" rel="noopener">${esc(nome)}</a>` : `<span class="post-nome">${esc(nome)}</span>`;
    const loja = /^https:\/\//i.test(r.original_url || '') ? `<a class="post-loja" href="${esc(r.original_url)}" target="_blank" rel="noopener noreferrer">Ver na loja ↗</a>` : '';
    return `<div class="post-prod">${foto}<div>${titulo}${loja}</div></div>`;
  }
  let CFG = {};

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.endsWith('/entrar')) { mostrarLogin(); throw new Error(data.error || 'Sessão expirada.'); }
    if (!res.ok) throw Object.assign(new Error(data.error || `Erro ${res.status}`), { reativar: data.reativar || null });
    return data;
  }

  let toastTimer;
  function toast(t) {
    const el = $('#toast'); el.textContent = t; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
  }
  function msg(el, texto, ok = true) {
    el.innerHTML = `<div class="form-msg ${ok ? 'ok' : 'err'}">${esc(texto)}</div>`;
    if (ok) setTimeout(() => { el.innerHTML = ''; }, 5000);
  }

  // ── Login ──────────────────────────────────────────────────────────────────
  function mostrarLogin() {
    $('#view-app').hidden = true; $('#view-login').hidden = false;
    ['#go-offers', '#go-posts', '#logout'].forEach(s => { $(s).hidden = true; });
  }

  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const box = $('#login-msg');
    box.hidden = true;
    try {
      await api('/api/cliente/entrar', { method: 'POST', body: { email: f.email.value, senha: f.senha.value } });
      f.reset();
      abrir();
    } catch (err) {
      box.textContent = err.message; box.hidden = false;
      if (err.reativar) {
        const a = document.createElement('a');
        a.className = 'btn btn-primary btn-block form-reativar';
        a.href = err.reativar;
        a.textContent = 'Reativar plano';
        box.appendChild(a);
      }
    }
  });

  $('#logout').addEventListener('click', async () => {
    await fetch('/api/cliente/sair', { method: 'POST' });
    location.reload();
  });

  // ── Painel ─────────────────────────────────────────────────────────────────
  async function abrir() {
    const me = await fetch('/api/cliente/me').then(r => r.json()).catch(() => ({}));
    if (!me.cliente) return mostrarLogin();
    $('#view-login').hidden = true; $('#view-app').hidden = false;
    ['#go-offers', '#go-posts', '#logout'].forEach(s => { $(s).hidden = false; });
    $('#cli-nome').textContent = me.cliente.nome.split(' ').slice(0, 2).join(' ');
    $('#cli-avatar').textContent = (me.cliente.nome.trim()[0] || '?').toUpperCase();
    $('#cli-plano').textContent = me.cliente.plano || 'Afiliado';
    $('#cli-validade').textContent = String(me.cliente.validade).startsWith('9999') ? 'Acesso sem vencimento.' : `Acesso válido até ${fmtDay(me.cliente.validade)}.`;
    // Termos do Afiliado ainda não aceitos (acesso criado pelo painel ou antes dos Termos): pede antes de abrir o painel
    await OfertouAceiteParceiro.pedir(me.parceiro_pendente, '/api/cliente/aceite-parceiro', '/api/cliente/sair');
    await carregarConfig();
    carregarPainel().catch(() => {});
    carregarSugestoes().catch(() => {});
  }

  // ── Dashboard ──────────────────────────────────────────────────────────────
  let DIAS = 7;
  const num = n => Number(n || 0).toLocaleString('pt-BR');
  const ICONE_KPI = {
    enviados: '<path d="M3 11l18-8-8 18-2-8z"/>',
    conexoes: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
    fila: '<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2v4M16 2v4M3 10h18"/>',
    cliques: '<path d="M9 3v4M3 9h4M5.6 5.6l2.8 2.8M12 12l9 3-4 2-2 4z"/>',
  };
  const kpi = (id, titulo, valor, sub, cor) => `<div class="cli-kpi cli-kpi-${cor}">
      <span class="cli-kpi-ico"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONE_KPI[id]}</svg></span>
      <div><small>${titulo}</small><b>${valor}</b><em>${sub}</em></div></div>`;
  async function carregarPainel() {
    const d = await api(`/api/cliente/painel?dias=${DIAS}`);
    const prontas = d.redes.filter(r => r.pronta);
    const lembrete = d.lembrete_planilha || [];
    $('#cli-lembrete').hidden = !lembrete.length;
    if (lembrete.length) $('#cli-lembrete').textContent = `Hora de enviar a planilha de vendas: ${lembrete.join(', ')}. Toque para abrir.`;
    mostrarPassos(d);
    const periodo = DIAS === 1 ? 'hoje' : `nos últimos ${DIAS} dias`;
    $('#cli-kpis').innerHTML = [
      kpi('enviados', 'Mensagens enviadas', num(d.enviados), d.falhas ? `${num(d.falhas)} com falha ${periodo}` : periodo, 'verde'),
      kpi('conexoes', 'Redes conectadas', `${prontas.length}/${d.redes.length}`, prontas.length ? prontas.map(r => r.nome).join(', ') : 'nenhuma ainda', 'azul'),
      kpi('fila', 'Na fila', num(d.fila), d.agenda.ativa ? `agendamento ligado${d.agenda.proximo ? ` · próximo ${d.agenda.proximo}` : ''}` : 'agendamento desligado', 'laranja'),
      kpi('cliques', 'Comissão', Number(d.comissao || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }), `${num(d.cliques)} cliques nos seus links`, 'roxo'),
    ].join('');
    // Gráfico de barras (enviadas e falhas por dia)
    const max = Math.max(1, ...d.serie.map(x => x.ok + x.erro));
    const rot = s => new Date(s + 'T12:00:00Z').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    $('#cli-graf-sub').textContent = `Volume de mensagens ${periodo}${d.ultimo_envio ? ` · último envio em ${fmtDate(d.ultimo_envio)}` : ''}`;
    const LOJA = { mercadolivre: ['Mercado Livre', '#ffd400'], shopee: ['Shopee', '#ee4d2d'], amazon: ['Amazon', '#ff9900'], magalu: ['Magalu', '#0086ff'], aliexpress: ['AliExpress', '#c81e1e'], kabum: ['KaBuM!', '#14418b'], outros: ['Outras', '#8a9a91'] };
    const corDe = l => (LOJA[l] || LOJA.outros)[1];
    const nomeDe = l => (LOJA[l] || LOJA.outros)[0];
    const usadas = [...new Set(d.serie.flatMap(x => Object.keys(x.lojas || {})))];
    $('#cli-graf').innerHTML = `<div class="cli-barras" style="--n:${d.serie.length}">${d.serie.map(x => {
      const partes = Object.entries(x.lojas || {});
      const dica = partes.map(([l, n]) => `${nomeDe(l)}: ${n}`).join(', ');
      return `<div class="cli-barra" title="${rot(x.dia)}: ${x.ok} enviada(s)${dica ? ` (${esc(dica)})` : ''}${x.erro ? `, ${x.erro} com falha` : ''}">
        <span class="cli-barra-pilha">${partes.map(([l, n]) => `<i style="height:${(n / max) * 100}%;background:${corDe(l)}"></i>`).join('')}<i class="erro" style="height:${(x.erro / max) * 100}%"></i></span>
        <small>${d.serie.length > 10 ? (x.dia.endsWith('01') || x.dia.endsWith('15') ? rot(x.dia) : '') : rot(x.dia)}</small>
      </div>`;
    }).join('')}</div>
      <div class="cli-legenda">${usadas.map(l => `<span><i style="background:${corDe(l)}"></i>${esc(nomeDe(l))}</span>`).join('')}<span><i class="erro"></i>Com falha</span></div>`;
    // Rosca: redes conectadas
    const pct = d.redes.length ? (prontas.length / d.redes.length) * 100 : 0;
    $('#cli-rosca').innerHTML = `<div class="cli-rosca" style="--pct:${pct}%"><div><b>${prontas.length}</b><small>de ${d.redes.length}</small></div></div>`;
    // Conexões
    const linha = (ok, nome, det) => `<li class="${ok ? 'on' : 'off'}"><span class="cli-ponto"></span><div><b>${esc(nome)}</b><small>${esc(det)}</small></div></li>`;
    $('#cli-conexoes').innerHTML = d.redes.map(r => r.id === 'whatsapp'
      ? linha(r.pronta, 'WhatsApp', r.pronta ? `${d.grupos_whatsapp} grupo(s)` : r.motivo || 'não configurado')
      : linha(r.pronta, r.nome, r.pronta ? 'Conectado' : r.motivo || 'não configurado')).join('')
      + (d.sem_afiliado.length ? linha(false, 'Links de afiliado', `faltam: ${d.sem_afiliado.join(', ')}`) : linha(true, 'Links de afiliado', 'todas as lojas configuradas'));
  }
  // Primeiros passos: o que falta para a ferramenta começar a render (some quando está tudo feito)
  function mostrarPassos(d) {
    const zap = d.redes.find(r => r.id === 'whatsapp');
    const lojasFeitas = 6 - d.sem_afiliado.length;
    const passos = [
      { ok: lojasFeitas > 0, tit: 'Coloque seus links de afiliado', det: d.sem_afiliado.length ? `${lojasFeitas} de 6 lojas · faltam: ${d.sem_afiliado.join(', ')}` : 'Todas as lojas', tab: 'afiliados' },
      { ok: d.redes.some(r => r.pronta), tit: 'Conecte o WhatsApp ou outra rede', det: 'Leia o QR code para enviar nos seus grupos', tab: 'whatsapp' },
      ...(zap?.pronta ? [{ ok: d.grupos_whatsapp > 0, tit: 'Escolha os grupos do WhatsApp', det: `${d.grupos_whatsapp} grupo(s) escolhido(s)`, tab: 'whatsapp' }] : []),
      { ok: Boolean(d.ultimo_envio), tit: 'Faça a primeira postagem', det: 'Use as sugestões abaixo ou escolha em Ver ofertas', link: '/postagens' },
      { ok: Boolean(d.agenda.ativa), tit: 'Ligue o agendamento', det: 'O site posta sozinho nos seus horários', tab: 'agenda' },
    ];
    const feitos = passos.filter(p => p.ok).length;
    $('#cli-passos-card').hidden = feitos === passos.length;
    $('#cli-passos-n').textContent = `${feitos} de ${passos.length}`;
    $('#cli-passos-barra').style.width = `${(feitos / passos.length) * 100}%`;
    $('#cli-passos').innerHTML = passos.map(p => `<li class="${p.ok ? 'ok' : ''}"><span class="cli-passo-marca">${p.ok ? '✓' : ''}</span>
      <div><b>${esc(p.tit)}</b><small>${esc(p.det)}</small></div>
      ${p.ok ? '' : p.link ? `<a class="btn btn-sm" href="${p.link}">Fazer</a>` : `<button class="btn btn-sm" type="button" data-ir="${p.tab}">Fazer</button>`}</li>`).join('');
  }
  $('#cli-lembrete').addEventListener('click', () => document.querySelector('.tabs-line [data-tab="comissao"]')?.click());
  $('#cli-passos').addEventListener('click', e => {
    const b = e.target.closest('[data-ir]');
    if (b) document.querySelector(`.tabs-line [data-tab="${b.dataset.ir}"]`)?.click();
  });

  // Sugestões para postar hoje
  let SUG = [], sugPula = 0;
  const reais = v => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = v => `${String(Math.round(Number(v) * 10) / 10).replace('.', ',')}%`;
  async function carregarSugestoes() {
    const d = await api('/api/cliente/sugestoes');
    SUG = d.itens || [];
    sugPula = 0;
    mostrarSugestoes();
  }
  function mostrarSugestoes() {
    const lista = SUG.slice(sugPula, sugPula + 6);
    $('#cli-sug-todas').hidden = $('#cli-sug-novas').hidden = !lista.length;
    $('#cli-sug-novas').hidden = SUG.length <= 6;
    $('#cli-sug').innerHTML = lista.map(o => `<div class="cli-sug-item" data-id="${o.id}">
        <div class="cli-sug-foto"><img src="/img/p/${o.id}.webp" alt="" loading="lazy"><span>-${Math.round(o.desconto_pct)}%</span></div>
        <small>${esc(o.plataforma)}</small><b title="${esc(o.produto)}">${esc(o.produto)}</b>
        <div class="cli-sug-preco">R$ ${reais(o.preco_atual)}</div>
        <div class="cli-sug-tags">${o.comissao_extra_pct > 0 ? `<em class="extra">Extra +${pct(o.comissao_extra_pct)}</em>` : o.comissao_pct ? `<em>Comissão ${pct(o.comissao_pct)}</em>` : ''}${o.cupom_texto ? '<em>Cupom</em>' : ''}</div>
        <button class="btn btn-sm" type="button" data-fila="${o.id}">Pôr na fila</button>
      </div>`).join('') || '<p class="cli-hint">Nenhuma sugestão agora. Confira se os seus links de afiliado estão preenchidos ou se o agendamento não está filtrando demais.</p>';
  }
  async function porNaFila(ids) {
    const r = await fetch('/api/postagens/fila', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itens: ids.map(offer_id => ({ offer_id })) }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Erro ${r.status}`);
    toast(`${d.adicionados} na fila. Total: ${d.pendentes}. Ela sai nos horários do agendamento.`);
    carregarPainel().catch(() => {});
  }
  $('#cli-sug').addEventListener('click', async e => {
    const b = e.target.closest('[data-fila]');
    if (!b) return;
    b.disabled = true;
    try { await porNaFila([Number(b.dataset.fila)]); b.textContent = 'Na fila ✓'; }
    catch (err) { b.disabled = false; toast(err.message); }
  });
  $('#cli-sug-todas').addEventListener('click', async e => {
    const ids = SUG.slice(sugPula, sugPula + 6).map(o => o.id);
    e.target.disabled = true;
    try { await porNaFila(ids); $$('#cli-sug [data-fila]').forEach(b => { b.disabled = true; b.textContent = 'Na fila ✓'; }); }
    catch (err) { toast(err.message); }
    e.target.disabled = false;
  });
  $('#cli-sug-novas').addEventListener('click', () => { sugPula = sugPula + 6 >= SUG.length ? 0 : sugPula + 6; mostrarSugestoes(); });

  $('#cli-periodo').addEventListener('click', e => {
    const b = e.target.closest('[data-dias]');
    if (!b) return;
    DIAS = Number(b.dataset.dias);
    $$('#cli-periodo [data-dias]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    carregarPainel().catch(err => toast(err.message));
  });

  // ── Barra "cole o link" (gera o link de afiliado do cliente) ────────────────
  $('#cli-busca').addEventListener('submit', async e => {
    e.preventDefault();
    const url = $('#cli-busca-url').value.trim(), box = $('#cli-busca-res');
    if (!url) return;
    box.hidden = false; box.innerHTML = '<p class="cli-hint">Gerando o seu link…</p>';
    try {
      const r = await fetch('/api/postagens/converter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Erro ${r.status}`);
      box.innerHTML = `<div class="cli-busca-card"><div><small>${esc(d.loja)} · seu link de afiliado</small><code>${esc(d.link)}</code>
        ${d.aviso ? `<em>${esc(d.aviso)}</em>` : ''}</div>
        <div class="cli-busca-acoes"><button class="btn btn-primary btn-sm" type="button" data-copiar>Copiar link</button>
        <button class="btn btn-sm" type="button" data-fechar>Fechar</button></div></div>`;
      box.querySelector('[data-copiar]').addEventListener('click', () => navigator.clipboard.writeText(d.link).then(() => toast('Link copiado.')));
      box.querySelector('[data-fechar]').addEventListener('click', () => { box.hidden = true; $('#cli-busca-url').value = ''; });
    } catch (err) { box.innerHTML = `<p class="form-msg err">${esc(err.message)}</p>`; }
  });
  // Colou um link: gera na hora
  $('#cli-busca-url').addEventListener('paste', () => setTimeout(() => $('#cli-busca').requestSubmit(), 50));
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !$('#view-app').hidden) { e.preventDefault(); $('#cli-busca-url').focus(); }
  });

  async function carregarConfig() {
    const d = await api('/api/cliente/config');
    CFG = d.config;
    for (const form of $$('.cfg-form')) {
      for (const el of form.elements) {
        if (!el.name) continue;
        if (el.dataset.secret !== undefined) {
          el.value = '';
          el.placeholder = CFG[`${el.name}_set`] ? '•••••••• (configurado — deixe vazio para manter)' : 'não configurado';
        } else if (el.name in CFG) el.value = CFG[el.name] ?? '';
      }
    }
    let redes = [];
    try { redes = JSON.parse(CFG.agenda_redes || '[]'); } catch { /* vazio */ }
    $$('[data-agenda-rede]').forEach(c => { c.checked = redes.includes(c.dataset.agendaRede); });
    const falta = d.sem_afiliado || [];
    $('#aviso-afiliado').hidden = !falta.length;
    $('#aviso-afiliado').innerHTML = falta.length
      ? `Ainda sem link de afiliado seu: <b>${falta.map(esc).join(', ')}</b>. Produtos dessas lojas vão <b>sem comissão</b> até você configurar em "Links de afiliado".`
      : '';
    atualizarWa();
    if (!$('#modelo-texto').value.trim() && window.OfertouModelo) $('#modelo-texto').value = OfertouModelo.PADRAO; // vazio = padrão: mostra o texto dele
    previaModelo();
    carregarGrupoAutomacao();
  }

  // Grupo de automação
  async function carregarGrupoAutomacao() {
    try {
      const d = await api('/api/cliente/grupo-automacao');
      const sel = $('#ga-grupo');
      if (d.controle && ![...sel.options].some(o => o.value === d.controle)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(d.controle)}">${esc(d.controle)} (escolhido)</option>`);
      sel.value = d.controle;
    } catch { /* sem acesso */ }
  }
  $('#ga-carregar').addEventListener('click', async () => {
    $('#ga-msg').textContent = 'Carregando os grupos do número…';
    try {
      const d = await api('/api/cliente/whatsapp/grupos');
      $('#ga-grupo').innerHTML = '<option value="">— escolha o grupo de automação —</option>' + d.grupos.map(g => `<option value="${esc(g.id)}" ${g.id === CFG.wa_grupo_controle ? 'selected' : ''}>${esc(g.nome)}</option>`).join('');
      $('#ga-msg').textContent = `${d.grupos.length} grupo(s). Escolha um e clique em Salvar grupo.`;
    } catch (err) { $('#ga-msg').textContent = err.message; }
  });
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


  // Abas
  $('.tabs-line').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    $$('.tabs-line [data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    $$('.cli-tab').forEach(t => { t.hidden = t.dataset.body !== b.dataset.tab; });
    if (b.dataset.tab === 'redes') previaModelo();
    if (b.dataset.tab === 'agenda') carregarAgenda().catch(err => toast(err.message));
    if (b.dataset.tab === 'inicio') carregarPainel().catch(() => {});
    if (b.dataset.tab === 'historico') carregarHistorico().catch(err => toast(err.message));
  });

  // Salvar qualquer formulário de configuração (campos secretos vazios mantêm o valor atual).
  $$('.cfg-form').forEach(form => form.addEventListener('submit', async e => {
    e.preventDefault();
    const body = {};
    for (const el of form.elements) if (el.name) body[el.name] = el.value;
    const redes = $$('[data-agenda-rede]', form);
    if (redes.length) body.agenda_redes = redes.filter(c => c.checked).map(c => c.dataset.agendaRede);
    try {
      await api('/api/cliente/config', { method: 'PUT', body });
      toast('Salvo!');
      await carregarConfig();
      if (redes.length) carregarAgenda().catch(() => {});
    } catch (err) { toast(err.message); }
  }));

  // ── WhatsApp ───────────────────────────────────────────────────────────────
  function atualizarWa() {
    let g = [];
    try { g = JSON.parse(CFG.whatsapp_groups || '[]'); } catch { /* vazio */ }
    $('#wa-chosen').innerHTML = g.length ? `Grupos de destino: <b>${g.map(x => esc(x.nome)).join(', ')}</b>` : 'Nenhum grupo de destino escolhido ainda.';
  }

  async function salvarWa() {
    const form = $('#wa-load').form;
    const body = {};
    for (const el of form.elements) if (el.name) body[el.name] = el.value;
    await api('/api/cliente/config', { method: 'PUT', body });
    await carregarConfig();
  }

  $('#wa-test').addEventListener('click', async () => {
    try { await salvarWa(); const r = await api('/api/cliente/whatsapp/status'); msg($('#wa-msg'), r.mensagem, r.conectado); }
    catch (err) { msg($('#wa-msg'), err.message, false); }
  });

  $('#wa-load').addEventListener('click', async () => {
    const b = $('#wa-load');
    b.disabled = true; b.textContent = 'Carregando…';
    try {
      await salvarWa();
      const r = await api('/api/cliente/whatsapp/grupos');
      if (!$('#wa-groups').dataset.ligado) { $('#wa-groups').dataset.ligado = '1'; OfertouTemas.ligar($('#wa-groups')); }
      $('#wa-groups').innerHTML = r.grupos.length
        ? r.grupos.map(g => OfertouTemas.linha(g, r.temas, r.lojas)).join('')
        : '<span class="cli-hint">Nenhum grupo criado e administrado por este número.</span>';
      $('#wa-ocultos').textContent = OfertouTemas.avisoOcultos(r.ocultos);
      $('#wa-groups-box').hidden = false;
    } catch (err) { msg($('#wa-msg'), err.message, false); }
    b.disabled = false; b.textContent = 'Carregar meus grupos';
  });

  $('#wa-save-groups').addEventListener('click', async () => {
    const grupos = OfertouTemas.ler($('#wa-groups'));
    try { await api('/api/cliente/config', { method: 'PUT', body: { whatsapp_groups: grupos } }); await carregarConfig(); msg($('#wa-msg'), `${grupos.length} grupo(s) salvos.`); }
    catch (err) { msg($('#wa-msg'), err.message, false); }
  });

  // ── Agendamento e fila ─────────────────────────────────────────────────────
  async function carregarAgenda() {
    const { estado, fila } = await api('/api/cliente/agenda');
    const ult = estado.ultimaExecucao;
    $('#agenda-estado').innerHTML = `${estado.ativa ? `<b>Ligado</b> · ${estado.horarios.join(', ')} · próximo: <b>${esc(estado.proximo || '—')}</b>` : '<b>Desligado</b>'}
      · ${estado.pendentes} oferta(s) na fila${estado.rodando ? ' · <b>publicando agora…</b>' : ''}
      ${ult ? `<br>Última rodada: ${ult.feitos.filter(f => f.ok).length} de ${ult.feitos.length} publicadas em ${fmtDate(ult.em)}${ult.conferidos ? ` · ${ult.conferidos} com preço conferido na loja na hora` : ''}${ult.pulados?.length ? ` · ${ult.pulados.length} pulada(s) por mudança na loja, no tema ou foto recusada` : ''}` : ''}
      ${estado.problema ? `<br><b>Atenção:</b> ${esc(estado.problema.mensagem)}` : ''}`;
    $('#fila-body').innerHTML = fila.length ? fila.map(q => `<tr>
        <td>${celulaProduto(q, q.produto || `oferta #${q.offer_id}`)}</td>
        <td><span class="status-pill ${q.status === 'postado' ? 'ok' : q.status === 'erro' ? 'err' : ''}">${FILA[q.status] || q.status}</span></td>
        <td class="cli-hint">${esc(q.resultado || '')}</td>
        <td>${q.status === 'pendente' ? `<button class="btn btn-sm" type="button" data-fila-del="${q.id}">Tirar</button>` : ''}</td></tr>`).join('')
      : '<tr><td colspan="4" class="cli-hint">A fila está vazia.</td></tr>';
  }
  $('#fila-body').addEventListener('click', async e => {
    const b = e.target.closest('[data-fila-del]');
    if (!b) return;
    try { await api(`/api/cliente/agenda/fila/${b.dataset.filaDel}`, { method: 'DELETE' }); carregarAgenda(); } catch (err) { toast(err.message); }
  });
  $('#fila-limpar').addEventListener('click', async () => {
    try { await api('/api/cliente/agenda/fila', { method: 'DELETE' }); carregarAgenda(); toast('Fila limpa.'); } catch (err) { toast(err.message); }
  });
  $('#agenda-run').addEventListener('click', async () => {
    try {
      await api('/api/cliente/agenda/executar', { method: 'POST', body: {} });
      toast('Rodada iniciada: as ofertas serão publicadas com o intervalo configurado.');
      setTimeout(() => carregarAgenda().catch(() => {}), 1500);
    } catch (err) { toast(err.message); }
  });

  // ── Histórico ──────────────────────────────────────────────────────────────
  async function carregarHistorico() {
    const rows = await api('/api/postagens/historico');
    $('#hist-body').innerHTML = rows.length ? rows.map(r => `<tr>
        <td>${fmtDate(r.created_at)}</td><td>${celulaProduto(r, r.produto || '—')}</td><td>${esc(REDE[r.rede] || r.rede)}</td>
        <td>${r.ok ? '<span class="status-pill ok">Publicado</span>' : `<span class="status-pill err">Erro</span> <span class="cli-hint">${esc(r.mensagem || '')}</span>`}</td></tr>`).join('')
      : '<tr><td colspan="4" class="cli-hint">Nenhuma postagem ainda.</td></tr>';
  }

  // ── Conta ──────────────────────────────────────────────────────────────────
  $('#senha-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    try { await api('/api/cliente/senha', { method: 'POST', body: { atual: f.atual.value, nova: f.nova.value } }); f.reset(); toast('Senha alterada.'); }
    catch (err) { toast(err.message); }
  });

  abrir().catch(() => mostrarLogin());
})();
