// Painéis do admin e do cliente → Repostar ofertas de outros grupos (src/repostar-grupos.js).
// Escolhe os grupos de origem (de outras pessoas), de quais origens cada um dos "Grupos de destino" recebe, os filtros,
// e mostra o que foi feito com cada oferta.
(function () {
  const caixa = document.getElementById('repostar');
  if (!caixa) return;
  const BASE = caixa.dataset.base;
  const LOJAS = { mercadolivre: 'Mercado Livre', amazon: 'Amazon', shopee: 'Shopee', magalu: 'Magalu', kabum: 'KaBuM!', aliexpress: 'AliExpress' };
  const NOME_SEM_AFILIADO = { 'Mercado Livre': 'mercadolivre', Amazon: 'amazon', Shopee: 'shopee', Magalu: 'magalu', 'KaBuM!': 'kabum', AliExpress: 'aliexpress' };
  const SITUACAO = { postada: 'Postada', ignorada: 'Não postada', erro: 'Falhou' };
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let grupos = null;           // lista carregada do número
  const escolha = new Map();   // id → 'origem'
  const nomes = new Map();
  const recebe = new Map();    // grupo de destino → Set das origens de que ele recebe
  let dados = null;

  async function pedir(caminho = '', opcoes = {}) {
    const r = await fetch(BASE + caminho, {
      method: opcoes.method || 'GET',
      headers: opcoes.body ? { 'Content-Type': 'application/json' } : {},
      body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Erro ${r.status}`);
    return d;
  }

  document.head.insertAdjacentHTML('beforeend', `<style>
    .rp-topo { display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
    .rp-chave { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; cursor: pointer; }
    .rp-chave input { width: 18px; height: 18px; accent-color: var(--brand, var(--green)); }
    .rp-alerta { margin: 12px 0 0; padding: 10px 12px; border-radius: 10px; font-size: 13px; line-height: 1.5;
      background: color-mix(in srgb, var(--yellow, #9a6a00) 12%, transparent); border: 1px solid color-mix(in srgb, var(--yellow, #9a6a00) 40%, transparent); }
    .rp-secao { margin-top: 18px; }
    .rp-secao h3 { margin: 0 0 6px; font-size: 15px; }
    .rp-barra { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .rp-barra input { flex: 1 1 200px; min-width: 0; }
    #rp-busca { height: 44px; padding: 0 14px; border: 1px solid var(--line-strong, var(--border-strong)); border-radius: 10px; background: var(--surface); color: var(--ink, var(--text)); font: inherit; }
    .rp-contagem { font-size: 13px; color: var(--ink-3, var(--muted)); }
    .rp-lista { margin-top: 10px; display: grid; gap: 6px; max-height: 420px; overflow-y: auto; padding-right: 2px; }
    .rp-grupo { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--line, var(--border)); border-radius: 10px; background: var(--surface-2); }
    .rp-grupo[data-papel=origem] { border-color: var(--blue, #2563eb); }
    .rp-dest { padding: 10px 12px; border: 1px solid var(--line, var(--border)); border-radius: 10px; background: var(--surface-2); }
    .rp-dest[data-ok="1"] { border-color: var(--brand, var(--green)); }
    .rp-dest > b { display: block; font-size: 14px; overflow-wrap: anywhere; }
    .rp-dest > small { display: block; margin: 2px 0 8px; font-size: 12px; color: var(--ink-3, var(--muted)); }
    .rp-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .rp-chips label { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 6px 12px; border: 1px solid var(--line-strong, var(--border-strong)); border-radius: 99px; font-size: 13px; cursor: pointer; overflow-wrap: anywhere; }
    .rp-chips input { width: 16px; height: 16px; flex: 0 0 auto; accent-color: var(--brand, var(--green)); }
    .rp-chips label:has(input:checked) { border-color: var(--brand, var(--green)); background: color-mix(in srgb, var(--brand, var(--green)) 14%, transparent); font-weight: 600; }
    .rp-chips .rp-todas { border-style: dashed; }
    .rp-gnome { flex: 1; min-width: 0; font-size: 14px; overflow-wrap: anywhere; }
    .rp-gnome small { display: block; color: var(--ink-3, var(--muted)); font-size: 12px; }
    .rp-grupo select { flex: 0 0 auto; width: auto; max-width: 46%; }
    .rp-campos { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr)); }
    .rp-lojas { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 6px; }
    .rp-lojas label { display: inline-flex; gap: 6px; align-items: center; font-size: 14px; }
    .rp-lojas em { font-style: normal; font-size: 12px; color: var(--yellow, #9a6a00); }
    .rp-resumo { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 120px), 1fr)); }
    .rp-num { padding: 10px 12px; border: 1px solid var(--line, var(--border)); border-radius: 10px; background: var(--surface-2); }
    .rp-num b { display: block; font-size: 20px; }
    .rp-num span { font-size: 12px; color: var(--ink-3, var(--muted)); }
    .rp-reg { display: grid; gap: 6px; margin-top: 10px; max-height: 520px; overflow-y: auto; padding-right: 4px; overscroll-behavior: contain; }
    .rp-item { padding: 8px 10px; border: 1px solid var(--line, var(--border)); border-radius: 10px; font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
    .rp-item .rp-tag { display: inline-block; padding: 1px 8px; border-radius: 99px; font-size: 11px; font-weight: 700; margin-right: 6px; }
    .rp-tag.postada { background: color-mix(in srgb, var(--brand, var(--green)) 18%, transparent); color: var(--brand, var(--green)); }
    .rp-tag.ignorada { background: var(--surface-3); color: var(--ink-2, var(--muted)); }
    .rp-tag.erro { background: color-mix(in srgb, var(--red, #c2341f) 15%, transparent); color: var(--red, #c2341f); }
    .rp-item small { color: var(--ink-3, var(--muted)); }
    .rp-acoes { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .rp-acoes .btn { min-height: 36px; }
  </style>`);

  caixa.innerHTML = `
    <div class="rp-topo">
      <h2 style="margin:0">Repostar ofertas de outros grupos</h2>
      <label class="rp-chave"><input type="checkbox" id="rp-ativo"> <span id="rp-ativo-txt">Desligado</span></label>
    </div>
    <p class="hint cli-hint">O número das postagens entra em grupos de ofertas de outras pessoas (os <b>grupos de origem</b>). Quando chega uma oferta com link de loja, o site acha o produto, confere o preço na loja quando dá, <b>troca o link pelo seu link de afiliado</b> e posta nos seus <b>grupos de destino</b> com o seu modelo de mensagem. O texto e o cupom de quem postou não são copiados.</p>
    <p class="rp-alerta">⚠️ Use um número só para isso. Ficar em muitos grupos e repostar rápido aumenta o risco de o WhatsApp banir o número. Deixe pelo menos 3 minutos entre as repostagens e poucos grupos de origem.</p>

    <div class="rp-secao">
      <h3>Grupos</h3>
      <div class="rp-barra">
        <button class="btn" type="button" id="rp-carregar">Carregar grupos do número</button>
        <input type="text" id="rp-busca" placeholder="Buscar grupo" aria-label="Buscar grupo">
      </div>
      <p class="rp-contagem" id="rp-contagem"></p>
      <p class="hint cli-hint" style="margin:0">Marque como <b>Origem</b> os grupos de onde o site pega as ofertas.</p>
      <div class="rp-lista" id="rp-lista"></div>
    </div>

    <div class="rp-secao">
      <h3>Para onde vai</h3>
      <p class="hint cli-hint" style="margin:0 0 8px">Estes são os seus <b>Grupos de destino</b>. Em cada um, marque de quais grupos de origem ele recebe as ofertas.</p>
      <div class="rp-lista" id="rp-destinos" style="max-height:none"></div>
    </div>

    <div class="rp-secao">
      <h3>Regras</h3>
      <div class="rp-campos">
        <label class="field">Desconto mínimo (%) <input type="number" id="rp-desconto" min="1" max="90" inputmode="numeric"></label>
        <label class="field">Máximo por hora <input type="number" id="rp-hora" min="1" max="30" inputmode="numeric"></label>
        <label class="field">Intervalo mínimo (min) <input type="number" id="rp-intervalo" min="1" max="120" inputmode="numeric"></label>
      </div>
      <label class="rp-chave" style="font-weight:500;margin-top:12px"><input type="checkbox" id="rp-tipo"> Cada grupo de destino recebe só o tipo e a loja marcados nele</label>
      <p class="hint cli-hint" style="margin-top:10px">Lojas (nenhuma marcada = todas em que você tem link de afiliado):</p>
      <div class="rp-lojas" id="rp-lojas"></div>
      <p class="hint cli-hint">Repostagem a qualquer hora, sem as palavras proibidas e as do agendamento. Quando a mensagem não traz o preço, o site busca na página da oferta. Vale a regra de não repetir o mesmo produto em 7 dias.</p>
    </div>

    <div class="actions cli-actions" style="justify-content:flex-start;margin-top:14px">
      <button class="btn primary btn-primary" type="button" id="rp-salvar">Salvar</button>
    </div>
    <p class="hint cli-hint" id="rp-msg" role="status"></p>

    <div class="rp-secao">
      <div class="rp-topo"><h3 style="margin:0">Últimas 24 horas</h3><span class="rp-barra"><button class="btn small" type="button" id="rp-atualizar">Atualizar</button><button class="btn small" type="button" id="rp-apagar-tudo">Apagar todas</button></span></div>
      <div class="rp-resumo" id="rp-resumo" style="margin-top:8px"></div>
      <p class="hint cli-hint" id="rp-recebidas" style="margin:10px 0 0"></p>
      <p class="hint cli-hint" id="rp-leitor" style="margin:6px 0 0"></p>
      <div class="rp-reg" id="rp-registro"></div>
    </div>`;
  const $ = id => document.getElementById(id);

  function papelDe(id) { return escolha.get(id) || ''; }
  const origensEscolhidas = () => [...escolha.keys()];
  const origensDe = id => [...(recebe.get(id) || [])].filter(o => escolha.has(o));
  function contar() {
    const o = escolha.size, d = (dados?.grupos_destino || []).filter(g => origensDe(g.id).length).length;
    $('rp-contagem').textContent = `${o} grupo(s) de origem · ${d} grupo(s) de destino${grupos ? ` · ${grupos.length} grupo(s) no número` : ''}`;
  }
  function desenharDestinos() {
    const lista = dados?.grupos_destino || [];
    const origens = origensEscolhidas();
    $('rp-destinos').innerHTML = !lista.length
      ? '<p class="hint cli-hint">Nenhum grupo de destino salvo. Marque os grupos em <b>Grupos de destino</b>, salve e volte aqui.</p>'
      : lista.map(g => {
        const marcadas = origensDe(g.id);
        return `<div class="rp-dest" data-ok="${marcadas.length ? 1 : 0}"><b>${esc(g.nome)}</b>
          <small>${!origens.length ? 'Escolha um grupo de origem acima.' : marcadas.length ? `Recebe de ${marcadas.length} grupo(s) de origem` : 'Não recebe repostagens'}</small>
          ${origens.length ? `<div class="rp-chips">${origens.length > 1 ? `<label class="rp-todas"><input type="checkbox" data-rp-todas="${esc(g.id)}" ${marcadas.length === origens.length ? 'checked' : ''}> Todas</label>` : ''}${origens.map(o => `<label><input type="checkbox" data-rp-dest="${esc(g.id)}" value="${esc(o)}" ${marcadas.includes(o) ? 'checked' : ''}> ${esc(nomes.get(o) || o)}</label>`).join('')}</div>` : ''}
        </div>`;
      }).join('');
    contar();
  }
  $('rp-destinos').addEventListener('change', e => {
    const id = e.target.dataset.rpDest || e.target.dataset.rpTodas;
    if (!id) return;
    if (!recebe.has(id)) recebe.set(id, new Set());
    const s = recebe.get(id);
    if (e.target.dataset.rpTodas) { s.clear(); if (e.target.checked) origensEscolhidas().forEach(o => s.add(o)); }
    else if (e.target.checked) s.add(e.target.value); else s.delete(e.target.value);
    desenharDestinos();
  });
  function desenharGrupos() {
    const busca = $('rp-busca').value.trim().toLowerCase();
    // Sem carregar: mostra só os já escolhidos
    const lista = grupos || [...escolha.keys()].map(id => ({ id, nome: nomes.get(id) || id, salvo: true }));
    const visiveis = lista.filter(g => !busca || g.nome.toLowerCase().includes(busca))
      .sort((a, b) => (papelDe(b.id) ? 1 : 0) - (papelDe(a.id) ? 1 : 0) || a.nome.localeCompare(b.nome, 'pt-BR'));
    $('rp-lista').innerHTML = visiveis.length ? visiveis.map(g => `<div class="rp-grupo" data-papel="${papelDe(g.id)}">
        <span class="rp-gnome">${esc(g.nome)}<small>${g.meu ? 'Número é administrador' : 'Grupo de outra pessoa'}${Number.isInteger(g.membros) ? ` · ${g.membros} membros` : ''}</small></span>
        <select data-rp-grupo="${esc(g.id)}" aria-label="Uso do grupo ${esc(g.nome)}">
          <option value="">Não usar</option>
          <option value="origem" ${papelDe(g.id) === 'origem' ? 'selected' : ''}>Origem</option>
        </select></div>`).join('')
      : `<p class="hint cli-hint">${grupos ? 'Nenhum grupo com esse nome.' : 'Clique em <b>Carregar grupos do número</b> para escolher.'}</p>`;
    contar();
  }
  $('rp-lista').addEventListener('change', e => {
    const id = e.target.dataset.rpGrupo;
    if (!id) return;
    if (e.target.value) escolha.set(id, e.target.value); else escolha.delete(id);
    e.target.closest('.rp-grupo').dataset.papel = e.target.value;
    desenharDestinos();
  });
  $('rp-busca').addEventListener('input', desenharGrupos);
  $('rp-carregar').addEventListener('click', async () => {
    $('rp-msg').textContent = 'Carregando os grupos do número…';
    try {
      grupos = (await pedir('/grupos')).grupos;
      for (const g of grupos) nomes.set(g.id, g.nome);
      // Os Grupos de destino podem ter mudado depois que a tela abriu
      try { const d = await pedir(); if (dados) dados.grupos_destino = d.grupos_destino; } catch { /* fica a lista de antes */ }
      $('rp-msg').textContent = `${grupos.length} grupo(s). Escolha as origens, marque de quais origens cada grupo de destino recebe e clique em Salvar.`;
      desenharGrupos();
      desenharDestinos();
    } catch (err) { $('rp-msg').textContent = err.message; }
  });

  function quando(sql) {
    const d = new Date(`${String(sql).replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function desenharRegistro() {
    const r = dados.resumo;
    const rec = dados.recebidas || [];
    const lm = dados.leitor_ml;
    $('rp-leitor').innerHTML = lm ? (lm.ativa
      ? '✅ <b>Leitor do Mercado Livre ligado</b>: a extensão do Chrome lê os anúncios do Mercado Livre que o site não consegue ler.'
      : '⚠️ <b>Leitor do Mercado Livre desligado</b>: deixe o Chrome aberto com a extensão Ofertou! (versão 2.16 ou mais nova) e abra o Painel uma vez. Sem ela, anúncios do Mercado Livre só entram quando a mensagem traz os preços.') : '';
    $('rp-recebidas').innerHTML = rec.length ? `<b>Mensagens recebidas dos grupos de origem</b> (desde a última vez que o site ligou): ${rec.map(g => `${esc(g.nome)}: ${g.total}${g.ilegiveis ? ` (+${g.ilegiveis} sem conteúdo)` : ''}${g.ultima ? `, a última às ${new Date(g.ultima).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''}`).join(' · ')}` : '';
    $('rp-resumo').innerHTML = [
      [r.postadas, 'postadas'], [r.ignoradas, 'não postadas'], [r.erros, 'falharam'], [`${r.ultima_hora}/${dados.ajustes.por_hora}`, 'na última hora'],
    ].map(([n, t]) => `<div class="rp-num"><b>${esc(n)}</b><span>${t}</span></div>`).join('');
    $('rp-registro').innerHTML = dados.registro.length ? dados.registro.map(x => `<div class="rp-item">
        <span class="rp-tag ${esc(x.situacao)}">${SITUACAO[x.situacao] || esc(x.situacao)}</span><small>${quando(x.created_at)}${x.origem ? ` · de ${esc(x.origem)}` : ''}${x.store_id ? ` · ${esc(LOJAS[x.store_id] || x.store_id)}` : ''}</small>
        ${x.produto ? `<div><b>${esc(x.produto)}</b></div>` : ''}${x.motivo ? `<div><small>${esc(x.motivo)}</small></div>` : ''}${x.link && /^https?:\/\//.test(x.link) ? `<div><small><a href="${esc(x.link)}" target="_blank" rel="noopener noreferrer">${esc(x.link.length > 70 ? `${x.link.slice(0, 70)}…` : x.link)}</a></small></div>` : ''}
        <div class="rp-acoes">${x.situacao !== 'postada' && (x.offer_id || x.link) ? `<button class="btn small btn-primary primary" type="button" data-rp-enviar="${x.id}">Enviar no grupo</button>` : ''}<button class="btn small" type="button" data-rp-apagar="${x.id}">Apagar</button></div></div>`).join('')
      : '<p class="hint cli-hint">Nenhuma oferta vista ainda. Quando chegar oferta nos grupos de origem, ela aparece aqui.</p>';
  }
  function preencher() {
    const a = dados.ajustes;
    $('rp-ativo').checked = a.ativo;
    $('rp-ativo-txt').textContent = a.ativo ? 'Ligado' : 'Desligado';
    $('rp-desconto').value = a.desconto_min;
    $('rp-hora').value = a.por_hora;
    $('rp-intervalo').value = a.intervalo_min;
    $('rp-tipo').checked = a.por_tipo;
    const sem = new Set((dados.sem_afiliado || []).map(n => NOME_SEM_AFILIADO[n]).filter(Boolean));
    $('rp-lojas').innerHTML = dados.lojas.map(id => `<label><input type="checkbox" value="${id}" ${a.lojas.includes(id) ? 'checked' : ''}> ${LOJAS[id]}${sem.has(id) ? ' <em>(sem link de afiliado)</em>' : ''}</label>`).join('');
    escolha.clear();
    for (const g of a.origens) { escolha.set(g.id, 'origem'); nomes.set(g.id, g.nome); }
    recebe.clear();
    // Ajuste antigo sem origens marcadas: o destino recebia de todas
    for (const g of a.destinos) recebe.set(g.id, new Set(g.origens || a.origens.map(o => o.id)));
    desenharGrupos();
    desenharDestinos();
    desenharRegistro();
  }
  async function carregar() {
    try { dados = await pedir(); preencher(); } catch (err) { $('rp-msg').textContent = err.message; }
  }
  async function atualizarRegistro() {
    try { const d = await pedir(); dados.registro = d.registro; dados.resumo = d.resumo; dados.recebidas = d.recebidas; dados.leitor_ml = d.leitor_ml; desenharRegistro(); } catch { /* tenta de novo depois */ }
  }
  $('rp-atualizar').addEventListener('click', atualizarRegistro);
  const confirmar = async texto => (window.OfertouUI?.confirmar ? window.OfertouUI.confirmar(texto, { titulo: 'Apagar', ok: 'Apagar', perigo: true }) : true);
  const aviso = texto => { $('rp-msg').textContent = texto; $('rp-msg').scrollIntoView({ block: 'nearest' }); };
  $('rp-apagar-tudo').addEventListener('click', async () => {
    if (!dados?.registro?.length || !(await confirmar('Apagar todas as ofertas do registro? Isso não apaga nada dos grupos.'))) return;
    try { await pedir('/registro', { method: 'DELETE' }); await atualizarRegistro(); aviso('Registro apagado.'); } catch (err) { aviso(err.message); }
  });
  // Botões de cada oferta: enviar agora no grupo (do jeito de sempre) ou apagar do registro
  $('rp-registro').addEventListener('click', async e => {
    const env = e.target.closest('[data-rp-enviar]'), apg = e.target.closest('[data-rp-apagar]');
    if (!env && !apg) return;
    const b = env || apg;
    const id = b.dataset.rpEnviar || b.dataset.rpApagar;
    const antes = b.textContent;
    b.disabled = true;
    b.textContent = env ? 'Enviando…' : 'Apagando…';
    try {
      if (env) { const r = await pedir(`/registro/${id}/enviar`, { method: 'POST', body: {} }); aviso(r.mensagem || 'Enviada.'); }
      else await pedir(`/registro/${id}`, { method: 'DELETE' });
      await atualizarRegistro();
    } catch (err) {
      b.disabled = false;
      b.textContent = antes;
      aviso(err.message);
    }
  });
  $('rp-ativo').addEventListener('change', () => { $('rp-ativo-txt').textContent = $('rp-ativo').checked ? 'Ligado (salve para valer)' : 'Desligado (salve para valer)'; });
  $('rp-salvar').addEventListener('click', async () => {
    const ids = papel => [...escolha.entries()].filter(([, v]) => v === papel).map(([id]) => id);
    const corpo = {
      ativo: $('rp-ativo').checked, origens: ids('origem'), por_tipo: $('rp-tipo').checked,
      destinos: (dados?.grupos_destino || []).map(g => ({ id: g.id, origens: origensDe(g.id) })).filter(g => g.origens.length),
      desconto_min: $('rp-desconto').value, por_hora: $('rp-hora').value, intervalo_min: $('rp-intervalo').value,
      lojas: [...$('rp-lojas').querySelectorAll('input:checked')].map(i => i.value),
    };
    $('rp-msg').textContent = 'Salvando…';
    try {
      dados = await pedir('', { method: 'POST', body: corpo });
      preencher();
      $('rp-msg').textContent = dados.ajustes.ativo ? 'Salvo. As ofertas novas dos grupos de origem serão repostadas.' : 'Salvo. A repostagem está desligada.';
    } catch (err) { $('rp-msg').textContent = err.message; }
  });

  carregar();
  // Enquanto a tela está aberta, atualiza o registro a cada minuto
  setInterval(() => { if (dados && caixa.offsetParent !== null && !document.hidden) atualizarRegistro(); }, 60000);
})();
