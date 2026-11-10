/* Ofertou! — assinatura de planos: dados do cadastro, pagamento (Pix, cartão — inclusive cartão salvo —, transferência ou link) e confirmação */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const brl = v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtDia = s => (s ? new Date(String(s).replace(' ', 'T') + 'Z').toLocaleDateString('pt-BR') : '');
  const params = new URLSearchParams(location.search);
  let PLANO = null;
  let LOGADO = null; // conta do site já logada (ex.: voltou do Google)
  let pollTimer = null;
  let OFERTA = null; // período grátis e troca de plano desta compra
  let DADOS = null;
  const NOME_CICLO = { mensal: 'mês', trimestral: 'trimestre', anual: 'ano' };
  const ROTULO_CICLO = { mensal: '/mês', trimestral: '/trimestre', anual: '/ano' };
  const PROXIMO = 'ofertou-proximo-plano';
  const cicloAtual = () => (PLANO.ciclos || []).find(c => c.id === $('#ass-ciclos [name=ciclo]:checked')?.value) || (PLANO.ciclos || [])[0] || null;
  const emTeste = () => $('#ass-modos [name=modo]:checked')?.value === 'teste';
  const comAuto = () => !emTeste() && $('#ass-auto').checked && !$('#ass-auto-op').hidden;
  const valorAtual = () => { const c = cicloAtual(); return !c ? PLANO.preco : comAuto() ? c.preco_auto : c.preco; };
  const lerProximo = () => { try { const x = JSON.parse(localStorage.getItem(PROXIMO) || 'null'); return x && Date.now() - x.em < 6 * 3600000 ? x : null; } catch { return null; } };
  const gravarProximo = v => { try { if (v) localStorage.setItem(PROXIMO, JSON.stringify({ plano: v, em: Date.now() })); else localStorage.removeItem(PROXIMO); } catch { /* sem armazenamento */ } };

  let toastTimer;
  function toast(t) {
    const el = $('#toast'); el.textContent = t; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }
  const show = v => ['form', 'status', 'erro'].forEach(x => { $(`#view-${x}`).hidden = x !== v; });

  // ── Formulário ─────────────────────────────────────────────────────────────
  // Tipo da conta do site que a compra vai usar (planos com consumidor e empresa: a pessoa escolhe)
  const perfilAtual = () => {
    if (LOGADO && PLANO.perfis.includes(LOGADO.tipo)) return LOGADO.tipo;
    return $('#ass-perfis [name=perfil_conta]:checked')?.value || PLANO.perfil;
  };
  function aplicarPlano() {
    const conta = PLANO.conta === 'usuario';
    const empresa = perfilAtual() === 'empresa';
    const renovar = !LOGADO && $('#renovar').checked;
    // Logado: e-mail e senha já são os da conta; os dados pessoais só são pedidos se o perfil ainda não foi preenchido.
    const temDados = Boolean(LOGADO?.tipo);
    const virandoLoja = empresa && LOGADO?.tipo && LOGADO.tipo !== 'empresa'; // já tem conta e passa a ter loja: faltam os dados da empresa
    $('#ass-acesso').hidden = Boolean(LOGADO);
    $('.ass-renovar').hidden = Boolean(LOGADO);
    // Cada bloco aparece se valer para o plano (conta do site / empresa) e não for só renovação.
    $$('.so-novo, .so-conta, .so-empresa').forEach(el => {
      const c = el.classList;
      const pulaNovo = renovar || (temDados && !(virandoLoja && (c.contains('so-empresa') || c.contains('so-conta'))));
      el.hidden = (c.contains('so-novo') && pulaNovo) || (c.contains('so-conta') && !conta) || (c.contains('so-empresa') && !empresa);
    });
    $('#ass-perfil').hidden = !(PLANO.perfis.length > 1 && !(LOGADO && PLANO.perfis.includes(LOGADO.tipo)) && !renovar);
    $('#ass-pagamento').hidden = PLANO.gratis || emTeste() || comAuto();
    $('#ass-risco').hidden = !PLANO.ferramenta;
    $('#ass-ciclo-bloco').hidden = PLANO.gratis || emTeste() || !(PLANO.ciclos || []).length;
    // Termos do Parceiro: plano de empresa (lojista) e/ou com a ferramenta (afiliado)
    $$('[data-aceite-papel]').forEach(l => {
      const vale = { lojista: empresa, afiliado: Boolean(PLANO.ferramenta) }[l.dataset.aceitePapel];
      l.hidden = !vale; l.querySelector('input').disabled = !vale;
    });
    $('#ass-enviar').textContent = textoBotao();
    $('#ass-google').hidden = Boolean(LOGADO) || renovar;
    $('#ass-google-div').hidden = $('#ass-google').hidden;
    $('#ass-form [name=senha]').autocomplete = renovar ? 'current-password' : 'new-password';
  }

  const textoBotao = () => (PLANO.gratis ? 'Ativar plano grátis' : emTeste() ? 'Começar grátis' : comAuto() ? 'Autorizar no Mercado Pago' : 'Finalizar compra');
  function resumo() {
    const c = cicloAtual();
    const dias = c ? c.dias : PLANO.dias;
    const periodo = !dias ? ' · sem vencimento' : c ? ROTULO_CICLO[c.id] : dias === 30 ? '/mês' : `/${dias} dias`;
    const prazo = dias ? `por ${dias} dias` : 'sem data de vencimento';
    const teste = emTeste();
    const auto = comAuto();
    const bonus = OFERTA?.troca?.dias_bonus || 0;
    const nota = PLANO.gratis ? `Acesso ${prazo}, liberado na hora, sem pagamento.`
      : teste ? `${OFERTA.cortesia.dias} dias grátis, sem cartão. Nada é cobrado depois: para continuar, é só assinar.`
      : auto ? `Cobrança de ${brl(valorAtual())} agora e a cada ${NOME_CICLO[c.id]} no cartão, com ${PLANO.desconto_auto}% de desconto. Desligue quando quiser em Minha conta → Meus planos.`
      : `Acesso ${prazo}${bonus ? ` mais ${bonus} dias da troca` : ''}, liberado assim que o pagamento é confirmado. Você recebe um e-mail com a validade.`;
    $('#resumo').innerHTML = `
      <p class="plano-chamada">${esc(PLANO.chamada)}</p>
      <h2>${esc(PLANO.nome)}</h2>
      <p class="plano-preco"><b>${PLANO.gratis || teste ? 'Grátis' : brl(valorAtual())}</b><span>${teste ? ` por ${OFERTA.cortesia.dias} dias` : periodo}</span></p>
      ${!teste && c && c.meses > 1 ? `<small class="plano-equiv">equivale a ${brl(valorAtual() / c.meses)}/mês</small>` : ''}
      <ul class="ass-beneficios">${PLANO.beneficios.map(b => `<li>${esc(b)}</li>`).join('')}</ul>
      <p class="cli-hint">${esc(nota)}</p>
      <a class="link-btn" href="/conta#planos">Trocar de plano</a>`;
  }

  let GOOGLE = false;
  async function iniciarForm(id) {
    const de = params.get('trocar') || '';
    const [d, me, info, oferta] = await Promise.all([
      fetch(`/api/planos?plano=${encodeURIComponent(id)}`).then(r => r.json()),
      fetch('/api/conta/me', { cache: 'no-store' }).then(r => r.json()).catch(() => ({})),
      fetch('/api/conta/cadastro-info').then(r => r.json()).catch(() => ({})),
      fetch(`/api/planos/oferta?${new URLSearchParams({ plano: id, ciclo: params.get('ciclo') || '', trocar: de })}`, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    OFERTA = oferta;
    DADOS = d;
    LOGADO = me.user || null;
    GOOGLE = Boolean(info.google);
    $('#ass-google-btn').href = `/auth/google?voltar=${encodeURIComponent(`/assinar?plano=${id}`)}`;
    if (LOGADO) {
      $('#ass-logado').innerHTML = `${LOGADO.avatar_url ? `<img src="${esc(LOGADO.avatar_url)}" alt="" referrerpolicy="no-referrer">` : ''}
        <span>Comprando com a conta <b>${esc(LOGADO.email)}</b>${LOGADO.google ? ' (Google)' : ''}. <button class="link-btn" type="button" id="ass-sair">Usar outra conta</button></span>`;
      $('#ass-logado').hidden = false;
      $('#ass-sair').addEventListener('click', async () => {
        await fetch('/api/conta/sair', { method: 'POST' });
        location.reload();
      });
      const nome = $('#ass-form [name=nome]');
      if (LOGADO.nome && !nome.value) nome.value = LOGADO.nome;
    }
    if (params.get('erro')) { $('#ass-msg').textContent = params.get('erro'); $('#ass-msg').hidden = false; }
    if (params.get('renovar') === '1' && !LOGADO) $('#renovar').checked = true;
    if (params.get('vencido') === '1') {
      $('#ass-vencido').hidden = false;
      $('#ass-vencido').textContent = 'Seu plano venceu. Reative abaixo para voltar a usar o Ofertou! — os novos dias começam a contar assim que o pagamento for confirmado.';
    }
    PLANO = d.planos.find(p => p.id === id);
    if (!PLANO) return show('erro');
    document.title = `Assinar ${PLANO.nome} — Ofertou!`;
    const ufs = d.ufs.map(u => `<option>${u}</option>`).join('');
    $('#uf').insertAdjacentHTML('beforeend', ufs);
    $('#emp_uf').insertAdjacentHTML('beforeend', ufs);
    $('#ramo').insertAdjacentHTML('beforeend', d.ramos.map(r => `<option>${esc(r)}</option>`).join(''));
    const opcoes = d.metodos?.lista || [];
    $('#metodos').innerHTML = opcoes.length ? opcoes.map((m, i) => `
      <label class="ass-metodo"><input type="radio" name="metodo" value="${esc(m.id)}" ${i === 0 ? 'checked' : ''}>
        <span><b>${esc(m.nome)}</b><small>${esc(m.desc)}</small></span>${m.automatico ? '<em class="ass-auto">liberação automática</em>' : ''}</label>`).join('')
      : `<p class="form-msg err">Os pagamentos online ainda não foram configurados.${d.whatsapp ? ` <a class="link-btn" target="_blank" rel="noopener" href="https://wa.me/${esc(d.whatsapp)}?text=${encodeURIComponent(`Olá! Quero assinar o plano ${PLANO.nome}.`)}">Fale com a gente no WhatsApp</a>.` : ' Tente mais tarde.'}</p>`;
    $('#ass-enviar').disabled = !opcoes.length && !PLANO.gratis;
    $('#metodos').addEventListener('change', atualizarCartao);
    const NOME_PERFIL = { consumidor: ['Consumidor', 'Para comprar com desconto'], empresa: ['Empresa', 'Para divulgar a sua loja e os seus produtos'] };
    $('#ass-perfis').innerHTML = PLANO.perfis.map((t, i) => `
      <label class="ass-metodo"><input type="radio" name="perfil_conta" value="${t}" ${i === 0 ? 'checked' : ''}>
        <span><b>${NOME_PERFIL[t][0]}</b><small>${NOME_PERFIL[t][1]}</small></span></label>`).join('');
    $('#ass-perfis').addEventListener('change', aplicarPlano);
    montarOferta(d);
    resumo();
    aplicarPlano();
    show('form');
    atualizarCartao();
  }

  // Grátis ou pago, período, renovação automática e mais um plano
  function montarOferta(d) {
    const ciclos = PLANO.ciclos || [];
    const troca = OFERTA?.troca;
    if (troca) {
      const box = $('#ass-troca');
      box.hidden = false;
      box.innerHTML = troca.plano === PLANO.id
        ? `Mudando o período do <b>${esc(troca.nome)}</b>.${troca.dias_bonus ? ` O que falta usar vira <b>${troca.dias_bonus} dias a mais</b>.` : ''}`
        : `Trocando <b>${esc(troca.nome)}</b> por <b>${esc(PLANO.nome)}</b>. Quando o pagamento for confirmado, o plano antigo termina${troca.dias_bonus ? ` e o que falta usar vira <b>${troca.dias_bonus} dias a mais</b> no novo` : ''}.`;
    }
    if (PLANO.gratis || !ciclos.length) return;
    $('#ass-oferta').hidden = false;
    const gratis = !troca && !OFERTA?.ativo ? OFERTA?.cortesia : null;
    const textoGratis = gratis?.tipo === 'loja_mes' ? [`Começar com 1 mês grátis`, `Oferta para as 20 primeiras lojas. Restam ${gratis.restantes}. Sem cartão.`] : gratis ? [`Testar ${gratis.dias} dias grátis`, 'Sem cartão e sem cobrança no fim do período.'] : null;
    $('#ass-modos').innerHTML = gratis ? `
      <label class="ass-metodo"><input type="radio" name="modo" value="teste" checked><span><b>${textoGratis[0]}</b><small>${esc(textoGratis[1])}</small></span></label>
      <label class="ass-metodo"><input type="radio" name="modo" value="assinar"><span><b>Assinar agora</b><small>Escolha o período e a forma de pagamento.</small></span></label>` : '';
    $('#ass-modos').hidden = !gratis;
    $('#ass-oferta legend').textContent = gratis ? 'Como você quer começar?' : 'Escolha o período';
    const pedido = params.get('ciclo');
    const inicial = ciclos.some(c => c.id === pedido) ? pedido : ciclos[0].id;
    $('#ass-ciclos').innerHTML = ciclos.map(c => `
      <label class="ass-metodo"><input type="radio" name="ciclo" value="${c.id}" ${c.id === inicial ? 'checked' : ''}>
        <span><b>${esc(c.nome)}: ${brl(c.preco)}</b><small>${c.meses > 1 ? `equivale a ${brl(c.por_mes)}/mês` : 'Paga mês a mês'}</small></span>${c.economia ? `<em class="ass-auto">${c.economia}% a menos</em>` : ''}</label>`).join('');
    const podeAuto = d.metodos?.renovacao_auto && PLANO.desconto_auto > 0;
    $('#ass-auto-op').hidden = !podeAuto;
    if (params.get('auto') === '1' && podeAuto) $('#ass-auto').checked = true;
    const proximo = params.get('proximo');
    const outros = !troca && !params.get('adicional') ? d.planos.filter(p => !p.gratis && p.id !== PLANO.id) : [];
    if (outros.length) {
      $('#ass-mais').hidden = false;
      $('#ass-mais-lista').innerHTML = outros.map(p => `<label class="ass-metodo"><input type="checkbox" name="plano_mais" value="${esc(p.id)}" ${proximo === p.id ? 'checked' : ''}><span><b>Adicionar ${esc(p.nome)}</b><small>${esc(p.chamada || '')}</small></span></label>`).join('');
    }
    $('#ass-oferta').addEventListener('change', e => {
      // Sem conta ainda: a conta do site vem primeiro, para a ferramenta ficar ligada a ela
      if (e.target.name === 'plano_mais' && e.target.checked) {
        $$('#ass-mais-lista input').forEach(i => { if (i !== e.target) i.checked = false; });
        const outro = d.planos.find(p => p.id === e.target.value);
        if (!LOGADO && PLANO.conta === 'cliente' && outro?.conta === 'usuario') { location.href = `/assinar?${new URLSearchParams({ plano: outro.id, proximo: PLANO.id })}`; return; }
      }
      atualizarTextoAuto();
      resumo();
      aplicarPlano();
      atualizarCartao();
    });
    atualizarTextoAuto();
  }
  function atualizarTextoAuto() {
    const c = cicloAtual();
    if (!c) return;
    $('#ass-auto-tit').textContent = `Renovar automaticamente por ${brl(c.preco_auto)} (${PLANO.desconto_auto}% de desconto)`;
    $('#ass-auto-txt').textContent = `Cobrado no cartão a cada ${NOME_CICLO[c.id]}, pelo Mercado Pago. Desligue quando quiser em Minha conta → Meus planos.`;
  }

  // Cartão com conta logada: usa os cartões salvos (Minha conta → Meus cartões) e paga aqui mesmo, digitando só o
  // código de segurança. "Pagar com um cartão sem salvar" volta para o checkout do Mercado Pago.
  let semSalvo = false, cartaoAtivo = null, carregandoCartao = false, seqCartao = 0, cartaoRenovacao = false;
  async function atualizarCartao() {
    const area = $('#ass-cartao');
    const renovacao = comAuto();
    const usar = Boolean(LOGADO && !PLANO.gratis && !emTeste() && !semSalvo && window.OfertouCartoes && (renovacao || $('#metodos [name=metodo]:checked')?.value === 'mercadopago'));
    // Ligou ou desligou a renovação: a escolha do cartão muda (com ou sem parcelas)
    if (usar && cartaoAtivo && cartaoRenovacao !== renovacao) { seqCartao++; carregandoCartao = false; cartaoAtivo.desmontar?.(); cartaoAtivo = null; }
    cartaoRenovacao = renovacao;
    if (!usar) {
      seqCartao++; carregandoCartao = false;
      cartaoAtivo?.desmontar?.(); cartaoAtivo = null;
      area.hidden = true; area.innerHTML = '';
      $('#ass-enviar').hidden = false;
      return;
    }
    if (cartaoAtivo || carregandoCartao) return;
    const n = ++seqCartao;
    carregandoCartao = true;
    area.hidden = false;
    area.innerHTML = '<p class="cli-hint">Carregando seus cartões…</p>';
    $('#ass-enviar').hidden = true;
    const escolha = await OfertouCartoes.escolherNoPedido(area, {
      total: () => valorAtual(),
      renovacao,
      aoPagar: async cartao => {
        // Só o que está na tela conta: quem já está logado não vê e-mail e senha, que continuam como obrigatórios no formulário
        const faltando = [...$('#ass-form').elements].find(el => !el.disabled && !el.closest('[hidden]') && !el.checkValidity());
        if (faltando) { faltando.reportValidity(); throw new Error('Preencha os dados e marque os aceites acima antes de pagar.'); }
        await enviar({ ...coletar(), cartao });
      },
      outroCartao: () => { semSalvo = true; cartaoAtivo = null; atualizarCartao(); },
    });
    if (n !== seqCartao) { escolha?.desmontar?.(); return; } // trocou a forma de pagamento enquanto carregava
    carregandoCartao = false;
    cartaoAtivo = escolha;
    if (!cartaoAtivo) { area.hidden = true; area.innerHTML = ''; $('#ass-enviar').hidden = false; } // cartões indisponíveis: segue o checkout normal
  }

  $('#renovar').addEventListener('change', aplicarPlano);
  // O botão do Google fica sempre visível; sem o login do Google configurado no painel, avisa em vez de sair da página.
  $('#ass-google-btn').addEventListener('click', e => {
    if (GOOGLE) return;
    e.preventDefault();
    $('#ass-msg').textContent = 'O cadastro com Google ainda não foi ativado. Por enquanto, preencha com e-mail e senha.';
    $('#ass-msg').hidden = false;
  });
  $('[name=mesmo_endereco]').addEventListener('change', e => { $('#emp-endereco').hidden = e.target.checked; });

  // Máscaras simples e preenchimento do endereço pelo CEP (ViaCEP).
  const mask = (el, fn) => el && el.addEventListener('input', () => { el.value = fn(el.value.replace(/\D/g, '')); });
  mask($('[name=cpf]'), d => d.slice(0, 11).replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2'));
  mask($('[name=cnpj]'), d => d.slice(0, 14).replace(/(\d{2})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1/$2').replace(/(\d{4})(\d{1,2})$/, '$1-$2'));
  const fone = d => (d = d.slice(0, 11), d.length > 10 ? d.replace(/(\d{2})(\d{5})(\d{0,4})/, '($1) $2-$3') : d.length > 2 ? d.replace(/(\d{2})(\d{0,4})(\d{0,4})/, '($1) $2-$3').replace(/-$/, '') : d);
  mask($('[name=telefone]'), fone);
  mask($('[name=telefone_empresa]'), fone);
  // Endereço pelo CEP, dados da empresa pelo CNPJ e pessoa física/jurídica: /js/cadastro-auto.js
  for (const prefix of ['', 'emp_']) mask($(`[name=${prefix}cep]`), d => d.slice(0, 8).replace(/(\d{5})(\d)/, '$1-$2'));

  // Dados do formulário (só os campos visíveis); o cartão salvo fica fora do formulário
  function coletar() {
    const body = { plano: PLANO.id };
    for (const el of $('#ass-form').elements) {
      if (!el.name || el.closest('[hidden]') || el.closest('#ass-cartao')) continue;
      if (el.type === 'checkbox') body[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) body[el.name] = el.value; } else body[el.name] = el.value;
    }
    if (!body.renovar && body.senha !== body.senha_confirmacao) throw new Error('As senhas não conferem.');
    body.teste = body.modo === 'teste';
    delete body.modo;
    delete body.plano_mais;
    if (comAuto()) { body.metodo = 'mercadopago'; body.renovacao_auto = true; } else delete body.renovacao_auto;
    if (OFERTA?.troca) body.trocar_de = OFERTA.troca.plano;
    return body;
  }
  async function enviar(body) {
    const r = await fetch('/api/assinatura', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Erro ${r.status}`);
    gravarProximo($('#ass-mais-lista input:checked')?.value || null);
    history.replaceState(null, '', `/assinar?pedido=${d.token}`);
    if (d.checkout_url) { location.href = d.checkout_url; return; } // Mercado Pago: paga lá e volta para cá
    cartaoAtivo?.desmontar?.(); cartaoAtivo = null;
    acompanhar(d.token);
  }

  $('#ass-form').addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('#ass-msg');
    msg.hidden = true;
    if (cartaoAtivo || carregandoCartao) return; // com cartão salvo, o pagamento é pelo botão "Pagar com este cartão"
    const btn = $('#ass-enviar');
    btn.disabled = true; btn.textContent = 'Finalizando…';
    try {
      await enviar(coletar());
    } catch (err) {
      msg.textContent = err.message; msg.hidden = false;
      msg.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } finally {
      btn.disabled = false; btn.textContent = textoBotao();
    }
  });

  // ── Pagamento e confirmação ───────────────────────────────────────────────
  function renderStatus(p) {
    const box = $('#view-status');
    if (p.status === 'aprovado') {
      clearInterval(pollTimer);
      const proximo = lerProximo();
      const destino = proximo ? `/assinar?${new URLSearchParams({ plano: proximo.plano, adicional: 1 })}` : p.redirect || '/';
      gravarProximo(null);
      box.innerHTML = `
        <div class="ass-ok">✓</div>
        <h1>${p.teste ? 'Período grátis ativado!' : p.gratis ? 'Plano ativado!' : 'Pagamento confirmado!'}</h1>
        <p class="cli-sub">Seu plano <b>${esc(p.plano)}</b> está ativo ${p.sem_vencimento ? '<b>sem data de vencimento</b>' : `até <b>${fmtDia(p.validade_ate)}</b>`}.</p>
        <p class="cli-hint">${p.email_configurado ? `Enviamos a confirmação para <b>${esc(p.email)}</b>.` : `Guarde esta data. Entre com o e-mail <b>${esc(p.email)}</b> e a senha que você cadastrou.`}</p>
        ${p.renovacao_auto ? '<p class="cli-hint">A renovação automática está ligada. Você pode desligar em Minha conta → Meus planos.</p>' : ''}
        <p class="cli-hint">${proximo ? 'Agora vamos para o próximo plano…' : 'Levando você para as ofertas…'}</p>
        <a class="btn btn-primary" href="${esc(destino)}">${proximo ? 'Continuar' : 'Ver ofertas agora'}</a>`;
      setTimeout(() => { location.href = destino; }, 4000);
      return;
    }
    if (p.status !== 'pendente') {
      clearInterval(pollTimer);
      const motivo = { recusado: 'O pagamento foi recusado.', cancelado: 'O pagamento foi cancelado.', expirado: 'O tempo para pagar este Pix acabou.' }[p.status] || 'O pagamento não foi concluído.';
      box.innerHTML = `<h1>${motivo}</h1><p class="cli-sub">Nenhum valor foi cobrado por este pedido. Você pode tentar de novo.</p>
        <a class="btn btn-primary" href="/conta#planos">Tentar de novo</a>`;
      return;
    }
    const valor = `<p class="ass-valor">${esc(p.plano)} · <b>${brl(p.valor)}</b></p>`;
    if (p.pix && p.pix.copia_cola) {
      const expira = p.pix.expira ? new Date(String(p.pix.expira).replace(' ', 'T') + 'Z') : null;
      box.innerHTML = `
        <h1>Pague com Pix</h1>${valor}
        ${p.pix.qr_base64 ? `<img class="ass-qr" src="data:image/png;base64,${esc(p.pix.qr_base64)}" alt="QR code do Pix" width="240" height="240">` : ''}
        <p class="cli-hint">Abra o app do seu banco, escolha Pix → <b>Ler QR code</b> ou <b>Pix copia e cola</b>.</p>
        <div class="ass-copia"><input readonly value="${esc(p.pix.copia_cola)}" aria-label="Código Pix copia e cola"><button class="btn btn-primary" type="button" id="copiar">Copiar código</button></div>
        <p class="ass-aguarde"><span class="live-dot"></span> Aguardando o pagamento… esta página atualiza sozinha.${expira ? ` O código vale até ${expira.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.` : ''}</p>`;
      $('#copiar').addEventListener('click', () => navigator.clipboard.writeText(p.pix.copia_cola).then(() => toast('Código Pix copiado!')));
      return;
    }
    if (p.manual) {
      const m = p.manual;
      const wa = String(m.whatsapp || '').replace(/\D/g, '');
      const comprovante = wa
        ? `pelo <a class="link-btn" target="_blank" rel="noopener" href="https://wa.me/${wa}?text=${encodeURIComponent(`Olá! Paguei o plano ${p.plano} (${p.email}). Segue o comprovante.`)}">WhatsApp</a>`
        : '';
      const linha = (rot, val, copiar) => (val ? `<div class="ass-dado"><span>${rot}</span><b>${esc(val)}</b>${copiar ? `<button class="btn btn-sm" type="button" data-copiar="${esc(val)}">Copiar</button>` : ''}</div>` : '');
      if (m.tipo === 'combinar') {
        box.innerHTML = `
          <div class="ass-ok">✓</div>
          <h1>Pedido recebido!</h1>${valor}
          <p class="cli-sub">Seu cadastro foi registrado. Agora é só combinar o pagamento com a gente.</p>
          <ol class="cli-steps">
            <li>Fale conosco ${comprovante || 'pelo WhatsApp'} informando o e-mail <b>${esc(p.email)}</b>.</li>
            <li>Enviamos as opções para você pagar <b>${brl(p.valor)}</b>.</li>
            <li>Confirmado o pagamento, seu acesso é liberado e você recebe um e-mail com a data de validade — esta página atualiza sozinha.</li>
          </ol>
          ${wa ? `<a class="btn btn-primary btn-lg" target="_blank" rel="noopener" href="https://wa.me/${wa}?text=${encodeURIComponent(`Olá! Fiz o pedido do plano ${p.plano} (${p.email}) e quero combinar o pagamento.`)}">Combinar pagamento no WhatsApp</a>` : ''}
          ${m.recado ? `<p class="cli-hint">${esc(m.recado)}</p>` : ''}
          <p class="ass-aguarde"><span class="live-dot"></span> Aguardando a confirmação do pagamento…</p>`;
        return;
      }
      let titulo, dados, passo1;
      if (m.tipo === 'pix_manual') {
        titulo = 'Pague com Pix';
        dados = `<div class="ass-chave"><span>Chave Pix${m.chave_tipo ? ` (${esc(m.chave_tipo)})` : ''}</span><b>${esc(m.chave)}</b>
          ${m.nome || m.banco ? `<small>${esc([m.nome, m.banco].filter(Boolean).join(' · '))}</small>` : ''}
          <button class="btn btn-sm" type="button" data-copiar="${esc(m.chave)}">Copiar chave</button></div>`;
        passo1 = `Faça um Pix de <b>${brl(p.valor)}</b> para a chave acima.`;
      } else if (m.tipo === 'transferencia') {
        titulo = 'Pague por transferência';
        dados = `<div class="ass-dados">${linha('Banco', m.banco)}${linha('Agência', m.agencia, true)}${linha(`Conta ${esc(m.tipo_conta).toLowerCase()}`, m.conta, true)}${linha('Titular', m.titular)}${linha('CPF/CNPJ', m.documento, true)}</div>`;
        passo1 = `Transfira <b>${brl(p.valor)}</b> para a conta acima.`;
      } else {
        titulo = `Pague com ${esc(m.nome || 'o link de pagamento')}`;
        dados = m.url ? `<a class="btn btn-primary btn-lg" href="${esc(m.url)}" target="_blank" rel="noopener">Abrir página de pagamento ↗</a>` : '';
        passo1 = `Pague <b>${brl(p.valor)}</b> pela página de pagamento (abre em outra aba).`;
      }
      box.innerHTML = `
        <h1>${titulo}</h1>${valor}
        ${dados}
        <ol class="cli-steps">
          <li>${passo1}</li>
          <li>Envie o comprovante ${comprovante} informando o e-mail <b>${esc(p.email)}</b>.</li>
          <li>Assim que confirmarmos, seu acesso é liberado — esta página atualiza sozinha.</li>
        </ol>
        ${m.recado ? `<p class="cli-hint">${esc(m.recado)}</p>` : ''}
        <p class="ass-aguarde"><span class="live-dot"></span> Aguardando a confirmação do pagamento…</p>`;
      box.querySelectorAll('[data-copiar]').forEach(b => b.addEventListener('click', () => navigator.clipboard.writeText(b.dataset.copiar).then(() => toast('Copiado!'))));
      return;
    }
    if (p.renovacao_auto) {
      box.innerHTML = p.cartao_salvo ? `<div class="ass-ok">✓</div><h1>Renovação autorizada</h1>${valor}
        <p class="ass-aguarde"><span class="live-dot"></span> O Mercado Pago faz a primeira cobrança em cerca de 1 hora. Quando ela for aprovada, seu acesso é liberado e você recebe um e-mail${p.email ? ` em <b>${esc(p.email)}</b>` : ''}. Pode fechar esta página.</p>
        ${p.recusado ? '<p class="form-msg err">O Mercado Pago recusou o cartão e vai tentar de novo. Se preferir, use outro cartão em uma nova compra.</p>' : ''}
        <a class="btn" href="/">Ver as ofertas enquanto isso</a>`
        : `<h1>Aguardando o Mercado Pago</h1>${valor}
        <p class="ass-aguarde"><span class="live-dot"></span> Assim que o Mercado Pago aprovar a primeira cobrança, seu acesso é liberado e esta página atualiza sozinha. Pode levar alguns minutos.</p>
        <p class="cli-hint">Fechou a janela sem autorizar? <a class="link-btn" href="/conta#planos">Comece de novo</a>.</p>`;
      return;
    }
    box.innerHTML = `<h1>Aguardando o Mercado Pago</h1>${valor}
      <p class="ass-aguarde"><span class="live-dot"></span> Assim que o Mercado Pago confirmar o pagamento, seu acesso é liberado e esta página atualiza sozinha.</p>
      <p class="cli-hint">Fechou a janela de pagamento sem pagar? <a class="link-btn" href="/conta#planos">Comece de novo</a>.</p>`;
  }

  async function consultar(token) {
    const r = await fetch(`/api/assinatura/${encodeURIComponent(token)}`, { cache: 'no-store' });
    if (r.status === 404) { clearInterval(pollTimer); show('erro'); return; }
    if (!r.ok) return;
    renderStatus(await r.json());
  }

  function acompanhar(token) {
    show('status');
    $('#view-status').innerHTML = '<p class="cli-sub">Carregando o pagamento…</p>';
    consultar(token);
    clearInterval(pollTimer);
    pollTimer = setInterval(() => consultar(token), 5000);
  }

  // ── Início ─────────────────────────────────────────────────────────────────
  // Dentro do app, a assinatura é feita pela Google Play / App Store (regra das lojas).
  if (window.OfertouApp?.nativo && !params.get('pedido')) {
    fetch('/api/planos').then(r => r.json()).then(d => {
      const p = (d.planos || []).find(x => x.id === params.get('plano'));
      if (p && p.gratis) iniciarForm(p.id).catch(() => show('erro'));
      else window.OfertouApp.telaAssinatura(params.get('plano') || '');
    }).catch(() => window.OfertouApp.telaAssinatura(params.get('plano') || ''));
  } else if (params.get('pedido')) acompanhar(params.get('pedido'));
  else if (!params.get('plano')) location.replace('/conta#planos');
  else iniciarForm(params.get('plano')).catch(() => show('erro'));
})();
