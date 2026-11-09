// Painéis do admin e do cliente → Repostar ofertas de outros grupos (src/repostar-grupos.js).
// Escolhe os grupos de origem (de outras pessoas) e os de destino (os seus), os filtros, e mostra o que foi feito com cada oferta.
(function () {
  const caixa = document.getElementById('repostar');
  if (!caixa) return;
  const BASE = caixa.dataset.base;
  const LOJAS = { mercadolivre: 'Mercado Livre', amazon: 'Amazon', shopee: 'Shopee', magalu: 'Magalu', kabum: 'KaBuM!', aliexpress: 'AliExpress' };
  const NOME_SEM_AFILIADO = { 'Mercado Livre': 'mercadolivre', Amazon: 'amazon', Shopee: 'shopee', Magalu: 'magalu', 'KaBuM!': 'kabum', AliExpress: 'aliexpress' };
  const SITUACAO = { postada: 'Postada', ignorada: 'Não postada', erro: 'Falhou' };
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let grupos = null;           // lista carregada do número
  const escolha = new Map();   // id → 'origem' | 'destino'
  const nomes = new Map();
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
    .rp-grupo[data-papel=destino] { border-color: var(--brand, var(--green)); }
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
    .rp-reg { display: grid; gap: 6px; margin-top: 10px; }
    .rp-item { padding: 8px 10px; border: 1px solid var(--line, var(--border)); border-radius: 10px; font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
    .rp-item .rp-tag { display: inline-block; padding: 1px 8px; border-radius: 99px; font-size: 11px; font-weight: 700; margin-right: 6px; }
    .rp-tag.postada { background: color-mix(in srgb, var(--brand, var(--green)) 18%, transparent); color: var(--brand, var(--green)); }
    .rp-tag.ignorada { background: var(--surface-3); color: var(--ink-2, var(--muted)); }
    .rp-tag.erro { background: color-mix(in srgb, var(--red, #c2341f) 15%, transparent); color: var(--red, #c2341f); }
    .rp-item small { color: var(--ink-3, var(--muted)); }
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
      <p class="hint cli-hint" style="margin:0"><b>Origem</b>: o site pega as ofertas desse grupo. <b>Destino</b>: o site posta nesse grupo (só nos grupos em que o número é administrador).</p>
      <div class="rp-lista" id="rp-lista"></div>
    </div>

    <div class="rp-secao">
      <h3>Regras</h3>
      <div class="rp-campos">
        <label class="field">Desconto mínimo (%) <input type="number" id="rp-desconto" min="1" max="90" inputmode="numeric"></label>
        <label class="field">Máximo por hora <input type="number" id="rp-hora" min="1" max="30" inputmode="numeric"></label>
        <label class="field">Intervalo mínimo (min) <input type="number" id="rp-intervalo" min="1" max="120" inputmode="numeric"></label>
        <label class="field">Começa às <input type="text" id="rp-inicio" inputmode="numeric" maxlength="5" placeholder="08:00"></label>
        <label class="field">Para às <input type="text" id="rp-fim" inputmode="numeric" maxlength="5" placeholder="22:00"></label>
      </div>
      <label class="rp-chave" style="font-weight:500;margin-top:12px"><input type="checkbox" id="rp-tipo"> Cada grupo de destino recebe só o tipo e a loja marcados nele</label>
      <p class="hint cli-hint" style="margin-top:10px">Lojas (nenhuma marcada = todas em que você tem link de afiliado):</p>
      <div class="rp-lojas" id="rp-lojas"></div>
      <p class="hint cli-hint">Também valem a lista de palavras proibidas, as palavras bloqueadas do agendamento e a regra de não repetir o mesmo produto em 7 dias.</p>
    </div>

    <div class="actions cli-actions" style="justify-content:flex-start;margin-top:14px">
      <button class="btn primary btn-primary" type="button" id="rp-salvar">Salvar</button>
    </div>
    <p class="hint cli-hint" id="rp-msg" role="status"></p>

    <div class="rp-secao">
      <div class="rp-topo"><h3 style="margin:0">Últimas 24 horas</h3><button class="btn small" type="button" id="rp-atualizar">Atualizar</button></div>
      <div class="rp-resumo" id="rp-resumo" style="margin-top:8px"></div>
      <div class="rp-reg" id="rp-registro"></div>
    </div>`;
  const $ = id => document.getElementById(id);

  function papelDe(id) { return escolha.get(id) || ''; }
  function contar() {
    const o = [...escolha.values()].filter(v => v === 'origem').length, d = [...escolha.values()].filter(v => v === 'destino').length;
    $('rp-contagem').textContent = `${o} grupo(s) de origem · ${d} grupo(s) de destino${grupos ? ` · ${grupos.length} grupo(s) no número` : ''}`;
  }
  function desenharGrupos() {
    const busca = $('rp-busca').value.trim().toLowerCase();
    // Sem carregar: mostra só os já escolhidos
    const lista = grupos || [...escolha.keys()].map(id => ({ id, nome: nomes.get(id) || id, meu: escolha.get(id) === 'destino', salvo: true }));
    const visiveis = lista.filter(g => !busca || g.nome.toLowerCase().includes(busca))
      .sort((a, b) => (papelDe(b.id) ? 1 : 0) - (papelDe(a.id) ? 1 : 0) || a.nome.localeCompare(b.nome, 'pt-BR'));
    $('rp-lista').innerHTML = visiveis.length ? visiveis.map(g => `<div class="rp-grupo" data-papel="${papelDe(g.id)}">
        <span class="rp-gnome">${esc(g.nome)}<small>${g.meu ? 'Número é administrador' : 'Grupo de outra pessoa'}${Number.isInteger(g.membros) ? ` · ${g.membros} membros` : ''}</small></span>
        <select data-rp-grupo="${esc(g.id)}" aria-label="Uso do grupo ${esc(g.nome)}">
          <option value="">Não usar</option>
          <option value="origem" ${papelDe(g.id) === 'origem' ? 'selected' : ''}>Origem</option>
          ${g.meu ? `<option value="destino" ${papelDe(g.id) === 'destino' ? 'selected' : ''}>Destino</option>` : ''}
        </select></div>`).join('')
      : `<p class="hint cli-hint">${grupos ? 'Nenhum grupo com esse nome.' : 'Clique em <b>Carregar grupos do número</b> para escolher.'}</p>`;
    contar();
  }
  $('rp-lista').addEventListener('change', e => {
    const id = e.target.dataset.rpGrupo;
    if (!id) return;
    if (e.target.value) escolha.set(id, e.target.value); else escolha.delete(id);
    e.target.closest('.rp-grupo').dataset.papel = e.target.value;
    contar();
  });
  $('rp-busca').addEventListener('input', desenharGrupos);
  $('rp-carregar').addEventListener('click', async () => {
    $('rp-msg').textContent = 'Carregando os grupos do número…';
    try {
      grupos = (await pedir('/grupos')).grupos;
      for (const g of grupos) nomes.set(g.id, g.nome);
      $('rp-msg').textContent = `${grupos.length} grupo(s). Escolha a origem e o destino e clique em Salvar.`;
      desenharGrupos();
    } catch (err) { $('rp-msg').textContent = err.message; }
  });

  function quando(sql) {
    const d = new Date(`${String(sql).replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function desenharRegistro() {
    const r = dados.resumo;
    $('rp-resumo').innerHTML = [
      [r.postadas, 'postadas'], [r.ignoradas, 'não postadas'], [r.erros, 'falharam'], [`${r.ultima_hora}/${dados.ajustes.por_hora}`, 'na última hora'],
    ].map(([n, t]) => `<div class="rp-num"><b>${esc(n)}</b><span>${t}</span></div>`).join('');
    $('rp-registro').innerHTML = dados.registro.length ? dados.registro.map(x => `<div class="rp-item">
        <span class="rp-tag ${esc(x.situacao)}">${SITUACAO[x.situacao] || esc(x.situacao)}</span><small>${quando(x.created_at)}${x.origem ? ` · de ${esc(x.origem)}` : ''}${x.store_id ? ` · ${esc(LOJAS[x.store_id] || x.store_id)}` : ''}</small>
        ${x.produto ? `<div><b>${esc(x.produto)}</b></div>` : ''}${x.motivo ? `<div><small>${esc(x.motivo)}</small></div>` : ''}</div>`).join('')
      : '<p class="hint cli-hint">Nenhuma oferta vista ainda. Quando chegar oferta nos grupos de origem, ela aparece aqui.</p>';
  }
  function preencher() {
    const a = dados.ajustes;
    $('rp-ativo').checked = a.ativo;
    $('rp-ativo-txt').textContent = a.ativo ? 'Ligado' : 'Desligado';
    $('rp-desconto').value = a.desconto_min;
    $('rp-hora').value = a.por_hora;
    $('rp-intervalo').value = a.intervalo_min;
    $('rp-inicio').value = a.inicio;
    $('rp-fim').value = a.fim;
    $('rp-tipo').checked = a.por_tipo;
    const sem = new Set((dados.sem_afiliado || []).map(n => NOME_SEM_AFILIADO[n]).filter(Boolean));
    $('rp-lojas').innerHTML = dados.lojas.map(id => `<label><input type="checkbox" value="${id}" ${a.lojas.includes(id) ? 'checked' : ''}> ${LOJAS[id]}${sem.has(id) ? ' <em>(sem link de afiliado)</em>' : ''}</label>`).join('');
    escolha.clear();
    for (const g of a.origens) { escolha.set(g.id, 'origem'); nomes.set(g.id, g.nome); }
    for (const g of a.destinos) { escolha.set(g.id, 'destino'); nomes.set(g.id, g.nome); }
    desenharGrupos();
    desenharRegistro();
  }
  async function carregar() {
    try { dados = await pedir(); preencher(); } catch (err) { $('rp-msg').textContent = err.message; }
  }
  async function atualizarRegistro() {
    try { const d = await pedir(); dados.registro = d.registro; dados.resumo = d.resumo; desenharRegistro(); } catch { /* tenta de novo depois */ }
  }
  $('rp-atualizar').addEventListener('click', atualizarRegistro);
  $('rp-ativo').addEventListener('change', () => { $('rp-ativo-txt').textContent = $('rp-ativo').checked ? 'Ligado (salve para valer)' : 'Desligado (salve para valer)'; });
  $('rp-salvar').addEventListener('click', async () => {
    const ids = papel => [...escolha.entries()].filter(([, v]) => v === papel).map(([id]) => id);
    const corpo = {
      ativo: $('rp-ativo').checked, origens: ids('origem'), destinos: ids('destino'), por_tipo: $('rp-tipo').checked,
      desconto_min: $('rp-desconto').value, por_hora: $('rp-hora').value, intervalo_min: $('rp-intervalo').value,
      inicio: $('rp-inicio').value, fim: $('rp-fim').value,
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
