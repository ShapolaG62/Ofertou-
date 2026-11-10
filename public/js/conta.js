/* Ofertou! — login (e-mail ou Google), primeiro acesso, área do usuário e criador de anúncios */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const brl = v => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = s => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const parseMoney = s => {
    let c = String(s || '').replace(/[^\d.,]/g, '');
    if (c.includes(',')) c = c.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(c);
    return Number.isFinite(n) ? n : null;
  };

  let ME = null, LOJA = null;
  let INFO = { ufs: [], ramos: [], categorias: [], condicoes: {}, fretes: {}, max_fotos: 6, google: false };
  const CAT_LABELS = {
    informatica: 'Informática', celulares: 'Celulares, tablets e relógios', games: 'Games',
    audio_tv: 'TV, áudio e casa inteligente', eletrodomesticos: 'Eletrodomésticos', cozinha: 'Cozinha e eletroportáteis',
    casa: 'Casa, móveis e decoração', ferramentas: 'Ferramentas e construção', beleza: 'Beleza e cuidados pessoais',
    saude: 'Saúde e bem-estar', esporte: 'Esporte e fitness', moda: 'Moda e acessórios', brinquedos: 'Bebês e brinquedos',
    automotivo: 'Automotivo', pets: 'Pet shop', limpeza: 'Limpeza', alimentos: 'Alimentos e bebidas', outros: 'Outros',
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.raw ? { 'Content-Type': opts.raw.type } : opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.raw ? opts.raw : opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Erro ${res.status}`), { reativar: data.reativar || null, precisa_codigo: Boolean(data.precisa_codigo) });
    return data;
  }

  function msg(form, text, ok = false) {
    const el = form.querySelector('.form-msg');
    el.hidden = !text;
    el.className = `form-msg ${ok ? 'ok' : 'err'}`;
    el.textContent = text || '';
    if (text && !ok) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  let toastTimer;
  function toast(t) {
    const el = $('#toast');
    el.textContent = t; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  const formData = form => Object.fromEntries(new FormData(form));

  function bind(sel, handler) {
    $(sel).addEventListener('submit', async e => {
      e.preventDefault();
      const form = e.target, btn = form.querySelector('[type=submit]');
      msg(form, '');
      btn.disabled = true;
      try { await handler(form, formData(form)); } catch (err) {
        msg(form, err.message);
        // Login em duas etapas do administrador: senha certa, falta o código
        if (err.precisa_codigo && form.querySelector('#entrar-codigo')) { form.querySelector('#entrar-codigo').hidden = false; form.codigo.value = ''; form.codigo.focus(); }
        // Plano vencido: botão para reativar logo abaixo da mensagem
        if (err.reativar) {
          const a = document.createElement('a');
          a.className = 'btn btn-primary btn-block form-reativar';
          a.href = err.reativar;
          a.textContent = 'Reativar plano';
          form.querySelector('.form-msg').appendChild(a);
        }
      }
      btn.disabled = false;
    });
  }

  // ── Campos cadastrais (primeiro acesso e "Meus dados") ─────────────────────
  const field = (label, input, extra = '') => `<label class="field"><span>${label}${extra}</span>${input}</label>`;
  const inp = (name, attrs = '') => `<input name="${name}" ${attrs}>`;
  const opt = ' <span class="hint-inline">(opcional)</span>';

  function addressFields(prefix, title) {
    const p = n => `${prefix}${n}`;
    return `<fieldset class="form-section" data-address="${prefix}">
      <legend>${title}</legend>
      <div class="form-row-addr">
        ${field('CEP', inp(p('cep'), 'inputmode="numeric" data-mask="cep" maxlength="9" placeholder="00000-000" autocomplete="postal-code"'))}
        ${field('Rua / avenida', inp(p('logradouro'), 'maxlength="120" autocomplete="address-line1"'))}
        ${field('Número', inp(p('numero'), 'maxlength="10"'))}
      </div>
      <div class="form-row">
        ${field('Complemento', inp(p('complemento'), 'maxlength="60" placeholder="Apto, sala, bloco..."'), opt)}
        ${field('Bairro', inp(p('bairro'), 'maxlength="60"'))}
      </div>
      <div class="form-row">
        ${field('Cidade', inp(p('cidade'), 'maxlength="60" autocomplete="address-level2"'))}
        ${field('Estado (UF)', `<select name="${p('uf')}"><option value="">Selecione</option>${INFO.ufs.map(u => `<option>${u}</option>`).join('')}</select>`)}
      </div>
    </fieldset>`;
  }

  function pessoaFields(mode) {
    const cadastro = mode === 'cadastro';
    return `<fieldset class="form-section">
      <legend>${cadastro ? 'Seus dados' : 'Dados pessoais'}</legend>
      ${field('Nome completo', inp('nome', 'maxlength="100" autocomplete="name"'))}
      <div class="form-row-3">
        ${field('CPF', inp('cpf', `inputmode="numeric" data-mask="cpf" maxlength="14" placeholder="000.000.000-00" ${cadastro ? '' : 'disabled'}`))}
        ${field('Data de nascimento', inp('data_nascimento', 'type="date" autocomplete="bday"'))}
        ${field('Celular / WhatsApp', inp('telefone', 'inputmode="tel" data-mask="tel" maxlength="15" placeholder="(11) 90000-0000" autocomplete="tel"'))}
      </div>
    </fieldset>
    ${addressFields('', cadastro ? 'Seu endereço' : 'Endereço')}`;
  }

  function empresaFields(mode) {
    const cadastro = mode === 'cadastro';
    // Loja parceira: pessoa jurídica (CNPJ, dados puxados da Receita) ou pessoa física (vende com o CPF)
    const tipo = cadastro
      ? `<div class="tipo-loja" role="radiogroup" aria-label="Tipo de loja">
          <label class="ass-metodo"><input type="radio" name="empresa_tipo" value="pj" checked><span><b>Pessoa jurídica</b><small>Empresa com CNPJ</small></span></label>
          <label class="ass-metodo"><input type="radio" name="empresa_tipo" value="pf"><span><b>Pessoa física</b><small>Vendo com o meu CPF</small></span></label>
        </div>`
      : '<input type="hidden" name="empresa_tipo">';
    return `<fieldset class="form-section">
      <legend data-rotulo-pf="Dados da loja (pessoa física)">Dados da empresa</legend>
      ${tipo}
      <p class="hint" data-so-pf hidden>A loja fica no seu nome e CPF (informados acima). Não é preciso ter CNPJ.</p>
      <div data-so-pj>${field('CNPJ', inp('cnpj', `inputmode="numeric" data-mask="cnpj" maxlength="18" placeholder="00.000.000/0000-00" ${cadastro ? '' : 'disabled'}`), cadastro ? ' <span class="hint-inline">(os dados da empresa são preenchidos sozinhos)</span>' : '')}</div>
      <div data-so-pj>${field('Razão social', inp('razao_social', 'maxlength="150" autocomplete="organization"'))}</div>
      <div class="form-row">
        <label class="field"><span data-rotulo-pf="Nome da loja">Nome fantasia</span>${inp('empresa_nome', 'maxlength="80"')}</label>
        <label class="field"><span data-rotulo-pf="Telefone da loja (opcional)">Telefone da empresa</span>${inp('telefone_empresa', 'inputmode="tel" data-mask="tel" maxlength="15" placeholder="(11) 3000-0000"')}</label>
      </div>
      <div class="form-row" data-so-pj>
        ${field('Inscrição estadual', inp('inscricao_estadual', 'maxlength="20" placeholder="Isento, se não tiver"'), opt)}
      </div>
      <div class="form-row">
        ${field('Ramo de atividade', `<select name="ramo"><option value="">Selecione</option>${INFO.ramos.map(r => `<option>${esc(r)}</option>`).join('')}</select>`)}
        ${field('Site da empresa', inp('site_empresa', 'type="url" maxlength="200" placeholder="https://"'), opt)}
      </div>
      <label class="check-line"><input type="checkbox" name="mesmo_endereco" data-same-address> <span data-rotulo-pf="O endereço da loja é o mesmo informado acima">O endereço da empresa é o mesmo informado acima</span></label>
    </fieldset>
    ${addressFields('emp_', 'Endereço da empresa')}`;
  }

  function renderFieldBlocks() {
    $$('[data-fields]').forEach(el => {
      el.innerHTML = el.dataset.fields === 'pessoa' ? pessoaFields(el.dataset.mode) : empresaFields(el.dataset.mode);
      window.OfertouCadastro?.aplicarTipo(el.closest('form'));
    });
  }

  const MASKS = {
    cpf: d => d.slice(0, 11).replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2'),
    cnpj: d => d.slice(0, 14).replace(/(\d{2})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1/$2').replace(/(\d{4})(\d{1,2})$/, '$1-$2'),
    cep: d => d.slice(0, 8).replace(/(\d{5})(\d)/, '$1-$2'),
    tel: d => {
      d = d.slice(0, 11);
      if (d.length <= 2) return d.length ? `(${d}` : '';
      const ddd = `(${d.slice(0, 2)}) `, n = d.slice(2);
      return ddd + (n.length > 8 ? `${n.slice(0, 5)}-${n.slice(5)}` : n.length > 4 ? `${n.slice(0, 4)}-${n.slice(4)}` : n);
    },
  };
  const applyMask = el => { if (el?.dataset?.mask && el.value) el.value = MASKS[el.dataset.mask](el.value.replace(/\D/g, '')); };

  // O endereço pelo CEP e os dados pelo CNPJ são preenchidos por /js/cadastro-auto.js
  document.addEventListener('input', e => {
    if (e.target.dataset?.mask) applyMask(e.target);
  });
  document.addEventListener('change', e => {
    if (e.target.matches('[data-same-address]')) e.target.form.querySelector('[data-address="emp_"]').hidden = e.target.checked;
  });

  function fillFields(form, data) {
    for (const el of form.elements) {
      if (!el.name || !(el.name in data) || el.type === 'checkbox' || el.type === 'file') continue;
      el.value = data[el.name] ?? '';
      applyMask(el);
    }
  }

  // ── Navegação entre telas ──────────────────────────────────────────────────
  const VIEWS = ['login', 'perfil', 'dados', 'aguardando', 'conta'];
  // ── Página inicial: planos, comparativo e números ─────────────────────────
  // Cada cartão leva para a página de confirmação e pagamento (/assinar).
  const ICONES = {
    consumidor: '<svg viewBox="0 0 24 24"><path d="M6 6h15l-1.5 9h-12z"/><path d="M6 6 5 3H2"/><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/></svg>',
    empresa: '<svg viewBox="0 0 24 24"><path d="M3 9h18l-1.5-5h-15z"/><path d="M5 9v11h14V9"/><path d="M9 20v-6h6v6"/></svg>',
    pro: '<svg viewBox="0 0 24 24"><path d="m3 11 18-8-8 18-2-8z"/></svg>',
  };
  // Comparativo montado a partir dos planos à venda: funções do tipo de acesso + funções do perfil de cada plano.
  // Cada linha: [recurso, plano => valor] (true/false vira ✓/—; texto aparece como está).
  function linhasComparativo(planos, base) {
    const tem = (p, f) => base.includes(f) || p.funcoes.includes(f);
    const funcoes = [...new Set([...base, ...planos.flatMap(p => p.funcoes)])].map(f => [f, p => tem(p, f)]);
    const pf = p => p.recursos.perfil;
    const perfil = [
      ['Conquistas na vitrine do perfil', p => String(pf(p).vitrine)],
      ['Imagem de capa no perfil', p => pf(p).capa],
      ['Links no perfil', p => (pf(p).links ? String(pf(p).links) : false)],
      ['Cores em degradê no perfil', p => pf(p).gradiente],
      ['Endereço personalizado do perfil', p => pf(p).slug_livre],
      ['Moldura exclusiva', p => pf(p).moldura],
    ].filter(([, v]) => new Set(planos.map(p => String(v(p)))).size > 1);
    const produtos = planos.some(p => p.tipo === 'empresa' && p.recursos.max_produtos)
      ? [['Produtos na loja', p => (p.tipo === 'empresa' ? (p.recursos.max_produtos ? numFmt(p.recursos.max_produtos) : true) : false)]] : [];
    return [...funcoes, ...produtos, ...perfil];
  }
  const brlFmt = v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const numFmt = n => Number(n).toLocaleString('pt-BR');

  let planosPromise = null;
  const dadosPlanos = () => (planosPromise ||= fetch('/api/planos').then(r => r.json()).catch(() => ({ planos: [] })));
  const PERIODO_CICLO = { mensal: '/mês', trimestral: '/trimestre', anual: '/ano' };
  const equivCiclo = c => (c.meses > 1 ? `equivale a ${brlFmt(c.por_mes)}/mês${c.economia ? `, ${c.economia}% a menos` : ''}` : '');
  const planosHtml = (planos, lojasGratis = 0) => planos.map(p => {
    const nativo = Boolean(window.OfertouApp?.nativo);
    const ciclos = nativo ? [] : p.ciclos || [];
    const mensal = p.gratis || !p.dias || p.dias === 30 ? '' : `<small class="plano-equiv">equivale a ${brlFmt(p.preco / p.dias * 30)}/mês</small>`;
    const periodo = !p.dias ? ' · sem vencimento' : p.dias === 30 ? '/mês' : `/${p.dias} dias`;
    const seletor = ciclos.length > 1 ? `<div class="plano-ciclos" role="group" aria-label="Período de ${esc(p.nome)}">${ciclos.map((c, i) => `<button type="button" aria-pressed="${i === 0}" data-ciclo="${c.id}" data-preco="${esc(brlFmt(c.preco))}" data-periodo="${PERIODO_CICLO[c.id]}" data-equiv="${esc(equivCiclo(c))}">${esc(c.nome)}</button>`).join('')}</div>` : '';
    const lojaGratis = !nativo && !p.gratis && p.tipos?.includes('empresa') && lojasGratis > 0;
    const gratisDias = !nativo && !p.gratis && p.teste_dias > 0;
    const cortesia = lojaGratis ? `<p class="plano-cortesia">1 mês grátis para as 20 primeiras lojas. Restam ${lojasGratis}.</p>`
      : gratisDias ? `<p class="plano-cortesia">${p.teste_dias} dias grátis para testar, sem cartão.</p>` : '';
      return `
      <article class="plano-card${p.destaque ? ' is-destaque' : ''}" data-plano="${esc(p.id)}">
        ${p.destaque ? `<span class="plano-selo">${esc(p.destaque)}</span>` : ''}
        <div class="plano-topo"><span class="plano-ico">${ICONES[p.icone] || ''}</span><p class="plano-chamada">${esc(p.chamada)}</p></div>
        <h3>${esc(p.nome)}</h3>
        ${seletor}
        <p class="plano-preco"><b>${p.gratis ? 'Grátis' : brlFmt(p.preco)}</b><span>${periodo}</span></p>
        ${seletor ? '<small class="plano-equiv" data-equiv-txt></small>' : mensal}
        ${cortesia}
        <p class="plano-ideal">${esc(p.ideal || '')}</p>
        <ul>${p.beneficios.map(b => `<li>${esc(b)}</li>`).join('')}</ul>
        <a class="btn ${p.destaque ? 'btn-primary' : ''} btn-block btn-lg" data-assinar href="/assinar?plano=${encodeURIComponent(p.id)}">${p.gratis ? 'Começar grátis' : lojaGratis || gratisDias ? `Começar ${esc(p.nome)} grátis` : `Assinar ${esc(p.nome)}`}</a>
      </article>`;
  }).join('');

  // Mensal, trimestral ou anual no cartão do plano: muda o preço e o que vai para a página de compra
  document.addEventListener('click', e => {
    const b = e.target.closest?.('.plano-ciclos [data-ciclo]');
    if (!b) return;
    const card = b.closest('.plano-card');
    card.querySelectorAll('[data-ciclo]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    card.querySelector('.plano-preco b').textContent = b.dataset.preco;
    card.querySelector('.plano-preco span').textContent = b.dataset.periodo;
    card.querySelector('[data-equiv-txt]').textContent = b.dataset.equiv;
    card.querySelector('[data-assinar]').href = `/assinar?plano=${encodeURIComponent(card.dataset.plano)}&ciclo=${encodeURIComponent(b.dataset.ciclo)}`;
  });

  let planosCarregados = false;
  async function loadPlanos() {
    if (planosCarregados) return;
    planosCarregados = true;
    loadApresentacao();
    const d = await dadosPlanos();
    const grid = $('#planos-grid');
    if (!d.planos?.length) {
      grid.innerHTML = '<p class="muted" style="text-align:center;grid-column:1/-1">Os planos estarão disponíveis em breve. Enquanto isso, crie sua conta grátis.</p>';
      return;
    }
    const vende = d.metodos?.algum;
    grid.innerHTML = planosHtml(d.planos, d.lojas_gratis);

    // Formas de pagamento aceitas
    if (vende) {
      $('#lp-pagamento').innerHTML = `<span>Pagamento seguro:</span>${d.metodos.lista.map(m => `<b>${esc(m.nome)}</b>`).join('')}`;
      $('#lp-pagamento').hidden = false;
    }

    // Comparativo só com os planos à venda
    const cols = d.planos;
    const celula = v => (v === true ? '<span class="lp-sim" aria-label="Incluído">✓</span>'
      : v ? `<b>${esc(v)}</b>` : '<span class="lp-nao" aria-label="Não incluído">—</span>');
    $('#lp-tabela').innerHTML = `
      <thead><tr><th>Recurso</th>${cols.map(p => `<th class="${p.destaque ? 'is-destaque' : ''}">${esc(p.nome)}<small>${p.gratis ? 'Grátis' : brlFmt(p.preco)}</small></th>`).join('')}</tr></thead>
      <tbody>${linhasComparativo(cols, d.funcoes_base || []).map(([nome, v]) => `<tr><td>${esc(nome)}</td>${cols.map(p => `<td class="${p.destaque ? 'is-destaque' : ''}">${celula(v(p))}</td>`).join('')}</tr>`).join('')}</tbody>`;
    $('#comparar').hidden = !cols.length;
  }

  async function loadApresentacao() {
    const a = await fetch('/api/apresentacao').then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (!a) return;
    if (a.ofertas > 0) $('#st-ofertas').textContent = a.ofertas >= 1000 ? `${numFmt(Math.floor(a.ofertas / 1000))} mil+` : numFmt(a.ofertas);
    if (a.lojas > 0) $('#st-lojas').textContent = numFmt(Math.max(a.lojas, 6));
    if (a.hoje > 0) $('#st-hoje').textContent = `+${numFmt(a.hoje)}`;
    if (a.ofertas > 0) $('#lp-ao-vivo').textContent = `${numFmt(a.ofertas)} ofertas ativas agora`;
    if (a.fotos?.length >= 2) {
      $('#lp-fotos').innerHTML = `<span class="lp-fotos-tit">Exemplos de agora</span>${a.fotos.slice(0, 6).map(f => `
        <span class="lp-foto"><img src="/img/recorte/${Number(f.id)}.webp?c=3" alt="" loading="lazy" decoding="async"><b>-${Number(f.desconto)}%</b></span>`).join('')}`;
      $('#lp-fotos').hidden = false;
    }
  }

  function show(view) {
    for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
    const inicio = view === 'login';
    document.body.classList.toggle('is-landing', inicio);
    $('#lp-nav').hidden = !inicio;
    $('#lp-footer').hidden = !inicio;
    $('#header-entrar').hidden = !inicio;
    if (inicio) { loadPlanos(); $('#lp-ano').textContent = new Date().getFullYear(); }
    $('#logout').hidden = view === 'login';
    // Com login obrigatório, "Ver ofertas" só aparece para contas liberadas.
    const liberado = ME?.status === 'active';
    $('#header-offers').hidden = INFO.exigir_login && !liberado;
    $('#aguardando-offers').hidden = INFO.exigir_login;
    document.title = inicio ? 'Ofertou! — ofertas reais das maiores lojas do Brasil' : 'Minha conta — Ofertou!';
    // Na página inicial, respeita o link para uma seção (#planos, #entrar…); nas outras telas, volta ao topo.
    const alvo = inicio && /^#[\w-]+$/.test(location.hash) && document.querySelector(location.hash === '#cadastro' ? '#entrar' : location.hash);
    if (alvo) setTimeout(() => alvo.scrollIntoView(), 350); else window.scrollTo(0, 0);
  }

  async function route() {
    const redefinir = new URLSearchParams(location.search).get('redefinir');
    if (redefinir) return showRedefinir(redefinir); // link de "Esqueci minha senha" (mesmo com alguém logado)
    const me = await api('/api/conta/me');
    ME = me.user; LOJA = me.loja;
    // Administrador logado vai para o painel (ou para a página que pediu).
    if (!ME && me.admin) return goToSite('/admin');
    if (!ME) return showLogin();
    if (ME.status === 'onboarding') return showProfileChoice();
    if (ME.assinatura_vencida) {
      $('#aguardando-text').innerHTML = `Sua assinatura venceu em ${esc(new Date(ME.assinatura_ate.replace(' ', 'T') + 'Z').toLocaleDateString('pt-BR'))}. `
        + `<a class="link-btn" href="/assinar?plano=${encodeURIComponent(ME.plano || ({ empresa: 'empresa', afiliado: 'pro' }[ME.tipo] || 'consumidor'))}&renovar=1">Renove o plano</a> para voltar a ver as ofertas.`;
      return show('aguardando');
    }
    if (ME.status === 'pending') {
      $('#aguardando-text').textContent = `Seu cadastro de ${NOME_PERFIL[ME.tipo] || 'consumidor'} foi enviado e está aguardando a aprovação da nossa equipe. Assim que for aprovado, ${ME.tipo === 'afiliado' ? 'o seu painel de afiliado será liberado' : 'as ferramentas da sua conta serão liberadas aqui'}. Não quer esperar? Assinando um plano, o acesso é liberado logo após a confirmação do pagamento.`;
      return show('aguardando');
    }
    // Usuário da ferramenta liberado usa o painel de afiliado.
    if (ME.tipo === 'afiliado' && ME.ferramenta) return location.replace('/cliente');
    renderAccount();
    // Lojista (ou afiliado) que ainda não aceitou os Termos do Parceiro atuais: janela de aceite por cima da conta
    OfertouAceiteParceiro.pedir(me.parceiro_pendente, '/api/conta/aceite-parceiro', '/api/conta/sair');
  }

  // ── Login e criação de conta ───────────────────────────────────────────────
  function showLogin() {
    show('login');
    const params = new URLSearchParams(location.search);
    if (params.get('erro')) {
      $('#auth-error').textContent = params.get('erro');
      $('#auth-error').hidden = false;
      history.replaceState(null, '', location.pathname + location.hash);
    }
    setAuthTab(location.hash === '#cadastro' ? 'criar' : 'entrar');
  }

  // O botão do Google fica sempre visível; se ainda não foi configurado no painel, avisa em vez de sair da página.
  $('#google-btn').addEventListener('click', e => {
    if (INFO.google) return;
    e.preventDefault();
    $('#auth-error').textContent = 'O login com Google ainda não foi ativado pelo administrador do site. Por enquanto, use e-mail e senha.';
    $('#auth-error').hidden = false;
  });

  // Depois de entrar, uma conta liberada vai direto para as ofertas (ou para a página que tentou abrir).
  function goToSite(padrao = '/') {
    const voltar = new URLSearchParams(location.search).get('voltar');
    // Só páginas do próprio site ("/\evil.com" o navegador lê como outro site)
    let destino = padrao;
    try {
      const u = new URL(voltar || '', location.origin);
      if (voltar && /^\/(?![/\\])/.test(voltar) && u.origin === location.origin) destino = u.pathname + u.search + u.hash;
    } catch { /* endereço inválido: vai para o padrão */ }
    location.href = destino;
  }

  function setAuthTab(tab) {
    $$('[data-auth]').forEach(b => b.setAttribute('aria-selected', b.dataset.auth === tab));
    $('#form-entrar').hidden = tab !== 'entrar';
    $('#form-criar').hidden = tab !== 'criar';
    $('#form-rapido').hidden = tab !== 'rapido';
    $('#form-esqueci').hidden = true;
    $('#form-redefinir').hidden = true;
    $('.tabs-line').hidden = false;
    $('#google-label').textContent = tab === 'criar' ? 'Criar conta com Google' : 'Entrar com Google';
    const closed = INFO.consumidor === 'fechado' && INFO.empresa === 'fechado';
    if (tab === 'criar' && closed) msg($('#form-criar'), 'Os cadastros estão fechados no momento.');
  }
  $$('[data-auth]').forEach(b => b.addEventListener('click', () => setAuthTab(b.dataset.auth)));
  $$('[data-ir-criar]').forEach(a => a.addEventListener('click', () => setAuthTab('criar')));

  // ── Esqueci minha senha ──
  // Mostra um formulário só (sem as abas e o Google) no lugar do login
  function soFormulario(id) {
    for (const f of ['#form-entrar', '#form-criar', '#form-rapido', '#form-esqueci', '#form-redefinir']) $(f).hidden = f !== id;
    $('.tabs-line').hidden = true;
    for (const el of ['#google-btn', '#google-divider']) $(el).classList.add('esconder-google');
  }
  function voltarEntrar() {
    for (const el of ['#google-btn', '#google-divider']) $(el).classList.remove('esconder-google');
    setAuthTab('entrar');
  }
  $('#esqueci-btn').addEventListener('click', () => {
    soFormulario('#form-esqueci');
    const digitado = $('#form-entrar [name=email]').value.trim();
    if (digitado) $('#form-esqueci [name=email]').value = digitado;
    $('#form-esqueci [name=email]').focus();
  });
  $$('[data-voltar-entrar]').forEach(b => b.addEventListener('click', voltarEntrar));
  bind('#form-esqueci', async (form, d) => {
    const r = await api('/api/conta/esqueci-senha', { method: 'POST', body: d });
    msg(form, r.mensagem, true);
  });
  // Link do e-mail: /conta?redefinir=<código>
  async function showRedefinir(token) {
    show('login');
    soFormulario('#form-redefinir');
    const form = $('#form-redefinir');
    try {
      const r = await api(`/api/conta/redefinir-senha?token=${encodeURIComponent(token)}`);
      $('#redefinir-conta').textContent = r.email ? `Conta: ${r.email}` : '';
    } catch (err) {
      form.querySelectorAll('input, [type=submit]').forEach(el => { el.disabled = true; });
      msg(form, err.message);
    }
  }
  bind('#form-redefinir', async (form, d) => {
    if (!form.reportValidity()) return;
    if (d.nova !== d.nova_confirmacao) throw new Error('As senhas não conferem.');
    const token = new URLSearchParams(location.search).get('redefinir');
    await api('/api/conta/redefinir-senha', { method: 'POST', body: { token, nova: d.nova } });
    history.replaceState(null, '', location.pathname);
    form.reset();
    voltarEntrar();
    msg($('#form-entrar'), 'Senha nova salva! Agora é só entrar com ela.', true);
  });

  bind('#form-entrar', async (form, d) => {
    const r = await api('/api/conta/entrar', { method: 'POST', body: d });
    if (r.admin) return goToSite('/admin');
    location.hash = '';
    const me = await api('/api/conta/me');
    if (me.user?.status === 'active') return goToSite(me.user.tipo === 'afiliado' && me.user.ferramenta ? '/cliente' : '/');
    route();
  });

  // Cadastro rápido: nome, celular e senha (o resto em Meus dados)
  bind('#form-rapido', async (form, d) => {
    if (!form.reportValidity()) return;
    const r = await api('/api/conta/cadastro-rapido', { method: 'POST', body: d });
    toast(r.status === 'active' ? 'Conta criada! Bem-vindo(a) ao Ofertou!' : 'Conta criada! Ela será liberada após a aprovação.');
    if (r.status === 'active') return setTimeout(() => goToSite(), 600);
    route();
  });

  bind('#form-criar', async (form, d) => {
    if (d.senha !== d.senha_confirmacao) throw new Error('As senhas não conferem.');
    await api('/api/conta/cadastro', { method: 'POST', body: d });
    location.hash = '';
    route();
  });

  // ── Primeiro acesso: perfil e dados ────────────────────────────────────────
  let chosenTipo = null;

  const NOME_PERFIL = { consumidor: 'consumidor', empresa: 'empresa', afiliado: 'usuário da ferramenta' };
  function showProfileChoice() {
    show('perfil');
    for (const tipo of ['consumidor', 'empresa', 'afiliado']) {
      const mode = INFO[tipo] || 'aprovacao';
      const card = $(`.profile-card[data-tipo="${tipo}"]`);
      card.disabled = mode === 'fechado';
      $(`[data-note="${tipo}"]`).textContent = mode === 'fechado' ? 'Cadastros gratuitos fechados no momento — assine um plano acima.'
        : mode === 'aprovacao' ? '⏳ Gratuito · passa por aprovação' : 'Gratuito · acesso liberado na hora';
    }
    dadosPlanos().then(d => {
      $('#perfil-planos').innerHTML = d.planos?.length ? planosHtml(d.planos, d.lojas_gratis) : '';
      $('#perfil-pago').hidden = !d.planos?.length;
    });
  }

  $$('.profile-card').forEach(card => card.addEventListener('click', () => {
    if (card.disabled) return;
    chosenTipo = card.dataset.tipo;
    const empresa = chosenTipo === 'empresa';
    $('#dados-title').textContent = empresa ? 'Dados do responsável e da empresa' : 'Seus dados';
    $('#dados-sub').textContent = `Perfil escolhido: ${{ empresa: 'Empresarial', consumidor: 'Consumidor', afiliado: 'Usuário da ferramenta (Afiliado)' }[chosenTipo]} — gratuito${INFO[chosenTipo] === 'aberto' ? '' : ', passa por aprovação'}.`;
    $('#form-dados [data-fields="empresa"]').hidden = !empresa;
    // Termos do Parceiro: lojista (empresa) e afiliado aceitam numa caixa a mais
    $$('#form-dados [data-aceite-papel]').forEach(l => {
      const vale = ({ lojista: empresa, afiliado: chosenTipo === 'afiliado' })[l.dataset.aceitePapel];
      l.hidden = !vale; l.querySelector('input').disabled = !vale;
    });
    const form = $('#form-dados');
    if (ME?.nome && !form.nome.value) form.nome.value = ME.nome;
    show('dados');
  }));
  $('#trocar-perfil').addEventListener('click', showProfileChoice);

  bind('#form-dados', async (form, d) => {
    const r = await api('/api/conta/perfil-inicial', { method: 'POST', body: { ...d, tipo: chosenTipo } });
    toast(r.status === 'active' ? 'Cadastro concluído!' : 'Cadastro enviado para aprovação.');
    if (r.status === 'active') return setTimeout(() => goToSite(), 600);
    route();
  });

  // ── Área do usuário ────────────────────────────────────────────────────────
  const TABS_CONSUMIDOR = [['meuperfil', 'Meu perfil'], ['mensagens', 'Mensagens'], ['pedidos', 'Meus pedidos'], ['planos', 'Meus planos'], ['cartoes', 'Meus cartões'], ['perfil', 'Meus dados'], ['seguranca', 'Senha e conta']];
  const TABS_EMPRESA = [['painel', 'Painel da loja'], ['meuperfil', 'Meu perfil'], ['mensagens', 'Mensagens'], ['anuncios', 'Anúncios'], ['loja', 'Minha loja'], ['vendas', 'Vendas e pagamentos'], ['importar', 'Importação automática'],
    ['pedidos', 'Meus pedidos'], ['planos', 'Meus planos'], ['cartoes', 'Meus cartões'], ['perfil', 'Meus dados'], ['seguranca', 'Senha e conta']];
  // Menu lateral no mesmo padrão do painel do afiliado: grupos com título e ícone em cada item
  const ICONES_NAV = {"equipe":"<circle cx=\"9\" cy=\"8\" r=\"3.5\"/><path d=\"M2.5 20a6.5 6.5 0 0 1 13 0\"/><path d=\"M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6\"/>","painel":"<rect x=\"3\" y=\"3\" width=\"7\" height=\"9\" rx=\"2\"/><rect x=\"14\" y=\"3\" width=\"7\" height=\"5\" rx=\"2\"/><rect x=\"14\" y=\"12\" width=\"7\" height=\"9\" rx=\"2\"/><rect x=\"3\" y=\"16\" width=\"7\" height=\"5\" rx=\"2\"/>","anuncios":"<path d=\"M20 12l-8 8-9-9V3h8z\"/><circle cx=\"7.5\" cy=\"7.5\" r=\"1.5\"/>","loja":"<path d=\"M4 9l1.5-5h13L20 9\"/><path d=\"M4 9v11h16V9\"/><path d=\"M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0\"/><path d=\"M10 20v-6h4v6\"/>","vendas":"<path d=\"M4 19h16\"/><path d=\"M7 15l4-4 3 3 5-6\"/>","importar":"<path d=\"M12 3v12\"/><path d=\"M7 10l5 5 5-5\"/><path d=\"M4 20h16\"/>","mensagens":"<path d=\"M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4 4v-4H5.5A1.5 1.5 0 0 1 4 14.5z\"/>","meuperfil":"<path d=\"M12 2l3 6 6.5 1-4.7 4.6 1.1 6.4L12 17l-5.9 3 1.1-6.4L2.5 9 9 8z\"/>","pedidos":"<path d=\"M3 8l9-5 9 5v8l-9 5-9-5z\"/><path d=\"M3 8l9 5 9-5\"/><path d=\"M12 13v8\"/>","cartoes":"<rect x=\"3\" y=\"5\" width=\"18\" height=\"14\" rx=\"2.5\"/><path d=\"M3 10h18\"/>","perfil":"<circle cx=\"12\" cy=\"8\" r=\"4\"/><path d=\"M4 21a8 8 0 0 1 16 0\"/>","seguranca":"<rect x=\"5\" y=\"11\" width=\"14\" height=\"10\" rx=\"2\"/><path d=\"M8 11V7a4 4 0 0 1 8 0v4\"/>"};
  const GRUPOS_NAV = [['Equipe', ['equipe']], ['Essencial', ['painel', 'anuncios', 'loja', 'vendas', 'importar']], ['Atendimento', ['mensagens']], ['Minha conta', ['meuperfil', 'pedidos', 'planos', 'cartoes', 'perfil', 'seguranca']]];
  ICONES_NAV.planos = '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h13A2.5 2.5 0 0 1 21 8.5v7a2.5 2.5 0 0 1-2.500 2.500h-13A2.500 2.500 0 0 1 3 15.500z"/><path d="m8.500 12 2.300 2.300 4.700-4.600"/>';
  function menuDaConta(tabs) {
    const rotulo = new Map(tabs);
    return GRUPOS_NAV.map(([titulo, chaves]) => {
      const itens = chaves.filter(k => rotulo.has(k));
      if (!itens.length) return '';
      return `<p class="cli-nav-tit">${titulo}</p>${itens.map(k => `<button type="button" data-tab="${k}" aria-current="${k === currentTab}"><svg class="cli-ico" viewBox="0 0 24 24" aria-hidden="true">${ICONES_NAV[k] || ''}</svg><span>${rotulo.get(k)}</span>${k === 'mensagens' ? '<b class="nav-n" id="nav-msg-n" hidden></b>' : ''}</button>`).join('')}`;
    }).join('');
  }
  let currentTab = null; // empresa abre no Painel da loja; consumidor, em Meu perfil

  function renderAccount() {
    show('conta');
    const empresa = ME.tipo === 'empresa';
    $('#who-name').textContent = empresa ? (ME.empresa_nome || ME.nome) : ME.nome;
    $('#who-type').textContent = empresa ? `Conta empresarial · ${ME.nome}` : ME.staff ? `Equipe Ofertou!${ME.cargo ? ` · ${({ proprietario: 'Proprietário', gerente: 'Gerente', admin: 'Admin', moderador: 'Moderador', suporte: 'Suporte' })[ME.cargo] || ''}` : ''}` : 'Conta de consumidor';
    $('#who-avatar').hidden = !ME.avatar_url;
    $('#who-letra').hidden = Boolean(ME.avatar_url);
    $('#who-letra').textContent = String((empresa ? ME.empresa_nome : ME.nome) || ME.nome || '?').trim().charAt(0).toUpperCase();
    if (ME.avatar_url) $('#who-avatar').src = ME.avatar_url;
    // Empresa ainda sem loja: o "Painel da loja" fica escondido e a conta abre em "Minha loja" para criar a loja
    const equipe = ME.staff || ME.pode_sac || ME.pode_postar || ME.pode_moderar;
    const tabs = [...(equipe ? [['equipe', 'Área da equipe']] : []), ...(empresa ? TABS_EMPRESA.filter(([k]) => k !== 'painel' || LOJA) : TABS_CONSUMIDOR)];
    if (equipe) {
      $('#eq-sac').hidden = !ME.pode_sac;
      $('#eq-moderar').hidden = !ME.pode_moderar;
      $('#eq-equipe').hidden = !ME.pode_equipe;
      $('#eq-postar').hidden = !ME.pode_postar;
    }
    if (empresa && !LOJA && currentTab === null) currentTab = 'loja';
    if (equipe && currentTab === null) currentTab = 'equipe';
    if (!tabs.some(([k]) => k === currentTab)) currentTab = empresa ? (LOJA ? 'painel' : 'loja') : 'meuperfil';
    $('#loja-boas-vindas').hidden = !(empresa && !LOJA);
    $('#account-nav').innerHTML = menuDaConta(tabs);
    fetch('/api/chat/resumo', { cache: 'no-store' }).then(r => r.json()).then(r => {
      const n = (r.nao_lidas || 0) + (r.pedidos || 0);
      const el = $('#nav-msg-n');
      if (el) { el.hidden = !n; el.textContent = n > 99 ? '99+' : n; }
    }).catch(() => {});
    $$('#view-conta [data-empresa]').forEach(el => { el.hidden = !empresa; });

    $('#hello-name').textContent = (ME.nome || '').split(' ')[0];
    $('#hello-text').textContent = empresa
      ? (ME.bloqueio_publicacao
        ? 'Sua conta está impedida de publicar anúncios pelo administrador. Você ainda pode ver as ofertas.'
        : LOJA ? 'Crie anúncios dos seus produtos em promoção, edite sua loja ou configure a importação automática.'
          : 'Comece criando sua loja na aba "Minha loja". Depois é só anunciar seus produtos em promoção.')
      : 'Sua conta de consumidor dá acesso a todas as ofertas com desconto do site.';
    $('#hello-store').hidden = !LOJA;
    if (LOJA) $('#hello-store').href = `/loja/${LOJA.slug}`;
    $('#hello-new-ad').hidden = !empresa || !LOJA || ME.bloqueio_publicacao;

    fillFields($('#form-perfil'), ME);
    window.OfertouCadastro?.aplicarTipo($('#form-perfil'));
    // Cadastro rápido: o e-mail (provisório) e o CPF ainda faltam e podem ser preenchidos aqui
    const fp = $('#form-perfil');
    fp.email.value = ME.email_provisorio ? '' : ME.email;
    fp.email.disabled = !ME.email_provisorio;
    fp.email.placeholder = ME.email_provisorio ? 'voce@email.com' : '';
    if (fp.cpf) { fp.cpf.disabled = Boolean(ME.cpf); if (!ME.cpf) fp.cpf.placeholder = '000.000.000-00'; }
    $('#completar-aviso').hidden = !ME.cadastro_simplificado;
    $('#perfil-aviso-fixos').textContent = ME.cadastro_simplificado
      ? 'Depois de salvos, o e-mail e o CPF só podem ser trocados pelo administrador.'
      : 'E-mail, CPF e CNPJ não podem ser alterados por aqui. Se precisar, fale com o administrador.';

    // Conta só com Google: pode definir senha sem a atual; exclusão confirma digitando EXCLUIR.
    $('#senha-title').textContent = ME.tem_senha ? 'Trocar senha' : 'Definir senha';
    $('#senha-note').hidden = ME.tem_senha;
    $('#senha-atual-field').hidden = !ME.tem_senha;
    $('#excluir-senha').hidden = !ME.tem_senha;
    $('#excluir-confirma').hidden = ME.tem_senha;

    if (empresa) fillStore();
    const qs = new URLSearchParams(location.search);
    if (qs.get('aba') && tabs.some(([k]) => k === qs.get('aba'))) {
      currentTab = qs.get('aba');
      if (qs.get('mp') === 'ok') toast('Mercado Pago conectado! Agora seus clientes podem pagar os pedidos pelo site.');
      if (qs.get('mp_erro')) toast(qs.get('mp_erro'));
      if (currentTab !== 'mensagens') history.replaceState(null, '', '/conta'); // (mensagens: mantém a conversa pedida no endereço)
    }
    openTab(currentTab);
  }

  function openTab(tab) {
    currentTab = tab;
    $$('.tab-pane').forEach(p => { p.hidden = p.dataset.pane !== tab; });
    $$('#account-nav button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === tab));
    // No celular o menu é uma faixa que rola para o lado: deixa a aba escolhida à vista
    $('#account-nav button[aria-current="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
    if (tab === 'anuncios') { closeEditor(); loadProducts(); }
    // Na aba Mensagens o botão flutuante some (a conversa já está na tela)
    document.body.classList.toggle('aba-mensagens', tab === 'mensagens');
    if (tab !== 'mensagens' && location.search.includes('aba=mensagens')) history.replaceState(null, '', '/conta');
    if (tab === 'mensagens') embutirMensagens().catch(() => { $('#msg-embed').innerHTML = '<p class="muted">Não foi possível carregar as mensagens.</p>'; });
    if (tab === 'meuperfil') embutirPerfil().catch(() => { $('#pf-embed').innerHTML = '<p class="muted">Não foi possível carregar o perfil.</p>'; });
    if (tab === 'vendas') loadVendas().catch(err => toast(err.message));
    if (tab === 'painel' && window.OfertouPainelLoja) {
      window.OfertouPainelLoja.carregar($('#painel-loja'), aba => {
        if (aba === 'novo-anuncio') { openTab('anuncios'); if (!ME.bloqueio_publicacao && LOJA) openEditor(); } else openTab(aba);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }).catch(err => toast(err.message));
    }
    if (tab === 'loja' && LOJA) loadEditorLoja().catch(err => toast(err.message));
    if (tab === 'pedidos') loadMeusPedidos().catch(err => toast(err.message));
    if (tab === 'seguranca') loadArrependimento();
    if (tab === 'planos') window.OfertouMeusPlanos?.mostrar($('#meus-planos')).catch(err => toast(err.message));
    if (tab === 'cartoes') window.OfertouCartoes?.gerenciar($('#meus-cartoes'));
    else window.OfertouCartoes?.desmontar();
  }
  $('#account-nav').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) openTab(b.dataset.tab); });
  $('#view-conta').addEventListener('click', e => {
    const b = e.target.closest('.tab-pane [data-tab]');
    if (b) openTab(b.dataset.tab);
    const c = e.target.closest('[data-abrir-chat]'); // conversa do pedido: no painel de mensagens
    if (c) { if (window.OfertouChat) window.OfertouChat.abrir(c.dataset.abrirChat, c.dataset.pedido); else location.href = `/mensagens?c=${c.dataset.abrirChat}&pedido=${c.dataset.pedido}`; }
  });
  $('#hello-new-ad').addEventListener('click', () => { openTab('anuncios'); openEditor(); });

  // ── Vendas e pagamentos da loja / Meus pedidos ───────────────────────────
  const ROTULO_ACAO = {
    confirmar_pagamento: 'Confirmar pagamento', enviado: 'Marcar como enviado',
    concluido: 'Concluir', recebido: 'Recebi o pedido', cancelar: 'Cancelar',
  };
  const linhaPedido = p => `<div class="vendas-pedido">
      <div><b>${esc(p.codigo)} · ${esc(p.produto)}</b>
        <span class="muted">${p.quantidade}x · ${brlFmt(p.total)} · ${esc(p.metodo_nome)} · ${fmtDate(p.created_at)}</span>
        <span class="muted">${p.eu === 'loja' ? `Cliente: ${esc(p.comprador.nome)}` : `Loja: ${esc(p.loja.nome)}`}${p.observacao ? ` · Obs.: ${esc(p.observacao)}` : ''}</span></div>
      <span class="status-pill st-${esc(p.status)}">${esc(p.status_nome)}</span>
      ${p.pagamento && p.pagamento.pix ? `<details class="pedido-pix"><summary class="btn btn-sm btn-primary">Pagar com Pix</summary>
        ${p.pagamento.qr ? `<img class="prod-pix-qr" src="data:image/png;base64,${esc(p.pagamento.qr)}" alt="QR code do Pix">` : ''}
        <input readonly value="${esc(p.pagamento.pix)}" aria-label="Pix copia e cola" onclick="this.select()">
        <small class="muted">Leia o QR code ou copie o código no app do banco. A confirmação é automática.</small></details>` : ''}
      <div class="row-actions">
        ${p.acoes.map(a => `<button class="btn btn-sm${a === 'cancelar' ? ' danger-txt' : a === 'confirmar_pagamento' || a === 'recebido' ? ' btn-primary' : ''}" type="button" data-pacao="${a}" data-pid="${p.id}">${ROTULO_ACAO[a]}</button>`).join('')}
        ${p.conversa_id ? `<button class="btn btn-sm" type="button" data-abrir-chat="${p.conversa_id}" data-pedido="${p.id}">Conversa</button>` : ''}
      </div></div>`;

  async function loadVendas() {
    const d = await api('/api/conta/loja/vendas');
    if (!d.loja) {
      $('#vendas-numeros').innerHTML = '<p class="muted">Crie sua loja na aba "Minha loja" para receber pedidos.</p>';
      $('#vendas-pedidos').innerHTML = '';
      return;
    }
    const m = d.metricas, a = m.acessos;
    const num = (v, rot, sub) => `<div class="vendas-numero"><b>${v}</b><span>${rot}${sub ? `<br>${sub}` : ''}</span></div>`;
    $('#vendas-numeros').innerHTML = [
      num(m.finalizacoes.total, 'Compras finalizadas pelo site', `${m.finalizacoes.d30} nos últimos 30 dias`),
      num(brlFmt(m.finalizacoes.valor), 'Valor vendido pelo site', `${brlFmt(m.finalizacoes.valor_d30)} em 30 dias`),
      num(m.pedidos.total, 'Pedidos recebidos', `${(m.pedidos.por_status.aguardando_pagamento || 0) + (m.pedidos.por_status.pagamento_informado || 0)} aguardando pagamento`),
      num(a.pagina.total, 'Acessos à página da loja', `${a.pagina.d30} em 30 dias · ${a.pagina.d7} em 7`),
      num(a.produto.total, 'Produtos abertos no catálogo', `${a.produto.d30} em 30 dias`),
      num(a.site.total, 'Cliques no seu site oficial', `${a.site.d30} em 30 dias`),
      num(a.link.total, 'Cliques para comprar no seu site', `${a.link.d30} em 30 dias`),
      num(m.conversas, 'Conversas de atendimento'),
    ].join('');
    renderMpLoja(d.pagamento.mp);
    $('#vendas-top').innerHTML = m.mais_vistos.length ? `<h3 style="margin:16px 0 6px;font-size:15px">Mais vistos no catálogo (30 dias)</h3>
      <ol class="muted" style="margin:0;padding-left:20px">${m.mais_vistos.map(t => `<li>${esc(t.produto)} — <b>${t.n}</b></li>`).join('')}</ol>` : '';
    $('#vendas-pedidos').innerHTML = d.pedidos.length ? d.pedidos.map(linhaPedido).join('') : '<p class="muted">Nenhum pedido ainda.</p>';
    const f = $('#form-pagloja'), pg = d.pagamento;
    for (const k of ['aceita_pedidos', 'aceita_pix', 'aceita_cartao']) f[k].checked = pg[k];
    f.pedido_instrucoes.value = pg.pedido_instrucoes || '';
    $('#pag-parcelas').textContent = `Pelo Mercado Pago${pg.parcelas > 1 ? `, em até ${pg.parcelas}x` : ''}`;
    if (!pg.gateway_ok) $('#pag-explica').innerHTML = '<b>Os pagamentos pelo site ainda não foram ativados pelo administrador.</b> Enquanto isso, o botão "Fazer pedido" não aparece nos seus produtos.';
    else if (!pg.mp.conectado) $('#pag-explica').innerHTML = '<b>Conecte o Mercado Pago da loja (acima)</b> para o botão "Fazer pedido" aparecer nos seus produtos.';
  }
  bind('#form-pagloja', async (form, d) => {
    await api('/api/conta/loja/pagamento', { method: 'PUT', body: d });
    msg(form, 'Salvo!', true);
    loadVendas();
  });

  // Mercado Pago da loja (marketplace): conectar (vai ao Mercado Pago e volta), situação e desconectar
  function renderMpLoja(m) {
    const el = $('#mp-loja-situacao');
    if (!m) { el.innerHTML = ''; return; }
    if (m.conectado) {
      el.innerHTML = `<p class="mp-ok"><b>✓ Mercado Pago conectado</b>${m.conta_id ? ` · conta ${esc(m.conta_id)}` : ''}${m.conectado_em ? ` · desde ${fmtDate(m.conectado_em)}` : ''}${m.teste ? ' · <b>conta de teste</b>' : ''}</p>
        ${m.erro ? `<p class="form-msg err">A renovação da conexão falhou (${esc(m.erro)}). Conecte de novo para não parar de receber pedidos.</p>` : ''}
        <div class="row-actions">${m.erro ? '<button class="btn btn-primary" type="button" data-mp-conectar>Conectar de novo</button>' : ''}<button class="btn" type="button" data-mp-desconectar>Desconectar</button></div>`;
    } else if (!m.disponivel) {
      el.innerHTML = '<p class="muted"><b>O recebimento pelo Mercado Pago ainda não foi ativado pelo administrador do site.</b> Assim que for, você poderá conectar a sua conta aqui.</p>';
    } else {
      el.innerHTML = `<p class="muted">Você vai entrar na sua conta do Mercado Pago (ou criar uma, grátis) e autorizar o Ofertou! a <b>criar cobranças em nome da sua loja</b>. A autorização é usada só para cobrar os pedidos feitos pelo site, conferir se foram pagos e devolver o valor quando um pedido pago é cancelado. O Ofertou! não faz saques nem transferências na sua conta.</p>
        <div class="row-actions"><button class="btn btn-primary" type="button" data-mp-conectar>Conectar minha conta do Mercado Pago</button></div>`;
    }
  }
  $('[data-pane="vendas"]').addEventListener('click', async e => {
    const con = e.target.closest('[data-mp-conectar]'), des = e.target.closest('[data-mp-desconectar]');
    if (!con && !des) return;
    try {
      if (con) {
        con.disabled = true;
        const r = await api('/api/conta/loja/mp/conectar', { method: 'POST', body: {} });
        window.top.location.href = r.url;
        return;
      }
      if (!await OfertouUI.confirmar('Desconectar o Mercado Pago? O botão "Fazer pedido" some dos seus produtos até você conectar de novo.')) return;
      await api('/api/conta/loja/mp/desconectar', { method: 'POST', body: {} });
      toast('Mercado Pago desconectado.');
      loadVendas();
    } catch (err) { toast(err.message); if (con) con.disabled = false; }
  });


  async function loadMeusPedidos() {
    const lista = await api('/api/pedidos');
    $('#meus-pedidos').innerHTML = lista.length ? lista.map(linhaPedido).join('')
      : '<p class="muted">Você ainda não fez pedidos. Abra a página de uma loja parceira e toque em um produto.</p>';
  }

  $('#view-conta').addEventListener('click', async e => {
    const b = e.target.closest('[data-pacao]');
    if (!b) return;
    const acao = b.dataset.pacao;
    let motivo = '';
    if (acao === 'cancelar') { motivo = await OfertouUI.perguntar('Motivo do cancelamento (opcional):'); if (motivo === null) return; }
    else if (acao === 'confirmar_pagamento' && !await OfertouUI.confirmar('Confirma que o valor do pedido já caiu na sua conta?')) return;
    b.disabled = true;
    try {
      await api(`/api/pedidos/${b.dataset.pid}/acao`, { method: 'POST', body: { acao, motivo } });
      toast('Pedido atualizado.');
      if (currentTab === 'vendas') loadVendas(); else loadMeusPedidos();
    } catch (err) { toast(err.message); b.disabled = false; }
  });

  // Perfil dentro da conta: usa a mesma página do perfil (perfil.js), sem sair daqui
  let perfilEmbutido = false;
  async function embutirPerfil() {
    if (perfilEmbutido) return;
    perfilEmbutido = true;
    const html = await fetch('/perfil/minha-conta', { cache: 'no-store' }).then(r => r.text());
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const pagina = doc.querySelector('main.pf-page');
    const editor = doc.querySelector('#pf-editor');
    if (!pagina || !editor) throw new Error('perfil');
    $('#pf-embed').replaceChildren(document.importNode(pagina, true));
    document.body.appendChild(document.importNode(editor, true));
    window.OFERTOU_PERFIL_EMBED = true;
    const sc = document.createElement('script');
    sc.src = doc.querySelector('script[src*="/js/perfil.js"]')?.getAttribute('src') || '/js/perfil.js';
    document.body.appendChild(sc);
  }

  // Mensagens dentro da conta: usa a mesma tela de mensagens (mensagens.js), sem sair daqui
  let mensagensEmbutidas = false;
  async function embutirMensagens() {
    if (mensagensEmbutidas) return;
    mensagensEmbutidas = true;
    const html = await fetch('/mensagens/tela', { cache: 'no-store' }).then(r => r.text());
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const pagina = doc.querySelector('main.msg-page');
    if (!pagina) throw new Error('mensagens');
    pagina.classList.remove('container');
    $('#msg-embed').replaceChildren(document.importNode(pagina, true));
    window.OFERTOU_MSG_EMBED = true;
    const sc = document.createElement('script');
    sc.src = doc.querySelector('script[src*="/js/mensagens.js"]')?.getAttribute('src') || '/js/mensagens.js';
    document.body.appendChild(sc);
  }

  function fillStore() {
    const f = $('#form-loja');
    $('#le-excluir-card').hidden = !LOJA; // só dá para excluir uma loja que já existe
    f.nome.value = LOJA?.nome || ME.empresa_nome || '';
    f.descricao.value = LOJA?.descricao || '';
    f.logo_url.value = LOJA?.logo_url || '';
    f.site_url.value = LOJA?.site_url || ME.site_empresa || '';
    $('#store-link').hidden = !LOJA;
    if (LOJA) $('#store-link').href = `/loja/${LOJA.slug}`;
    $('#form-feed').feed_url.value = LOJA?.feed_url || '';
    const st = LOJA?.feed_status;
    $('#feed-status').innerHTML = !LOJA?.feed_url ? 'Nenhum link configurado.'
      : `<span class="status-pill ${st === 'ok' ? 'ok' : st === 'erro' ? 'err' : ''}">${st === 'ok' ? 'Funcionando' : st === 'erro' ? 'Com erro' : 'Aguardando sincronização'}</span>
         ${LOJA.feed_tipo ? ` · formato: ${esc(LOJA.feed_tipo)}` : ''} · última sincronização: ${fmtDate(LOJA.feed_ultima_sync)}
         ${LOJA.feed_mensagem ? `<br>${esc(LOJA.feed_mensagem)}` : ''}`;
  }

  // Direito de arrependimento: cancelar o plano em até 7 dias da compra (CDC, art. 49)
  let ARREP = null;
  async function loadArrependimento() {
    try { ARREP = await api('/api/conta/arrependimento'); } catch { ARREP = null; }
    $('#arrep-card').hidden = !ARREP?.pode;
    if (!ARREP?.pode) return;
    const ate = new Date(ARREP.ate.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const valor = Number(ARREP.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    $('#arrep-texto').innerHTML = `Você comprou o plano <b>${esc(ARREP.plano)}</b> (${valor}) há menos de ${ARREP.prazo_dias} dias. Pelo Código de Defesa do Consumidor, você pode desistir até <b>${ate}</b> e receber o valor de volta.
      ${ARREP.automatico ? 'Como o pagamento foi pelo Mercado Pago, a devolução é feita na hora, no mesmo meio de pagamento.' : 'A devolução é feita pela nossa equipe, no mesmo meio de pagamento, e você recebe um aviso.'}
      Os dias do plano comprado são retirados da sua conta.`;
  }
  $('#arrep-btn')?.addEventListener('click', async () => {
    if (!ARREP?.pode) return;
    if (!await OfertouUI.confirmar(`Cancelar o plano ${ARREP.plano} e pedir o reembolso? Os dias desse plano serão retirados da sua conta.`)) return;
    const motivo = await OfertouUI.perguntar('Quer contar o motivo? (opcional)', '');
    if (motivo === null) return;
    try {
      const r = await api('/api/conta/arrependimento', { method: 'POST', body: { motivo } });
      await OfertouUI.avisar(r.status === 'reembolsado' ? 'Plano cancelado e valor devolvido pelo Mercado Pago. O estorno aparece no seu extrato em alguns dias.' : 'Plano cancelado. Seu reembolso foi pedido e a nossa equipe vai devolver o valor no mesmo meio de pagamento.');
      location.reload();
    } catch (err) { OfertouUI.avisar(err.message); }
  });

  // Excluir a própria loja (confirma digitando EXCLUIR)
  $('#le-excluir')?.addEventListener('click', async () => {
    if (!LOJA) return;
    if (!await OfertouUI.confirmar(`Excluir a loja "${LOJA.nome}"? A página, os produtos, os catálogos e as avaliações serão apagados. Não dá para desfazer.`)) return;
    const conf = await OfertouUI.perguntar('Para confirmar, digite EXCLUIR:', '');
    if (conf === null) return;
    try {
      await api('/api/conta/loja', { method: 'DELETE', body: { confirmacao: conf } });
      toast('Loja excluída.');
      setTimeout(() => location.reload(), 800);
    } catch (err) { OfertouUI.avisar(err.message); }
  });

  bind('#form-loja', async (form, d) => {
    const primeira = !LOJA;
    const r = await api('/api/conta/loja', { method: 'PUT', body: d });
    LOJA = r.loja;
    await api('/api/conta/loja/aparencia', { method: 'PUT', body: { ...d, mostrar_avaliacoes: form.mostrar_avaliacoes.checked } });
    if (primeira) {
      // Loja criada: o "Painel da loja" aparece no menu e abre
      currentTab = 'painel';
      renderAccount();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      toast('Loja criada! Seu Painel da loja foi liberado.');
      return;
    }
    renderAccount();
    openTab('loja');
    msg($('#form-loja'), 'Loja salva! Veja como ficou em "Ver minha loja".', true);
  });
  // ── Editor da loja: aparência, catálogos e avaliações ─────────────────────
  const CORES_LOJA = { verde: ['#0c8f4f', '#2bd37f'], azul: ['#1d5fd6', '#5b9bff'], roxo: ['#6b3fd4', '#a27bff'], laranja: ['#d9661a', '#ffa24d'],
    vermelho: ['#c62f2f', '#ff6464'], grafite: ['#3b4047', '#7d858f'], rosa: ['#cf3a85', '#ff7bbd'], dourado: ['#a77a0c', '#f2c94c'],
    ciano: ['#0b8f9c', '#41d9e6'], vinho: ['#6e1c38', '#b8456c'] };
  let ED = null; // dados do editor
  const okImgLoja = s => /^(https:\/\/|\/uploads\/[a-f0-9]{32}\.(jpg|png|webp)$|\/uploads\/perfis\/[\w.-]+\.webp$)/i.test(s || '');
  function previewImg(campo) {
    const f = $('#form-loja'), v = f[campo].value;
    const el = $(campo === 'logo_url' ? '#le-logo-prev' : '#le-capa-prev');
    el.style.backgroundImage = okImgLoja(v) ? `url("${v}")` : '';
    el.textContent = okImgLoja(v) ? '' : campo === 'logo_url' ? 'Sem logo' : 'Sem banner: usa a cor da loja';
  }
  function marcarCor(cor) {
    $('#form-loja').cor.value = cor;
    $$('#le-cores [data-cor]').forEach(b => b.setAttribute('aria-pressed', b.dataset.cor === cor));
  }
  async function loadEditorLoja() {
    ED = await api('/api/conta/loja/editor');
    if (!ED.loja) { $('#le-cats').innerHTML = '<p class="muted">Salve a loja primeiro.</p>'; return; }
    const f = $('#form-loja'), a = ED.aparencia;
    for (const k of ['slogan', 'whatsapp', 'instagram', 'telefone', 'email_contato', 'horario', 'endereco', 'politica_entrega', 'politica_troca', 'logo_url', 'capa_url']) f[k].value = a[k] || '';
    f.mostrar_avaliacoes.checked = a.mostrar_avaliacoes;
    $('#le-cores').innerHTML = ED.cores.map(c => `<button type="button" class="le-cor" data-cor="${c}" title="${c}" style="background:linear-gradient(120deg, ${(CORES_LOJA[c] || CORES_LOJA.verde).join(', ')})"></button>`).join('');
    marcarCor(a.cor || 'verde');
    previewImg('logo_url'); previewImg('capa_url');
    renderCatalogos();
    renderAvaliacoesLoja();
  }
  $('#le-cores').addEventListener('click', e => { const b = e.target.closest('[data-cor]'); if (b) marcarCor(b.dataset.cor); });
  $('#form-loja').addEventListener('change', async e => {
    const campo = e.target.dataset?.leUpload;
    if (!campo || !e.target.files?.[0]) return;
    try {
      const r = await api('/api/conta/upload', { method: 'POST', raw: e.target.files[0] });
      $('#form-loja')[campo].value = r.url;
      previewImg(campo);
      toast('Imagem enviada. Clique em "Salvar loja" para publicar.');
    } catch (err) { toast(err.message); }
    e.target.value = '';
  });
  $('#form-loja').addEventListener('click', e => {
    const b = e.target.closest('[data-le-limpar]');
    if (!b) return;
    $('#form-loja')[b.dataset.leLimpar].value = '';
    previewImg(b.dataset.leLimpar);
  });

  // Catálogos
  function renderCatalogos() {
    $('#le-cats').innerHTML = ED.catalogos.length ? ED.catalogos.map(c => `<div class="le-cat"><div><b>${esc(c.nome)}</b>
        <small>${c.itens.length} produto(s)${c.descricao ? ` · ${esc(c.descricao)}` : ''}</small></div>
        <div class="row-actions"><button class="btn btn-sm" type="button" data-cat-editar="${c.id}">Editar</button>
        <button class="btn btn-sm danger-txt" type="button" data-cat-excluir="${c.id}">Excluir</button></div></div>`).join('')
      : '<p class="muted">Nenhum catálogo ainda.</p>';
  }
  function editorCatalogo(c) {
    const marcados = new Set(c ? c.itens : []);
    $('#le-cat-editor').innerHTML = `<div class="le-cat-editor" data-cat-id="${c ? c.id : ''}">
      <label class="field"><span>Nome do catálogo</span><input id="le-cat-nome" maxlength="50" value="${esc(c?.nome || '')}" placeholder="Ex.: Promoções da semana"></label>
      <label class="field"><span>Descrição <small>(opcional)</small></span><input id="le-cat-desc" maxlength="200" value="${esc(c?.descricao || '')}"></label>
      <div class="field"><span>Produtos <small id="le-cat-n">${marcados.size} escolhido(s)</small></span>
        <input id="le-cat-busca" type="search" placeholder="Filtrar produtos…">
        <div class="le-prods" id="le-prods">${ED.produtos.length ? ED.produtos.map(p => `<label data-nome="${esc(p.produto.toLowerCase())}"><input type="checkbox" value="${p.id}" ${marcados.has(p.id) ? 'checked' : ''}>
          <span>${esc(p.produto)}</span><small>R$ ${Number(p.preco_atual).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}${p.no_ar ? '' : ' · fora do ar'}</small></label>`).join('')
          : '<p class="muted" style="padding:8px">Cadastre produtos na aba Anúncios primeiro.</p>'}</div></div>
      <div class="row-actions"><button class="btn btn-primary" type="button" id="le-cat-salvar">Salvar catálogo</button><button class="btn" type="button" id="le-cat-cancelar">Cancelar</button></div>
    </div>`;
    $('#le-cat-nome').focus();
  }
  $('#le-cat-novo').addEventListener('click', () => editorCatalogo(null));
  $('[data-pane="loja"]').addEventListener('input', e => {
    if (e.target.id === 'le-cat-busca') {
      const t = e.target.value.trim().toLowerCase();
      $$('#le-prods label').forEach(l => { l.hidden = t && !l.dataset.nome.includes(t); });
    }
  });
  $('[data-pane="loja"]').addEventListener('change', e => {
    if (e.target.closest('#le-prods')) $('#le-cat-n').textContent = `${$$('#le-prods input:checked').length} escolhido(s)`;
  });
  $('[data-pane="loja"]').addEventListener('click', async e => {
    const ed = e.target.closest('[data-cat-editar]');
    if (ed) return editorCatalogo(ED.catalogos.find(c => c.id === Number(ed.dataset.catEditar)));
    const ex = e.target.closest('[data-cat-excluir]');
    if (ex) {
      if (!await OfertouUI.confirmar('Excluir este catálogo? Os produtos continuam na loja.')) return;
      try { ED.catalogos = (await api(`/api/conta/loja/catalogos/${ex.dataset.catExcluir}`, { method: 'DELETE' })).catalogos; renderCatalogos(); } catch (err) { toast(err.message); }
      return;
    }
    if (e.target.closest('#le-cat-cancelar')) { $('#le-cat-editor').innerHTML = ''; return; }
    if (e.target.closest('#le-cat-salvar')) {
      const box = $('#le-cat-editor .le-cat-editor');
      const id = box.dataset.catId;
      const body = { nome: $('#le-cat-nome').value, descricao: $('#le-cat-desc').value, itens: $$('#le-prods input:checked').map(i => Number(i.value)) };
      try {
        ED.catalogos = (await api(id ? `/api/conta/loja/catalogos/${id}` : '/api/conta/loja/catalogos', { method: id ? 'PUT' : 'POST', body })).catalogos;
        $('#le-cat-editor').innerHTML = '';
        renderCatalogos();
        toast('Catálogo salvo.');
      } catch (err) { toast(err.message); }
      return;
    }
    const rp = e.target.closest('[data-responder]');
    if (rp) {
      const t = $(`#le-resp-${rp.dataset.responder}`).value;
      try { ED.avaliacoes = await api(`/api/conta/loja/avaliacoes/${rp.dataset.responder}/responder`, { method: 'POST', body: { resposta: t } }); renderAvaliacoesLoja(); toast('Resposta salva.'); } catch (err) { toast(err.message); }
    }
  });

  // Avaliações recebidas (com resposta da loja)
  function renderAvaliacoesLoja() {
    const av = ED.avaliacoes, r = av.resumo;
    $('#le-aval-resumo').innerHTML = r.total ? `Nota média <b>${String(r.media).replace('.', ',')} ★</b> em ${r.total} avaliação(ões).` : 'Sua loja ainda não recebeu avaliações. Clientes avaliam pela aba "Avaliações" da página da loja.';
    $('#le-aval').innerHTML = av.itens.map(x => `<div class="le-aval-item">
      <div><b>${esc(x.autor.nome)}</b> · <span style="color:#f5b301">${'★'.repeat(x.nota)}${'☆'.repeat(5 - x.nota)}</span> <small class="muted">${fmtDate(x.updated_at || x.created_at)}${x.verificada ? ' · ✓ Compra verificada' : ''}</small></div>
      ${x.texto ? `<p style="margin:0">${esc(x.texto)}</p>` : ''}
      <textarea id="le-resp-${x.id}" maxlength="600" placeholder="Responder publicamente (opcional)">${esc(x.resposta || '')}</textarea>
      <div class="row-actions"><button class="btn btn-sm" type="button" data-responder="${x.id}">${x.resposta ? 'Atualizar resposta' : 'Responder'}</button></div>
    </div>`).join('');
  }



  // ── Lista de anúncios ──────────────────────────────────────────────────────
  async function loadProducts() {
    const list = await api('/api/conta/produtos').catch(() => []);
    $('#prod-count').textContent = `(${list.length})`;
    $('#new-ad').disabled = !LOJA || ME.bloqueio_publicacao;
    $('#prod-list').innerHTML = !LOJA
      ? '<p class="muted">Crie sua loja na aba "Minha loja" antes de anunciar.</p>'
      : list.length ? list.map(p => {
        const status = p.oculto ? ['Oculto pelo administrador', 'err'] : p.no_prazo ? ['No ar', 'ok'] : ['Expirado', ''];
        const isAd = p.fonte === 'empresa';
        return `<div class="prod-row">
          <img src="/img/p/${p.id}.webp" alt="" loading="lazy">
          <div style="min-width:0">
            <div class="t" title="${esc(p.produto)}">${esc(p.produto)}</div>
            <div class="s"><s>R$ ${brl(p.preco_anterior)}</s> R$ ${brl(p.preco_atual)} · -${p.desconto_pct}% ·
              <span class="status-pill ${status[1]}">${status[0]}</span> · ${isAd ? 'anúncio' : 'importado'} · ${p.link_clicks} clique(s)
              ${p.no_prazo ? ` · até ${fmtDate(p.expires_at)}` : ''}</div>
          </div>
          <div class="row-actions">
            ${isAd && p.no_prazo && !p.oculto ? `<a class="btn btn-sm" href="/anuncio/${p.id}">Ver</a>` : ''}
            ${isAd ? `<button class="btn btn-sm" type="button" data-edit="${p.id}">${p.no_prazo ? 'Editar' : 'Editar e renovar'}</button>` : ''}
            <button class="btn btn-sm" type="button" data-del="${p.id}">Excluir</button>
          </div>
        </div>`;
      }).join('') : '<p class="muted">Você ainda não tem anúncios. Clique em "Criar anúncio".</p>';
  }

  $('#prod-list').addEventListener('click', async e => {
    const del = e.target.closest('[data-del]');
    const edit = e.target.closest('[data-edit]');
    if (edit) return openEditor(Number(edit.dataset.edit));
    if (!del || !await OfertouUI.confirmar('Excluir este anúncio?')) return;
    try { await api(`/api/conta/produtos/${del.dataset.del}`, { method: 'DELETE' }); loadProducts(); toast('Anúncio excluído.'); }
    catch (err) { toast(err.message); }
  });
  $('#new-ad').addEventListener('click', () => openEditor());

  // ── Criador de anúncios ────────────────────────────────────────────────────
  let editingId = null;
  let photos = [];

  function fillAdSelects() {
    $('#ad-categoria').innerHTML = '<option value="">Selecione</option>' +
      INFO.categorias.map(c => `<option value="${c}">${esc(CAT_LABELS[c] || c)}</option>`).join('');
    $('#ad-condicao').innerHTML = '<option value="">Selecione</option>' +
      Object.entries(INFO.condicoes).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    $('#ad-frete').innerHTML = '<option value="">Selecione</option>' +
      Object.entries(INFO.fretes).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    $('#max-fotos').textContent = INFO.max_fotos;
  }

  async function openEditor(id = null) {
    editingId = id;
    const form = $('#form-ad');
    form.reset();
    msg(form, '');
    photos = [];
    $('#ad-editor-title').textContent = id ? 'Editar anúncio' : 'Criar anúncio';
    $('#ad-submit').textContent = id ? 'Salvar e publicar' : 'Publicar anúncio';
    if (id) {
      try {
        const ad = await api(`/api/conta/anuncios/${id}`);
        fillFields(form, {
          titulo: ad.produto, categoria: ad.categoria, condicao: ad.condicao, marca: ad.marca, modelo: ad.modelo,
          descricao: ad.descricao, preco_anterior: brl(ad.preco_anterior), preco_atual: brl(ad.preco_atual),
          parcelamento: ad.parcelamento, cupom_codigo: ad.cupom_codigo, cupom_descricao: ad.cupom_descricao,
          frete: ad.frete, frete_valor: ad.frete_valor != null ? brl(ad.frete_valor) : '', prazo_entrega: ad.prazo_entrega,
          estoque: ad.estoque ?? '', garantia: ad.garantia, sku: ad.sku, ean: ad.ean, url: ad.original_url, whatsapp: ad.whatsapp,
        });
        photos = ad.imagens || [];
      } catch (err) { return toast(err.message); }
    }
    $('#ads-list-card').hidden = true;
    $('#ad-editor').hidden = false;
    renderPhotos();
    updateAdUi();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function closeEditor() {
    $('#ad-editor').hidden = true;
    $('#ads-list-card').hidden = false;
  }
  $('#ad-cancel').addEventListener('click', () => { closeEditor(); loadProducts(); });

  // Fotos: envio, remoção e reordenação (arrastar)
  function renderPhotos() {
    $('#photo-grid').innerHTML = photos.map((src, i) => `
      <div class="photo-item" draggable="true" data-i="${i}">
        <img src="${esc(src)}" alt="" referrerpolicy="no-referrer">
        ${i === 0 ? '<span class="photo-badge">Capa</span>' : ''}
        <button type="button" class="photo-del" data-del-photo="${i}" aria-label="Remover foto">×</button>
      </div>`).join('') || '<p class="muted" style="margin:0">Nenhuma foto ainda.</p>';
    updatePreview();
  }

  async function uploadFiles(files) {
    for (const file of files) {
      if (photos.length >= INFO.max_fotos) { toast(`Máximo de ${INFO.max_fotos} fotos.`); break; }
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { toast(`${file.name}: use JPG, PNG ou WEBP.`); continue; }
      if (file.size > 3 * 1024 * 1024) { toast(`${file.name}: máximo 3 MB.`); continue; }
      try {
        const r = await api('/api/conta/upload', { method: 'POST', raw: file });
        photos.push(r.url);
        renderPhotos();
      } catch (err) { toast(err.message); }
    }
  }
  $('#photo-input').addEventListener('change', e => { uploadFiles([...e.target.files]); e.target.value = ''; });
  $('#photo-link').addEventListener('click', async () => {
    if (photos.length >= INFO.max_fotos) return toast(`Máximo de ${INFO.max_fotos} fotos.`);
    const url = await OfertouUI.perguntar('Link da foto (começando com https://):');
    if (!url) return;
    if (!/^https:\/\//i.test(url.trim())) return toast('Use um link começando com https://');
    photos.push(url.trim());
    renderPhotos();
  });
  $('#photo-grid').addEventListener('click', e => {
    const b = e.target.closest('[data-del-photo]');
    if (b) { photos.splice(Number(b.dataset.delPhoto), 1); renderPhotos(); }
  });
  let dragFrom = null;
  $('#photo-grid').addEventListener('dragstart', e => { dragFrom = Number(e.target.closest('.photo-item')?.dataset.i); });
  $('#photo-grid').addEventListener('dragover', e => e.preventDefault());
  $('#photo-grid').addEventListener('drop', e => {
    e.preventDefault();
    const to = Number(e.target.closest('.photo-item')?.dataset.i);
    if (Number.isInteger(dragFrom) && Number.isInteger(to) && dragFrom !== to) {
      const [moved] = photos.splice(dragFrom, 1);
      photos.splice(to, 0, moved);
      renderPhotos();
    }
    dragFrom = null;
  });
  // Arrastar arquivos do computador direto para a área de fotos
  const dropZone = $('#photo-grid').closest('fieldset');
  dropZone.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  dropZone.addEventListener('drop', e => {
    if (e.dataTransfer?.files?.length) { e.preventDefault(); uploadFiles([...e.dataTransfer.files]); }
  });

  // Contadores, desconto calculado, campo de frete e prévia ao vivo
  function updateAdUi() {
    const f = $('#form-ad');
    const anterior = parseMoney(f.preco_anterior.value), atual = parseMoney(f.preco_atual.value);
    const pct = anterior && atual && anterior > atual ? Math.round((anterior - atual) / anterior * 100) : null;
    $('#ad-discount').textContent = pct ? `— ${pct}% de desconto` : '';
    $('#frete-valor-field').hidden = f.frete.value !== 'pago';
    $('[data-count="titulo"]').textContent = `${f.titulo.value.length}/150`;
    $('[data-count="descricao"]').textContent = `${f.descricao.value.length}/3000 (mín. 20)`;
    updatePreview();
  }
  $('#form-ad').addEventListener('input', updateAdUi);
  $('#form-ad').addEventListener('change', updateAdUi);

  function updatePreview() {
    const f = $('#form-ad');
    const anterior = parseMoney(f.preco_anterior.value), atual = parseMoney(f.preco_atual.value);
    const pct = anterior && atual && anterior > atual ? Math.round((anterior - atual) / anterior * 100) : null;
    const frete = INFO.fretes[f.frete.value];
    $('#ad-preview-card').innerHTML = `<div class="card">
      <div class="card-media">
        ${photos[0] ? `<img src="${esc(photos[0])}" alt="" referrerpolicy="no-referrer">` : '<div class="preview-empty">Foto de capa</div>'}
        ${pct ? `<span class="card-off">-${pct}%</span>` : ''}
      </div>
      <div class="card-body">
        <div class="card-store"><span class="store-dot" style="background:var(--brand)"></span>Loja parceira · ${esc(LOJA?.nome || 'Sua loja')}</div>
        <h3 class="card-title">${esc(f.titulo.value || 'Título do anúncio')}</h3>
        <div class="card-prices">
          <div class="card-old num">${anterior ? `R$ ${brl(anterior)}` : '&nbsp;'}</div>
          <div class="card-price num"><small>R$</small>${atual ? brl(atual) : '0,00'}</div>
        </div>
        <div class="card-foot"><span>${esc([frete, f.parcelamento.value].filter(Boolean).join(' · ') || 'Publicado pela loja')}</span></div>
      </div>
    </div>`;
  }

  bind('#form-ad', async (form, d) => {
    const body = { ...d, imagens: photos };
    const r = editingId
      ? await api(`/api/conta/anuncios/${editingId}`, { method: 'PUT', body })
      : await api('/api/conta/anuncios', { method: 'POST', body });
    toast(editingId ? 'Anúncio atualizado!' : 'Anúncio publicado!');
    closeEditor();
    loadProducts();
    if (!editingId && await OfertouUI.confirmar('Anúncio publicado! Quer ver como ficou?')) location.href = `/anuncio/${r.id}`;
  });

  // ── Importação, dados e segurança ──────────────────────────────────────────
  bind('#form-feed', async (form, d) => {
    const r = await api('/api/conta/feed', { method: 'PUT', body: d });
    LOJA = r.loja;
    fillStore();
    msg(form, d.feed_url ? 'Link salvo. Clique em "Sincronizar agora" para importar.' : 'Importação desativada.', true);
  });

  $('#feed-sync').addEventListener('click', async () => {
    const btn = $('#feed-sync');
    btn.disabled = true; btn.textContent = 'Sincronizando…';
    try {
      const r = await api('/api/conta/feed/sincronizar', { method: 'POST' });
      toast(`${r.saved} produto(s) importado(s).`);
    } catch (err) { msg($('#form-feed'), err.message); }
    const me = await api('/api/conta/me'); LOJA = me.loja; fillStore();
    btn.disabled = false; btn.textContent = 'Sincronizar agora';
  });

  bind('#form-perfil', async (form, d) => {
    await api('/api/conta/perfil', { method: 'PUT', body: d });
    const me = await api('/api/conta/me'); ME = me.user;
    renderAccount(); openTab('perfil');
    msg($('#form-perfil'), 'Dados salvos!', true);
  });

  bind('#form-senha', async (form, d) => {
    await api('/api/conta/senha', { method: 'POST', body: d });
    form.reset();
    const me = await api('/api/conta/me'); ME = me.user;
    renderAccount(); openTab('seguranca');
    msg($('#form-senha'), 'Senha salva!', true);
  });

  bind('#form-excluir', async (form, d) => {
    if (!await OfertouUI.confirmar('Tem certeza? Sua conta, loja e anúncios serão apagados.')) return;
    await api('/api/conta/excluir', { method: 'POST', body: d });
    location.href = '/';
  });

  $('#logout').addEventListener('click', async () => {
    await api('/api/conta/sair', { method: 'POST' });
    ME = null; location.hash = ''; route();
  });

  // ── Mostrar/ocultar senha ──────────────────────────────────────────────────
  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.6 3.5M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/></svg>';

  function setPassVisible(btn, input, visible) {
    input.dataset.senha = '1'; // continua sendo campo de senha mesmo visível (regras da senha em cadastro-auto.js)
    input.type = visible ? 'text' : 'password';
    btn.innerHTML = visible ? EYE_OFF : EYE;
    btn.setAttribute('aria-label', visible ? 'Ocultar senha' : 'Mostrar senha');
    btn.setAttribute('aria-pressed', String(visible));
  }

  $$('input[type=password]').forEach(input => {
    const wrap = document.createElement('span');
    wrap.className = 'pass-wrap';
    input.replaceWith(wrap);
    wrap.appendChild(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pass-toggle';
    wrap.appendChild(btn);
    setPassVisible(btn, input, false);
    btn.addEventListener('click', e => {
      e.preventDefault();
      setPassVisible(btn, input, input.type === 'password');
      input.focus();
    });
    // Ao limpar o formulário (depois de enviar), a senha volta a ficar oculta.
    input.form?.addEventListener('reset', () => setPassVisible(btn, input, false));
  });

  // ── Início ─────────────────────────────────────────────────────────────────
  (async () => {
    INFO = { ...INFO, ...(await api('/api/conta/cadastro-info').catch(() => ({}))) };
    renderFieldBlocks();
    fillAdSelects();
    await route();
  })().catch(err => { document.querySelector('main').innerHTML = `<p class="container">Erro: ${esc(err.message)}</p>`; });
})();
