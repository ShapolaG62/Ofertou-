/* Ofertou! — tela de postagens: produtos escolhidos, textos editáveis e publicação nas redes sociais */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const brl = v => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const parseDate = s => (s ? new Date(String(s).replace(' ', 'T') + 'Z') : null);
  const fmtWhen = d => d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const STORES = { mercadolivre: 'Mercado Livre', amazon: 'Amazon', shopee: 'Shopee', magalu: 'Magalu', shein: 'Shein', aliexpress: 'AliExpress', kabum: 'KaBuM!', temu: 'Temu' };

  // Seleção e textos editados ficam no navegador (mesma chave usada pela página de ofertas).
  const SEL_KEY = 'gp_postagens';
  const TXT_KEY = 'gp_postagens_textos';
  const NET_KEY = 'gp_postagens_redes';
  const GRUPOS_KEY = 'gp_postagens_grupos';
  const MODO_KEY = 'gp_postagens_modo';
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento */ } };

  let OFFERS = [];
  let REDES = [];
  let WA_INTERVALO = 90;
  let textos = load(TXT_KEY, {});
  const excluded = new Set();
  let stopRequested = false;

  let toastTimer;
  function toast(msg, ms = 2800) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  // Título: no máximo ~2 linhas na tela do celular (corta na palavra e põe "…")
  const TITULO_MAX = 58;
  function tituloCurto(t) {
    t = String(t || '').replace(/\s+/g, ' ').trim();
    if (t.length <= TITULO_MAX) return t;
    const corte = t.slice(0, TITULO_MAX + 1).replace(/\s+\S*$/, '').replace(/[\s,;:.\-–—|/(]+$/, '');
    return `${corte || t.slice(0, TITULO_MAX)}…`;
  }
  // Texto pelo modelo do dono (Painel ou Meu painel → Modelo da mensagem); vazio = padrão do site
  let MODELO = '';
  function defaultText(o) {
    const seen = parseDate(o.last_seen_at);
    return window.OfertouModelo.aplicar(MODELO, {
      produto: tituloCurto(o.produto), preco_de: brl(o.preco_anterior), preco: brl(o.preco_atual),
      desconto: String(Math.round(o.desconto_pct)), economia: brl(Math.max(0, o.preco_anterior - o.preco_atual)),
      loja: STORES[o.store_id] || o.plataforma, link: o.link, cupom: o.cupom || '',
      conferido: seen && !isNaN(seen) ? fmtWhen(seen) : '',
      relampago: window.OfertouModelo.topoRelampago(o),
    });
  }
  const textOf = o => textos[o.id] ?? defaultText(o);

  function selection() { return load(SEL_KEY, []).map(Number).filter(Boolean); }
  function setSelection(ids) { save(SEL_KEY, ids); }

  // ── Redes ──────────────────────────────────────────────────────────────────
  function renderNets(info) {
    const chosen = load(NET_KEY, []);
    $('#net-list').innerHTML = REDES.map(r => `
      <label class="net-option${r.pronta ? '' : ' is-off'}" title="${esc(r.motivo || '')}">
        <input type="checkbox" value="${r.id}" ${r.pronta ? '' : 'disabled'} ${r.pronta && chosen.includes(r.id) ? 'checked' : ''}>
        <span>${esc(r.nome)}</span>${r.pronta ? '' : '<small>não configurada</small>'}
      </label>`).join('');
    const ag = info.agenda;
    $('#agenda-info').innerHTML = ag.ativa
      ? `Agendamento ligado: ${ag.horarios.join(', ')} (próximo às <b>${esc(ag.proximo || '—')}</b>) em ${ag.redes.map(id => esc(REDES.find(r => r.id === id)?.nome || id)).join(', ')}. ${ag.pendentes} oferta(s) na fila.`
      : `Agendamento desligado${info.admin ? ' (ligue em <a class="link-btn" href="/admin">Painel → Redes sociais</a>)' : ''}. ${ag.pendentes} oferta(s) na fila.`;
    const off = REDES.filter(r => !r.pronta);
    const hint = $('#net-hint');
    hint.hidden = !off.length;
    const onde = info.admin ? '<a class="link-btn" href="/admin">Painel → Redes sociais</a>'
      : info.cliente ? '<a class="link-btn" href="/cliente">Meu painel → Redes sociais</a>' : null;
    hint.innerHTML = off.length
      ? `Redes não configuradas: ${off.map(r => esc(r.nome)).join(', ')}. ${onde ? `Configure em ${onde}.` : 'Peça ao administrador para configurar.'}`
      : '';
    // Cliente da ferramenta: avisa as lojas sem o link de afiliado dele (esses produtos vão sem comissão).
    const falta = info.cliente?.sem_afiliado || [];
    $('#afiliado-aviso').hidden = !falta.length;
    $('#afiliado-aviso').innerHTML = falta.length
      ? `Sem link de afiliado seu para: <b>${falta.map(esc).join(', ')}</b>. Produtos dessas lojas vão sem comissão — configure em <a class="link-btn" href="/cliente">Meu painel → Links de afiliado</a>.`
      : '';
  }
  $('#net-list').addEventListener('change', () => {
    save(NET_KEY, [...document.querySelectorAll('#net-list input:checked')].map(i => i.value));
    $('#wa-destinos').hidden = !usaWhatsapp();
    atualizarDestinosDosCards();
  });

  // ── Menu lateral e números do topo, no padrão do painel do afiliado ──
  // Dentro do painel do afiliado (quadro) o menu dele já está na tela: aparece tudo, sem o segundo menu.
  const embutido = document.documentElement.classList.contains('embutido');
  function abrirAba(aba) {
    document.querySelectorAll('[data-pg-aba]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.pgAba === aba)));
    document.querySelectorAll('[data-pg-corpo]').forEach(c => { c.hidden = !embutido && c.dataset.pgCorpo !== aba; });
  }
  document.querySelector('.cli-nav').addEventListener('click', e => {
    const b = e.target.closest('[data-pg-aba]');
    if (b) abrirAba(b.dataset.pgAba);
  });
  abrirAba('postar');
  let AGENDA = null;
  function atualizarKpis() {
    const incluidos = OFFERS.filter(o => !excluded.has(o.id)).length;
    $('#pg-k-produtos').textContent = incluidos;
    $('#pg-k-produtos-d').textContent = OFFERS.length === incluidos ? 'para postar agora' : `de ${OFFERS.length} escolhidos`;
    $('#pg-k-grupos').textContent = GRUPOS.filter(g => marcados.has(g.id)).length;
    $('#pg-k-grupos-d').textContent = GRUPOS.length ? `de ${GRUPOS.length} no WhatsApp` : 'no WhatsApp';
    if (!AGENDA) return;
    $('#pg-k-fila').textContent = AGENDA.pendentes;
    $('#pg-k-agenda').textContent = AGENDA.ativa ? 'Ligado' : 'Desligado';
    $('#pg-k-agenda-d').textContent = AGENDA.ativa && AGENDA.proximo ? `próximo às ${AGENDA.proximo}` : '';
  }

  // ── Grupos do WhatsApp: você escolhe os produtos e depois os grupos ──
  let GRUPOS = [];
  let TEMAS = [];
  let marcados = new Set(load(GRUPOS_KEY, []));
  let porTipo = load(MODO_KEY, 'tipo') !== 'todos';
  const usaWhatsapp = () => Boolean(document.querySelector('#net-list input[value="whatsapp"]:checked'));
  // Categorias que o grupo recebe: as salvas no painel ou o tipo que o nome sugere. Vazio = todas.
  const categoriasDoGrupo = g => (g.categorias?.length ? g.categorias : (g.sugestao || []).flatMap(id => TEMAS.find(t => t.id === id)?.categorias || []));
  const destinosDe = o => GRUPOS.filter(g => marcados.has(g.id)).filter(g => {
    if (!porTipo) return true;
    const c = categoriasDoGrupo(g), l = g.lojas || [];
    return (!c.length || c.includes(o.categoria)) && (!l.length || l.includes(o.store_id));
  });
  const nomesTemas = g => {
    const c = categoriasDoGrupo(g), l = g.lojas || [];
    const partes = [...TEMAS.filter(t => t.categorias.some(x => c.includes(x))).map(t => `${t.icone} ${t.nome}`), ...l.map(id => STORES[id] || id)];
    return partes.length ? partes.join(', ') : 'Recebe todas as ofertas';
  };
  function desenharGrupos(d) {
    for (const l of d.lojas || []) STORES[l.id] = l.nome; // inclui as lojas parceiras
    const caixa = $('#wa-destinos');
    caixa.hidden = !usaWhatsapp();
    $('#wa-destinos-info').innerHTML = d?.erro ? esc(d.erro)
      : `${GRUPOS.length ? 'Só os grupos que este número criou e administra.' : 'Nenhum grupo criado e administrado por este número.'} ${d?.ocultos ? esc(window.OfertouTemas.avisoOcultos(d.ocultos)) : ''}`;
    $('#wa-destinos-lista').innerHTML = GRUPOS.map(g => `<label class="wa-destino">
      <input type="checkbox" data-destino="${esc(g.id)}" ${marcados.has(g.id) ? 'checked' : ''}>
      ${window.OfertouTemas.avatar(g.nome, g.foto)}
      <span class="wa-grupo-nome"><b>${esc(g.nome)}</b><small>${esc(nomesTemas(g))}${g.membros ? ` · ${window.OfertouTemas.pessoas(g.membros)}` : ''}</small></span>
    </label>`).join('');
    document.querySelectorAll('[data-wa-modo]').forEach(b => {
      const ativo = (b.dataset.waModo === 'tipo') === porTipo;
      b.setAttribute('aria-checked', String(ativo)); b.setAttribute('aria-pressed', String(ativo));
    });
  }
  // Em cada produto: de que tipo ele é e para quais grupos vai
  function atualizarDestinosDosCards() {
    for (const o of OFFERS) {
      const el = document.querySelector(`[data-vai="${o.id}"]`);
      if (!el) continue;
      if (!usaWhatsapp()) { el.hidden = true; continue; }
      const d = destinosDe(o);
      el.hidden = false;
      el.classList.toggle('sem-grupo', !d.length);
      el.textContent = d.length ? `Vai para: ${d.map(g => g.nome).join(', ')}` : 'Nenhum grupo marcado recebe este tipo de produto desta loja.';
    }
  }
  function salvarMarcados() { save(GRUPOS_KEY, [...marcados]); atualizarDestinosDosCards(); atualizarKpis(); }
  $('#wa-destinos-lista').addEventListener('change', e => {
    const c = e.target.closest('[data-destino]');
    if (!c) return;
    c.checked ? marcados.add(c.dataset.destino) : marcados.delete(c.dataset.destino);
    salvarMarcados();
  });
  $('#wa-marcar').addEventListener('click', () => { marcados = new Set(GRUPOS.map(g => g.id)); desenharGrupos(); salvarMarcados(); });
  $('#wa-desmarcar').addEventListener('click', () => { marcados = new Set(); desenharGrupos(); salvarMarcados(); });
  $('#wa-modo').addEventListener('click', e => {
    const b = e.target.closest('[data-wa-modo]');
    if (!b) return;
    porTipo = b.dataset.waModo === 'tipo';
    save(MODO_KEY, b.dataset.waModo);
    desenharGrupos();
    atualizarDestinosDosCards();
  });
  async function carregarGrupos() {
    const d = await fetch('/api/postagens/meus-grupos').then(r => r.json()).catch(() => ({ erro: 'Sem conexão.', grupos: [], temas: [] }));
    GRUPOS = d.grupos || [];
    TEMAS = d.temas || [];
    const ids = new Set(GRUPOS.map(g => g.id));
    const guardados = [...marcados].filter(id => ids.has(id));
    marcados = new Set(guardados.length ? guardados : GRUPOS.filter(g => g.salvo).map(g => g.id)); // começa pelos grupos salvos no painel
    desenharGrupos(d);
    atualizarDestinosDosCards();
    atualizarKpis();
  }

  // ── Lista de produtos ──────────────────────────────────────────────────────
  // Foto de cada produto já baixada como arquivo, para o botão WhatsApp compartilhar foto + legenda na hora do clique
  // (o "Compartilhar" do aparelho só abre se for chamado logo depois do clique, sem esperar download).
  const fotoPronta = {};
  function prepararFotos() {
    if (!navigator.canShare) return;
    for (const o of OFFERS) {
      if (fotoPronta[o.id] !== undefined) continue;
      fotoPronta[o.id] = null;
      fetch(`/api/img/${o.id}?copiar=1`).then(r => (r.ok ? r.blob() : null)).then(b => {
        if (!b || !/^image\//.test(b.type)) return;
        const ext = (b.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
        fotoPronta[o.id] = new File([b], `oferta-${o.id}.${ext}`, { type: b.type });
      }).catch(() => {});
    }
  }

  function render() {
    prepararFotos();
    const n = OFFERS.length;
    $('#posts-sub').textContent = n
      ? `${n} produto${n === 1 ? '' : 's'} escolhido${n === 1 ? '' : 's'}. Edite os textos se quiser e publique manualmente ou automaticamente.`
      : 'Nenhum produto escolhido.';
    $('#auto-post').disabled = !n;
    if (!n) {
      $('#posts-list').innerHTML = `<div class="empty"><img src="/images/pet-capi.png" alt="" width="120">
        <h3>Nenhum produto escolhido</h3><p>Volte às ofertas e toque no ✓ dos produtos que quer postar.</p>
        <a class="btn btn-primary" href="/">Escolher produtos</a></div>`;
      return;
    }
    $('#posts-list').innerHTML = OFFERS.map(o => {
      const text = textOf(o);
      const posted = Object.entries(o.postado_em || {}).map(([r, em]) => `${esc(REDES.find(x => x.id === r)?.nome || r)} ${fmtWhen(parseDate(em))}`);
      return `<article class="post-item post-card${excluded.has(o.id) ? ' is-excluded' : ''}" data-id="${o.id}">
        <header>
          <img src="${esc(o.imagem_url || `/api/img/${o.id}`)}" alt="" loading="lazy">
          <div class="post-card-info">
            <strong>${esc(o.produto)}</strong>
            <span><s>R$ ${brl(o.preco_anterior)}</s> <b>R$ ${brl(o.preco_atual)}</b> · -${Math.round(o.desconto_pct)}% · ${esc(STORES[o.store_id] || o.plataforma)}</span>
            <span class="post-tipo">${esc(o.tema?.icone || '')} ${esc(o.tema?.nome || '')}</span>
            <span class="post-vai" data-vai="${o.id}" hidden></span>
            ${posted.length ? `<span class="post-done">Já postado: ${posted.join(' · ')}</span>` : ''}
          </div>
          <label class="post-include" title="Incluir na postagem automática">
            <input type="checkbox" data-include="${o.id}" ${excluded.has(o.id) ? '' : 'checked'}> Incluir
          </label>
        </header>
        <textarea class="post-text" data-text="${o.id}" rows="9" aria-label="Texto da postagem">${esc(text)}</textarea>
        <div class="post-actions">
          <button class="btn btn-sm" type="button" data-copy="${o.id}">Copiar texto</button>
          <a class="btn btn-sm" href="${esc(o.imagem_url || `/api/img/${o.id}`)}" download="oferta-${o.id}.jpg">Baixar imagem</a>
          <a class="btn btn-sm" data-share="wa" href="#" target="_blank" rel="noopener"><svg><use href="#i-wa"/></svg>WhatsApp</a>
          <a class="btn btn-sm" data-share="tg" href="#" target="_blank" rel="noopener"><svg><use href="#i-tg"/></svg>Telegram</a>
          <button class="btn btn-sm" type="button" data-reset="${o.id}">Texto original</button>
          <button class="btn btn-sm post-remove" type="button" data-remove="${o.id}">Remover</button>
        </div>
        <div class="post-status" data-status="${o.id}"></div>
      </article>`;
    }).join('');
    atualizarDestinosDosCards();
    atualizarKpis();
  }

  // Foto do produto em PNG (único formato de imagem que a área de transferência aceita)
  const fotoPng = o => fetch(`/api/img/${o.id}?copiar=1`).then(r => r.blob()).then(createImageBitmap).then(bmp => {
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    return new Promise((ok, erro) => c.toBlob(b => (b ? ok(b) : erro(new Error('sem imagem'))), 'image/png'));
  });

  // Onde o botão WhatsApp abre no computador (escolha salva neste navegador): WhatsApp Web, app instalado ou a
  // página do WhatsApp que pergunta. No celular, abre sempre o app.
  const WA_ABRIR_KEY = 'gp_wa_abrir';
  const waAbrir = () => { try { return localStorage.getItem(WA_ABRIR_KEY) || 'web'; } catch { return 'web'; } };
  function linkWhatsapp(text) {
    const t = encodeURIComponent(text);
    if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return `https://api.whatsapp.com/send?text=${t}`;
    return { web: `https://web.whatsapp.com/send?text=${t}`, app: `whatsapp://send?text=${t}` }[waAbrir()] || `https://api.whatsapp.com/send?text=${t}`;
  }
  if ($('#wa-abrir')) {
    $('#wa-abrir').value = waAbrir();
    $('#wa-abrir').addEventListener('change', e => { try { localStorage.setItem(WA_ABRIR_KEY, e.target.value); } catch { /* sem armazenamento */ } });
  }

  const offerOf = el => OFFERS.find(o => o.id === Number(el.closest('[data-id]').dataset.id));

  $('#posts-list').addEventListener('input', e => {
    const t = e.target.closest('[data-text]');
    if (!t) return;
    textos[t.dataset.text] = t.value;
    save(TXT_KEY, textos);
  });

  $('#posts-list').addEventListener('click', e => {
    const share = e.target.closest('[data-share]');
    if (share) {
      // Links de compartilhar montados na hora do clique, com o texto já editado.
      const o = offerOf(share);
      const text = textOf(o);
      // WhatsApp: manda a FOTO do produto com o texto de legenda (o link fica só no texto, sem o quadro de prévia).
      // Celular: "Compartilhar" do aparelho com foto + texto. Computador: copia a foto e abre o WhatsApp com o texto;
      // ao colar (Ctrl+V) a foto na conversa, o texto digitado vira a legenda.
      const celular = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      if (share.dataset.share === 'wa' && celular && navigator.canShare && fotoPronta[o.id]
        && navigator.canShare({ files: [fotoPronta[o.id]], text })) {
        e.preventDefault();
        navigator.share({ files: [fotoPronta[o.id]], text }).catch(err => {
          if (err.name !== 'AbortError') window.open(linkWhatsapp(text), '_blank', 'noopener');
        });
        return;
      }
      if (share.dataset.share === 'wa' && !celular && window.ClipboardItem && navigator.clipboard?.write) {
        navigator.clipboard.write([new ClipboardItem({ 'image/png': fotoPng(o) })])
          .then(() => toast('Foto copiada! Na conversa do WhatsApp, aperte Ctrl+V antes de enviar: a foto entra e o texto vira a legenda.', 9000))
          .catch(() => toast('Não consegui copiar a foto. Use "Baixar imagem" e anexe na conversa.', 7000));
      }
      share.href = share.dataset.share === 'wa'
        ? linkWhatsapp(text)
        : `https://t.me/share/url?url=${encodeURIComponent(o.link)}&text=${encodeURIComponent(text)}`;
      if (share.dataset.share === 'wa' && !celular) {
        // Sem abrir uma aba nova a cada clique:
        //  • app: o link whatsapp:// vai para o app que já está aberto (a página do site continua onde está);
        //  • Web: usa sempre a mesma aba ("ofertou-whatsapp"). Se ela ainda estiver aberta, o WhatsApp Web carrega ali
        //    a conversa nova e a aba vem para a frente. (Uma aba do WhatsApp Web aberta à mão, fora do site, o navegador
        //    não deixa o site encontrar.)
        e.preventDefault();
        if (waAbrir() === 'app') { location.href = share.href; return; }
        const w = window.open(share.href, 'ofertou-whatsapp');
        if (w) { try { w.opener = null; } catch { /* outra origem */ } w.focus(); }
      }
      return;
    }
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.copy) {
      navigator.clipboard.writeText(textOf(offerOf(b))).then(() => toast('Texto copiado.'));
    } else if (b.dataset.reset) {
      delete textos[b.dataset.reset]; save(TXT_KEY, textos);
      b.closest('article').querySelector('textarea').value = textOf(offerOf(b));
    } else if (b.dataset.remove) {
      const id = Number(b.dataset.remove);
      setSelection(selection().filter(x => x !== id));
      delete textos[id]; save(TXT_KEY, textos);
      OFFERS = OFFERS.filter(o => o.id !== id);
      render();
    }
  });

  $('#posts-list').addEventListener('change', e => {
    const c = e.target.closest('[data-include]');
    if (!c) return;
    const id = Number(c.dataset.include);
    c.checked ? excluded.delete(id) : excluded.add(id);
    c.closest('article').classList.toggle('is-excluded', !c.checked);
    atualizarKpis();
  });

  $('#copy-all').addEventListener('click', () => {
    const list = OFFERS.filter(o => !excluded.has(o.id));
    if (!list.length) return toast('Nenhum produto incluído.');
    navigator.clipboard.writeText(list.map(textOf).join('\n\n———\n\n')).then(() => toast(`${list.length} textos copiados.`));
  });

  $('#clear-all').addEventListener('click', () => {
    if (!OFFERS.length) return;
    setSelection([]); textos = {}; save(TXT_KEY, textos);
    OFFERS = []; render();
    toast('Seleção limpa.');
  });

  // ── Postagem automática ────────────────────────────────────────────────────
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let confirmTimer;

  $('#auto-post').addEventListener('click', async () => {
    const redes = [...document.querySelectorAll('#net-list input:checked')].map(i => i.value);
    const list = OFFERS.filter(o => !excluded.has(o.id));
    if (!redes.length) return toast('Marque pelo menos uma rede configurada.');
    if (!list.length) return toast('Nenhum produto incluído.');
    const comGrupos = redes.includes('whatsapp');
    if (comGrupos && !marcados.size) return toast('Marque pelo menos um grupo do WhatsApp.');
    const gruposEnvio = comGrupos ? [...marcados] : [];

    // Primeiro clique pede confirmação; o segundo publica.
    const btn = $('#auto-post');
    if (!btn.dataset.confirm) {
      btn.dataset.confirm = '1';
      btn.textContent = `Confirmar: ${list.length} produto${list.length === 1 ? '' : 's'} em ${redes.map(r => REDES.find(x => x.id === r).nome).join(', ')}${comGrupos ? ` (${gruposEnvio.length} grupo${gruposEnvio.length === 1 ? '' : 's'})` : ''}`;
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => { delete btn.dataset.confirm; btn.textContent = 'Postar automaticamente'; }, 6000);
      return;
    }
    clearTimeout(confirmTimer);
    delete btn.dataset.confirm;
    btn.textContent = 'Postando…';
    btn.disabled = true;
    stopRequested = false;
    $('#auto-stop').hidden = false;
    const prog = $('#progress');
    prog.hidden = false;
    let ok = 0, falhas = 0;

    for (let i = 0; i < list.length; i++) {
      if (stopRequested) break;
      const o = list[i];
      prog.textContent = `Publicando ${i + 1} de ${list.length}: ${o.produto.slice(0, 60)}…`;
      const st = document.querySelector(`[data-status="${o.id}"]`);
      // Sem grupo do tipo dele e sem outra rede: nada a publicar neste produto
      if (comGrupos && redes.length === 1 && !destinosDe(o).length) {
        if (st) st.innerHTML = '<span class="post-fail">Pulado: nenhum grupo marcado recebe este tipo de produto desta loja.</span>';
        continue;
      }
      if (st) st.innerHTML = '<span class="post-pending">Publicando…</span>';
      try {
        const res = await fetch('/api/postagens/publicar', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ offer_id: o.id, redes, texto: textOf(o), ...(comGrupos ? { grupos: gruposEnvio, por_tipo: porTipo } : {}) }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || `Erro ${res.status}`);
        for (const r of d.resultados) {
          r.ok ? ok++ : falhas++;
          if (r.ok) (o.postado_em ||= {})[r.rede] = new Date().toISOString().replace('T', ' ').slice(0, 19);
        }
        if (st) st.innerHTML = d.resultados.map(r => `<span class="${r.ok ? 'post-ok' : 'post-fail'}">${esc(REDES.find(x => x.id === r.rede)?.nome || r.rede)}: ${r.ok ? 'publicado' : esc(r.mensagem)}</span>`).join('');
      } catch (err) {
        falhas++;
        if (st) st.innerHTML = `<span class="post-fail">${esc(err.message)}</span>`;
        if (/limite|permiss/i.test(err.message)) break;
      }
      // Intervalo entre postagens (evita bloqueio por spam); no WhatsApp é bem maior.
      if (i < list.length - 1 && !stopRequested) {
        let espera = redes.includes('whatsapp') ? WA_INTERVALO : 3;
        while (espera > 0 && !stopRequested) {
          prog.textContent = `Próxima postagem em ${espera}s… (${i + 1} de ${list.length} feitas)`;
          await sleep(1000); espera--;
        }
      }
    }

    prog.textContent = `${stopRequested ? 'Interrompido. ' : 'Concluído. '}${ok} publicação(ões) feitas${falhas ? `, ${falhas} com erro (veja em cada produto)` : ''}.`;
    btn.textContent = 'Postar automaticamente';
    btn.disabled = false;
    $('#auto-stop').hidden = true;
  });
  $('#auto-stop').addEventListener('click', () => { stopRequested = true; $('#auto-stop').hidden = true; });

  // Fila das postagens agendadas (manhã, tarde e noite): leva os produtos incluídos com o texto editado.
  $('#to-queue').addEventListener('click', async () => {
    const list = OFFERS.filter(o => !excluded.has(o.id));
    if (!list.length) return toast('Nenhum produto incluído.');
    try {
      const res = await fetch('/api/postagens/fila', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itens: list.map(o => ({ offer_id: o.id, texto: textOf(o) })), ...(usaWhatsapp() && marcados.size ? { grupos: [...marcados], por_tipo: porTipo } : {}) }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `Erro ${res.status}`);
      toast(`${d.adicionados} produto(s) na fila. Total esperando: ${d.pendentes}.`);
      const info = await fetch('/api/postagens/redes').then(r => r.json());
      renderNets(info);
      AGENDA = info.agenda;
      atualizarKpis();
    } catch (err) { toast(err.message); }
  });

  // ── Conversor de link ──────────────────────────────────────────────────────
  $('#conv-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button'), res = $('#conv-res');
    btn.disabled = true; res.hidden = false; res.textContent = 'Convertendo…';
    try {
      const r = await fetch('/api/postagens/converter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: $('#conv-url').value }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Erro ${r.status}`);
      res.innerHTML = `<div class="conv-linha"><code>${esc(d.link)}</code><button class="btn btn-sm" type="button" data-conv-copiar>Copiar</button></div>
        <small>${esc(d.loja)}${d.aviso ? ` · <span class="conv-aviso">${esc(d.aviso)}</span>` : ''}</small>`;
      res.querySelector('[data-conv-copiar]').addEventListener('click', () => navigator.clipboard.writeText(d.link).then(() => toast('Link copiado.')));
    } catch (err) { res.textContent = err.message; }
    btn.disabled = false;
  });

  // ── Início ─────────────────────────────────────────────────────────────────
  (async () => {
    try {
      const info = await fetch('/api/postagens/redes').then(r => {
        if (r.status === 403 || r.status === 401) { location.href = '/conta?voltar=/postagens'; throw new Error('sem permissão'); }
        return r.json();
      });
      REDES = info.redes;
      MODELO = info.modelo || '';
      AGENDA = info.agenda;
      const quem = info.cliente?.nome || (info.admin ? 'Administrador' : 'Postagens');
      $('#pg-nome').textContent = quem;
      $('#pg-avatar').textContent = quem.trim().charAt(0).toUpperCase();
      $('#pg-painel').hidden = !info.cliente;
      $('#painel-cliente').hidden = !info.cliente;
      WA_INTERVALO = Math.max(20, Number(info.whatsapp_intervalo_s) || 90);
      renderNets(info);
      carregarGrupos();
      const ids = selection();
      const rows = ids.length ? await fetch(`/api/postagens/ofertas?ids=${ids.join(',')}`).then(r => r.json()) : [];
      const byId = new Map(rows.map(o => [o.id, o]));
      OFFERS = ids.map(id => byId.get(id)).filter(Boolean); // mantém a ordem em que foram escolhidos
      if (OFFERS.length !== ids.length) setSelection(OFFERS.map(o => o.id)); // remove ofertas que não existem mais
      render();
    } catch (err) {
      if (err.message !== 'sem permissão') $('#posts-sub').textContent = `Erro ao carregar: ${err.message}`;
    }
  })();
})();
