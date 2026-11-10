// Compra de planos: pedido com os dados do cadastro, pagamento por Pix ou Mercado Pago e, aprovado o pagamento,
// criação (ou renovação) da conta, e-mail de confirmação com a data de validade e login automático.
//  • Com o Access Token do Mercado Pago no painel: Pix (QR code) e checkout do Mercado Pago, confirmação automática
//    (consultando a API — o aviso do Mercado Pago só serve de gatilho, nunca é aceito sem conferir).
//  • Pix pela chave, transferência bancária ou link de pagamento (PagBank, InfinitePay…): o admin confere e confirma no painel.
// Cada forma liga/desliga em Painel → Planos → Formas de recebimento.
const crypto = require('crypto');
const axios = require('axios');
const db = require('./db');
const settings = require('./settings');
const auth = require('./auth');
const users = require('./users');
const clientes = require('./clientes');
const cadastro = require('./cadastro');
const planos = require('./planos');
const email = require('./email');
const assinaturas = require('./assinaturas');

const MP_PADRAO = 'https://api.mercadopago.com';
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const sqlDe = d => d.toISOString().replace('T', ' ').slice(0, 19);
const isBlocked = key => Boolean(db.get('SELECT 1 FROM blocked_emails WHERE email = ?', key));
const PIX_MINUTOS = 30;

// Formas que o cliente pode escolher. "pix" é automático (Mercado Pago) quando possível; senão, pela chave do admin.
function metodosDisponiveis(s = settings.getAll(), planoId = null) {
  const mp = Boolean(s.mp_access_token);
  const pixAuto = mp && s.pag_mp_pix !== '0';
  const pixManual = s.pag_pix_ativo !== '0' && Boolean(String(s.pix_chave || '').trim());
  const ted = s.pag_ted_ativo === '1' && Boolean(s.ted_banco && s.ted_conta && s.ted_titular);
  // Link de pagamento: cada plano tem o seu (Painel → Planos → editar plano)
  const comLink = p => Boolean(p && /^https:\/\//i.test(p.link_pagamento || ''));
  const link = s.pag_link_ativo === '1' && (planoId ? comLink(planos.plano(planoId)) : planos.listar().some(comLink));
  const parcelas = Math.min(Math.max(parseInt(s.pag_mp_parcelas, 10) || 1, 1), 12);
  const lista = [];
  if (pixAuto || pixManual) lista.push({ id: 'pix', nome: 'Pix', automatico: pixAuto,
    desc: pixAuto ? 'QR code na hora, liberação automática' : 'Pague pela chave Pix e envie o comprovante' });
  if (mp && s.pag_mp_cartao !== '0') lista.push({ id: 'mercadopago', nome: 'Cartão de crédito ou débito', automatico: true,
    desc: `Pelo Mercado Pago${parcelas > 1 ? `, em até ${parcelas}x` : ''} — liberação automática` });
  if (link) lista.push({ id: 'link', nome: String(s.pag_link_nome || 'Link de pagamento').slice(0, 60), automatico: false,
    desc: 'Pague pelo link seguro e envie o comprovante' });
  if (ted) lista.push({ id: 'transferencia', nome: 'Transferência bancária (TED)', automatico: false,
    desc: 'Transfira para a conta indicada e envie o comprovante' });
  const algum = lista.length > 0;
  // Sem nenhuma forma configurada, a compra ainda é finalizada: o pedido fica registrado e o pagamento é combinado.
  if (!algum) lista.push({ id: 'combinar', nome: 'Combinar o pagamento', automatico: false,
    desc: 'Finalize o pedido e combinamos o pagamento com você pelo WhatsApp' });
  return { lista, pix: pixAuto || pixManual, pix_automatico: pixAuto, mercadopago: lista.some(m => m.id === 'mercadopago'), algum, renovacao_auto: lista.some(m => m.id === 'mercadopago') };
}

// ── Pedido ───────────────────────────────────────────────────────────────────
const NOME_CONTA = { consumidor: 'consumidor', empresa: 'empresa', afiliado: 'usuário da ferramenta' };
// Tipo de conta do site que a compra vai usar: o da conta que já existe ou o escolhido (planos com consumidor e empresa).
function perfilDaConta(p, b, u) {
  if (!p.perfis.length) return null;
  if (u && p.perfis.includes(u.tipo)) return u.tipo;
  if (u && u.tipo === 'consumidor' && p.perfis.includes('empresa')) return 'empresa'; // consumidor virando loja: a conta muda de tipo
  if (u && u.tipo && u.tipo !== 'afiliado') {
    throw fail(`Sua conta é de ${NOME_CONTA[u.tipo]} e este plano é para ${p.perfis.map(t => NOME_CONTA[t]).join(' ou ')}. Para trocar de perfil, fale com o administrador.`, 409);
  }
  const escolhido = String(b.perfil_conta || '');
  const perfil = p.perfis.includes(escolhido) ? escolhido : p.perfis.length === 1 ? p.perfis[0] : null;
  if (!perfil) throw fail('Escolha o tipo da sua conta: consumidor ou empresa.');
  return perfil;
}

// Quem já está logado no site (e-mail/senha ou Google) compra para a própria conta, sem digitar e-mail e senha.
function validarLogado(p, b, u) {
  if (/\.invalid$/i.test(u.email || '')) throw fail('Antes de assinar, informe o seu e-mail em Minha conta → Meus dados: o comprovante e os avisos do plano chegam por ele.', 409);
  if (!['onboarding', 'pending', 'active', 'suspended'].includes(u.status)) throw fail('Esta conta não pode assinar. Fale com o administrador.', 403);
  require('./consentimento').validar(b); // LGPD + Termos de Uso (duas caixas obrigatórias)
  // Conta sem perfil ainda: os dados pessoais (e da empresa) vêm do formulário.
  const novosDados = perfil => {
    const dados = { ...cadastro.dadosPessoa(b), ...(perfil === 'empresa' ? cadastro.dadosEmpresa(b) : {}) };
    if (isBlocked(`cpf:${dados.cpf}`) || (dados.cnpj && isBlocked(`cnpj:${dados.cnpj}`))) throw fail('Não é possível concluir com estes dados. Fale com o administrador.');
    if (db.get('SELECT 1 FROM users WHERE cpf = ? AND id <> ?', dados.cpf, u.id)) throw fail('Já existe uma conta com este CPF.', 409);
    if (dados.cnpj && db.get('SELECT 1 FROM users WHERE cnpj = ? AND id <> ?', dados.cnpj, u.id)) throw fail('Já existe uma conta com este CNPJ.', 409);
    return dados;
  };

  // Acesso de afiliado com o mesmo e-mail que não é desta conta: não liga sem prova (ver clientes.ligacaoPermitida)
  const outroAcesso = (p.conta === 'cliente' || p.ferramenta) && clientes.acessoComMesmoEmail(u);
  if (outroAcesso && !clientes.ligacaoPermitida(u, outroAcesso)) throw fail(clientes.MSG_OUTRO_ACESSO, 409);
  if (p.conta === 'cliente') {
    const existente = (u.cliente_id && clientes.getById(u.cliente_id)) || db.get('SELECT * FROM clientes WHERE email = ?', u.email);
    if (existente) return { email: u.email, nome: existente.nome, renovar_cliente_id: existente.id, vincular_user_id: u.id };
    // O Afiliado Pro só pede nome, CPF e celular (o formulário não tem endereço nem nascimento).
    let dados = { nome: u.nome, cpf: u.cpf, telefone: u.telefone };
    if (!u.tipo) {
      const nome = String(b.nome || '').trim().replace(/\s+/g, ' ');
      if (nome.length < 5 || !/\s/.test(nome)) throw fail('Informe nome e sobrenome.');
      const cpf = cadastro.digits(b.cpf);
      if (!cadastro.validCpf(cpf)) throw fail('CPF inválido.');
      const telefone = cadastro.digits(b.telefone);
      if (telefone.length < 10 || telefone.length > 11) throw fail('Informe o celular com DDD.');
      if (isBlocked(`cpf:${cpf}`)) throw fail('Não é possível concluir com estes dados. Fale com o administrador.');
      if (db.get('SELECT 1 FROM users WHERE cpf = ? AND id <> ?', cpf, u.id)) throw fail('Já existe uma conta com este CPF.', 409);
      dados = { nome, cpf, telefone };
    }
    return { email: u.email, nome: dados.nome || u.nome, cpf: dados.cpf, telefone: dados.telefone, vincular_user_id: u.id,
      senha_hash: u.senha_hash || auth.hashPassword(crypto.randomBytes(24).toString('hex')),
      ...(u.tipo ? {} : { perfil_dados: dados }) };
  }
  const perfil = perfilDaConta(p, b, u);
  parceiro(p, b, perfil);
  // Conta que já existe e passa a ser loja: faltam só os dados da empresa
  if (u.tipo && perfil === 'empresa' && u.tipo !== 'empresa') {
    const emp = cadastro.dadosEmpresa({ nome: u.nome, telefone: u.telefone, ...b });
    if (emp.cnpj && isBlocked(`cnpj:${emp.cnpj}`)) throw fail('Não é possível concluir com estes dados. Fale com o administrador.');
    if (emp.cnpj && db.get('SELECT 1 FROM users WHERE cnpj = ? AND id <> ?', emp.cnpj, u.id)) throw fail('Já existe uma conta com este CNPJ.', 409);
    return { email: u.email, nome: u.nome, renovar_user_id: u.id, perfil_conta: perfil, perfil_dados: emp, mudar_tipo: true };
  }
  return { email: u.email, nome: u.nome, renovar_user_id: u.id, perfil_conta: perfil, ...(u.tipo ? {} : { perfil_dados: novosDados(perfil) }) };
}

// Termos do Parceiro: plano de empresa (lojista) e/ou com a ferramenta (afiliado)
function parceiro(p, b, perfil) {
  require('./consentimento').validarParceiro(b, require('./consentimento').papeisDe({ tipo: perfil, ferramenta: p.ferramenta }));
}

// Valida os dados do formulário conforme o plano. Se o e-mail já tem conta e a senha confere, é renovação.
function validarDados(p, b, logado = null) {
  if (logado) return validarLogado(p, b, logado);
  const emailN = String(b.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailN) || emailN.length > 120) throw fail('Informe um e-mail válido.');
  const senha = String(b.senha || '');
  if (senha.length < 8 || senha.length > 200) throw fail('A senha precisa ter pelo menos 8 caracteres.');
  require('./consentimento').validar(b); // LGPD + Termos de Uso (duas caixas obrigatórias)
  if (isBlocked(emailN)) throw fail('Não é possível usar este e-mail. Fale com o administrador.');
  const renovar = b.renovar === true || b.renovar === 'on' || b.renovar === '1';

  if (p.conta === 'cliente') {
    parceiro(p, b, null);
    const existente = db.get('SELECT * FROM clientes WHERE email = ?', emailN);
    if (existente) {
      if (!auth.verifyPassword(senha, existente.senha_hash)) throw fail('Este e-mail já tem acesso ao Afiliado Pro. Para renovar, use a mesma senha.', 409);
      return { email: emailN, nome: existente.nome, renovar_cliente_id: existente.id };
    }
    if (renovar) throw fail('Não encontramos um acesso ao Afiliado Pro com este e-mail. Desmarque "renovar" para criar um novo.', 404);
    if (b.senha_confirmacao !== undefined && b.senha_confirmacao !== senha) throw fail('As senhas não conferem.');
    const nome = String(b.nome || '').trim().replace(/\s+/g, ' ');
    if (nome.length < 5 || !/\s/.test(nome)) throw fail('Informe nome e sobrenome.');
    const cpf = cadastro.digits(b.cpf);
    if (!cadastro.validCpf(cpf)) throw fail('CPF inválido.');
    const tel = cadastro.digits(b.telefone);
    if (tel.length < 10 || tel.length > 11) throw fail('Informe o celular com DDD.');
    require('./senha').validar(senha, { email: emailN, nome }); // conta nova: senha forte
    return { email: emailN, nome, cpf, telefone: tel, senha_hash: auth.hashPassword(senha) };
  }

  // Consumidor ou empresa: conta do site. Plano com a ferramenta e e-mail que já tem acesso de afiliado: precisa da senha do painel
  const acessoAfiliado = p.ferramenta && db.get('SELECT * FROM clientes WHERE email = ?', emailN);
  const afiliadoConfirmado = Boolean(acessoAfiliado && auth.verifyPassword(senha, acessoAfiliado.senha_hash));
  if (acessoAfiliado && !afiliadoConfirmado) {
    const contaDoSite = db.get('SELECT * FROM users WHERE email = ?', emailN);
    if (!contaDoSite || !clientes.ligacaoPermitida(contaDoSite, acessoAfiliado)) throw fail(clientes.MSG_OUTRO_ACESSO, 409);
  }
  const existente = db.get('SELECT * FROM users WHERE email = ?', emailN);
  if (existente) {
    if (!existente.senha_hash || !auth.verifyPassword(senha, existente.senha_hash)) {
      throw fail('Este e-mail já tem conta no site. Para assinar, use a mesma senha da conta (ou entre e escolha o plano).', 409);
    }
    if (['banned', 'rejected'].includes(existente.status)) throw fail('Esta conta não pode assinar. Fale com o administrador.', 403);
    const perfil = perfilDaConta(p, b, existente);
    parceiro(p, b, perfil);
    return { email: emailN, nome: existente.nome, renovar_user_id: existente.id, perfil_conta: perfil, ...(afiliadoConfirmado ? { afiliado_confirmado: true } : {}) };
  }
  if (renovar) throw fail('Não encontramos uma conta com este e-mail. Desmarque "renovar" para criar uma nova.', 404);
  if (b.senha_confirmacao !== undefined && b.senha_confirmacao !== senha) throw fail('As senhas não conferem.');
  const perfil = perfilDaConta(p, b, null);
  parceiro(p, b, perfil);
  const dados = { ...cadastro.dadosPessoa(b), ...(perfil === 'empresa' ? cadastro.dadosEmpresa(b) : {}) };
  if (isBlocked(`cpf:${dados.cpf}`) || (dados.cnpj && isBlocked(`cnpj:${dados.cnpj}`))) throw fail('Não é possível concluir com estes dados. Fale com o administrador.');
  if (db.get('SELECT 1 FROM users WHERE cpf = ?', dados.cpf)) throw fail('Já existe uma conta com este CPF. Entre com ela para assinar.', 409);
  if (dados.cnpj && db.get('SELECT 1 FROM users WHERE cnpj = ?', dados.cnpj)) throw fail('Já existe uma conta com este CNPJ.', 409);
  require('./senha').validar(senha, { email: emailN, nome: dados.nome }); // conta nova: senha forte
  return { email: emailN, nome: dados.nome, ...dados, perfil_conta: perfil, senha_hash: auth.hashPassword(senha), ...(afiliadoConfirmado ? { afiliado_confirmado: true } : {}) };
}

function baseUrl(req) {
  const site = String(settings.get('site_url') || '').replace(/\/+$/, '');
  return /^https?:\/\//i.test(site) ? site : `${req.protocol}://${req.get('host')}`;
}

async function mp(method, path, data, s, extraHeaders = {}) {
  const r = await axios({ method, url: `${process.env.MP_API_URL || MP_PADRAO}${path}`, data, timeout: 20000, validateStatus: () => true,
    headers: { Authorization: `Bearer ${s.mp_access_token}`, 'Content-Type': 'application/json', ...extraHeaders } });
  if (r.status >= 400) {
    const m = r.data?.message || r.data?.error || `HTTP ${r.status}`;
    throw fail(r.status === 401 ? 'Mercado Pago recusou o Access Token (confira no painel).' : `Mercado Pago: ${m}`, 502);
  }
  return r.data;
}

async function criarPedido(b, req) {
  const s = settings.getAll();
  const p = planos.plano(String(b.plano || ''), s);
  if (!p || !p.ativo) throw fail('Plano indisponível.');
  // Plano grátis: sem pagamento, a conta é liberada na hora.
  if (p.gratis) {
    const dados = validarDados(p, b, users.currentUser(req));
    const conta = dados.renovar_user_id && users.getById(dados.renovar_user_id);
    const pagoAtual = conta && conta.assinatura_ate > nowSql() && planos.plano(conta.plano);
    if (pagoAtual && !pagoAtual.gratis) throw fail(`Você já tem o plano ${pagoAtual.nome} ativo. Quando ele vencer, sua conta volta para o plano grátis automaticamente.`, 409);
    if (pagoAtual && pagoAtual.id === p.id) throw fail('Você já tem este plano grátis. É só entrar com seu e-mail e senha.', 409);
    const token = crypto.randomBytes(24).toString('hex');
    const ins = db.run(`INSERT INTO pagamentos (token, plano, valor, dias, metodo, email, nome, dados) VALUES (?, ?, 0, ?, 'gratis', ?, ?, ?)`,
      token, p.id, p.dias, dados.email, dados.nome || null, JSON.stringify(dados));
    aprovar(Number(ins.lastInsertRowid), 'plano grátis');
    return { token };
  }
  const logado = users.currentUser(req);
  const clienteLogado = logado ? null : clientes.atual(req);
  const ciclo = planos.ciclo(p, b.ciclo);

  // Período grátis (7 dias, ou 1 mês para as primeiras lojas): sem pagamento e sem cartão, uma vez por pessoa
  if (b.teste === true || b.teste === '1') {
    if (b.trocar_de) throw fail('O período grátis é para quem ainda não tem o plano. Para trocar, escolha uma forma de pagamento.', 409);
    const dados = validarDados(p, b, logado);
    if (assinaturas.planoAtivo(p, logado, clienteLogado)) throw fail(`Você já tem o plano ${p.nome} ativo.`, 409);
    const chaves = assinaturas.identidade(dados, logado);
    const oferta = assinaturas.cortesia(p, chaves);
    if (!oferta) throw fail('O período grátis deste plano já foi usado. Escolha uma forma de pagamento para continuar.', 409);
    const token = crypto.randomBytes(24).toString('hex');
    const ins = db.run(`INSERT INTO pagamentos (token, plano, valor, dias, metodo, email, nome, dados, ciclo) VALUES (?, ?, 0, ?, 'teste', ?, ?, ?, 'teste')`,
      token, p.id, oferta.dias, dados.email, dados.nome || null, JSON.stringify(dados));
    const pedidoId = Number(ins.lastInsertRowid);
    assinaturas.registrarCortesia(chaves, p.id, oferta.tipo, pedidoId);
    aprovar(pedidoId, oferta.tipo === 'loja_mes' ? 'mês grátis das primeiras lojas' : 'período grátis');
    return { token };
  }

  const metodo = String(b.metodo || '');
  const disp = metodosDisponiveis(s, p.id);
  if (!disp.lista.some(m => m.id === metodo)) throw fail('Forma de pagamento indisponível no momento.');
  const auto = b.renovacao_auto === true || b.renovacao_auto === '1';
  if (auto && metodo !== 'mercadopago') throw fail('A renovação automática funciona só no cartão. Escolha cartão ou desligue a renovação.');
  if (auto && !p.ciclos.length) throw fail('Este plano não tem renovação automática.');
  const dados = validarDados(p, b, logado);
  const troca = assinaturas.prepararTroca(p, ciclo, b, logado, clienteLogado);
  if (troca) Object.assign(dados, troca);
  const valor = auto ? ciclo.preco_auto : ciclo.preco;
  const dias = ciclo.dias + (troca?.dias_bonus || 0);

  const token = crypto.randomBytes(24).toString('hex');
  const ins = db.run(`INSERT INTO pagamentos (token, plano, valor, dias, metodo, email, nome, dados, ciclo, renovacao_auto, trocado_de) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    token, p.id, valor, dias, auto ? 'assinatura' : metodo === 'pix' && !disp.pix_automatico ? 'pix_manual' : metodo, dados.email, dados.nome || null, JSON.stringify(dados), ciclo.id, auto ? 1 : 0, troca?.trocar_de || null);
  const id = Number(ins.lastInsertRowid);
  const base = baseUrl(req);
  const publico = /^https:\/\//i.test(base); // o Mercado Pago só avisa / volta para endereços https
  const descricao = `${p.nome} — ${ciclo.dias ? `${ciclo.nome.toLowerCase()}, ${ciclo.dias} dias de acesso` : 'acesso sem vencimento'} (Ofertou!)`;

  try {
    // Renovação automática: a pessoa autoriza no Mercado Pago, que cobra sozinho a cada período
    if (auto) {
      // Com cartão salvo: autoriza aqui mesmo, sem sair do site, e o Mercado Pago faz a primeira cobrança em cerca de 1 hora.
      // Sem cartão salvo: a pessoa autoriza e paga na página do Mercado Pago.
      let cartaoAuto = null;
      if (b.cartao?.card_id) {
        const dono = require('./perfis').donoDe(req);
        if (!dono) throw fail('Entre na sua conta para usar um cartão salvo.', 401);
        if (!b.cartao.token) throw fail('Digite o código de segurança do cartão.');
        cartaoAuto = await require('./cartoes').paraPagamento(dono, b.cartao.card_id);
      }
      const pre = await mp('post', '/preapproval', {
        reason: descricao, external_reference: token, payer_email: dados.email, back_url: `${base}/assinar?pedido=${token}`,
        ...(cartaoAuto ? { card_token_id: String(b.cartao.token), status: 'authorized' } : { status: 'pending' }),
        auto_recurring: { frequency: ciclo.id === 'mensal' && ciclo.dias !== 30 ? ciclo.dias : ciclo.meses, frequency_type: ciclo.id === 'mensal' && ciclo.dias !== 30 ? 'days' : 'months', transaction_amount: valor, currency_id: 'BRL' },
      }, s, { 'X-Idempotency-Key': token });
      db.run('UPDATE pagamentos SET mp_preference_id = ? WHERE id = ?', String(pre.id), id);
      assinaturas.criarAuto({ token, preapproval: pre.id, plano: p.id, ciclo: ciclo.id, valor, dias: ciclo.dias, email: dados.email });
      if (cartaoAuto) {
        if (pre.status !== 'authorized') throw fail('O Mercado Pago não autorizou este cartão. Confira o código de segurança ou use outro cartão.', 402);
        db.run('UPDATE pagamentos SET dados = ?, observacao = ? WHERE id = ?', JSON.stringify({ ...dados, cartao_salvo: true }), `Cartão salvo ${cartaoAuto.cartao.bandeira || ''} final ${cartaoAuto.cartao.final || ''}`.slice(0, 300), id);
        return { token };
      }
      return { token, checkout_url: pre.init_point };
    }
    if (metodo === 'pix' && disp.pix_automatico) {
      const [primeiro, ...resto] = String(dados.nome || 'Cliente').split(' ');
      const expira = new Date(Date.now() + PIX_MINUTOS * 60000);
      const pay = await mp('post', '/v1/payments', {
        transaction_amount: valor, description: descricao, payment_method_id: 'pix', external_reference: token,
        date_of_expiration: expira.toISOString().replace('Z', '+00:00'),
        payer: { email: dados.email, first_name: primeiro, last_name: resto.join(' ') || primeiro,
          ...(dados.cpf ? { identification: { type: 'CPF', number: dados.cpf } } : {}) },
        ...(publico ? { notification_url: `${base}/api/pagamentos/webhook` } : {}),
      }, s, { 'X-Idempotency-Key': token });
      const td = pay.point_of_interaction?.transaction_data || {};
      db.run('UPDATE pagamentos SET mp_payment_id = ?, pix_qr = ?, pix_qr_base64 = ?, pix_expira = ? WHERE id = ?',
        String(pay.id), td.qr_code || null, td.qr_code_base64 || null, sqlDe(expira), id);
      return { token };
    }
    // Cartão salvo (Minha conta → Meus cartões): cobrado aqui mesmo, sem sair do site; a pessoa digita só o código de segurança
    if (metodo === 'mercadopago' && b.cartao?.card_id) {
      const dono = require('./perfis').donoDe(req);
      if (!dono) throw fail('Entre na sua conta para pagar com um cartão salvo.', 401);
      if (!b.cartao.token) throw fail('Digite o código de segurança do cartão.');
      const salvo = await require('./cartoes').paraPagamento(dono, b.cartao.card_id);
      const maxParc = Math.min(Math.max(parseInt(s.pag_mp_parcelas, 10) || 1, 1), 12);
      const parc = Math.min(Math.max(parseInt(b.cartao.installments, 10) || 1, 1), maxParc);
      const pay = await mp('post', '/v1/payments', {
        transaction_amount: valor, token: String(b.cartao.token), installments: parc, payment_method_id: String(salvo.payment_method_id),
        ...(salvo.issuer_id ? { issuer_id: String(salvo.issuer_id) } : {}),
        description: descricao, external_reference: token, statement_descriptor: 'OFERTOU',
        payer: { type: 'customer', id: salvo.customer_id, email: dados.email },
        ...(publico ? { notification_url: `${base}/api/pagamentos/webhook` } : {}),
      }, s, { 'X-Idempotency-Key': token });
      db.run('UPDATE pagamentos SET mp_payment_id = ?, observacao = ? WHERE id = ?', String(pay.id), `Cartão salvo ${salvo.cartao.bandeira || ''} final ${salvo.cartao.final || ''} em ${parc}x`.slice(0, 300), id);
      if (pay.status === 'approved') aprovar(id, 'Mercado Pago (cartão salvo)');
      else if (['rejected', 'cancelled'].includes(pay.status)) throw fail(require('./pedidos-loja').motivoRecusa(pay.status_detail), 402);
      return { token }; // em análise: a página acompanha até o Mercado Pago decidir
    }
    if (metodo === 'mercadopago') {
      const pref = await mp('post', '/checkout/preferences', {
        items: [{ id: p.id, title: descricao, quantity: 1, unit_price: valor, currency_id: 'BRL' }],
        payer: { email: dados.email, name: dados.nome || undefined },
        external_reference: token,
        back_urls: { success: `${base}/assinar?pedido=${token}`, failure: `${base}/assinar?pedido=${token}`, pending: `${base}/assinar?pedido=${token}` },
        ...(publico ? { auto_return: 'approved', notification_url: `${base}/api/pagamentos/webhook` } : {}),
        payment_methods: { excluded_payment_types: [{ id: 'ticket' }], installments: Math.min(Math.max(parseInt(s.pag_mp_parcelas, 10) || 1, 1), 12) },
        statement_descriptor: 'OFERTOU',
      }, s);
      db.run('UPDATE pagamentos SET mp_preference_id = ? WHERE id = ?', String(pref.id), id);
      return { token, checkout_url: pref.init_point };
    }
    return { token }; // Pix pela chave, transferência ou link: a página mostra como pagar
  } catch (err) {
    db.run(`UPDATE pagamentos SET status = 'cancelado', observacao = ? WHERE id = ?`, err.message.slice(0, 300), id);
    throw err;
  }
}

// ── Confirmação ──────────────────────────────────────────────────────────────
const MP_STATUS = { approved: 'aprovado', rejected: 'recusado', cancelled: 'cancelado', refunded: 'cancelado', charged_back: 'cancelado' };

// Consulta o Mercado Pago e atualiza o pedido (aprovando a conta se o pagamento foi aprovado).
async function verificar(pedido) {
  if (pedido.status !== 'pendente') return pedido;
  const s = settings.getAll();
  if (pedido.metodo === 'assinatura') {
    await assinaturas.conferirPedido(pedido).catch(err => console.error('[ASSINATURA]', err.message));
    return db.get('SELECT * FROM pagamentos WHERE id = ?', pedido.id);
  }
  if (['pix', 'mercadopago'].includes(pedido.metodo) && s.mp_access_token) {
    let pay = null;
    if (pedido.mp_payment_id) pay = await mp('get', `/v1/payments/${pedido.mp_payment_id}`, null, s).catch(() => null);
    else {
      const r = await mp('get', `/v1/payments/search?external_reference=${pedido.token}&sort=date_created&criteria=desc`, null, s).catch(() => null);
      pay = r?.results?.find(x => x.status === 'approved') || r?.results?.[0] || null;
    }
    // Só vale o pagamento deste pedido, com o valor certo.
    if (pay && pay.external_reference === pedido.token && Math.abs(Number(pay.transaction_amount) - pedido.valor) < 0.01) {
      if (pay.status === 'approved') { if (!pedido.mp_payment_id) db.run('UPDATE pagamentos SET mp_payment_id = ? WHERE id = ?', String(pay.id), pedido.id); return aprovar(pedido.id, 'Mercado Pago'); }
      if (MP_STATUS[pay.status]) db.run('UPDATE pagamentos SET status = ? WHERE id = ? AND status = ?', MP_STATUS[pay.status], pedido.id, 'pendente');
    }
  }
  if (pedido.pix_expira && pedido.pix_expira < nowSql() && pedido.metodo === 'pix') {
    db.run(`UPDATE pagamentos SET status = 'expirado' WHERE id = ? AND status = 'pendente'`, pedido.id);
  }
  return db.get('SELECT * FROM pagamentos WHERE id = ?', pedido.id);
}

const somaDias = planos.somaDias; // 0 dias = sem vencimento

// Cria ou renova a conta do pedido (uma única vez) e manda o e-mail de confirmação.
function aprovar(pedidoId, origem) {
  let pedido;
  db.transaction(() => {
    pedido = db.get('SELECT * FROM pagamentos WHERE id = ?', pedidoId);
    if (!pedido || pedido.status === 'aprovado') return;
    const p = planos.plano(pedido.plano);
    const d = JSON.parse(pedido.dados);
    let contaTipo, contaId, validade;
    if (d.trocar_de) assinaturas.encerrarPlanoAntigo(d);
    if (p.conta === 'cliente') {
      contaTipo = 'cliente';
      if (d.renovar_cliente_id && clientes.getById(d.renovar_cliente_id)) {
        contaId = d.renovar_cliente_id;
        validade = somaDias(clientes.getById(contaId).validade, pedido.dias);
        db.run(`UPDATE clientes SET validade = ?, status = 'ativo' WHERE id = ?`, validade, contaId);
      } else {
        validade = somaDias(null, pedido.dias);
        const ex = db.get('SELECT id FROM clientes WHERE email = ?', d.email);
        if (ex) { contaId = ex.id; db.run(`UPDATE clientes SET validade = ?, status = 'ativo' WHERE id = ?`, validade, contaId); }
        else {
          contaId = Number(db.run('INSERT INTO clientes (nome, email, senha_hash, validade, observacoes) VALUES (?, ?, ?, ?, ?)',
            d.nome, d.email, d.senha_hash, validade, `Assinatura online (${p.nome}) — CPF ${d.cpf}, tel ${d.telefone}`).lastInsertRowid);
        }
      }
      db.run('UPDATE clientes SET plano = ? WHERE id = ?', p.id, contaId); // qual plano de ferramenta ele tem
      // Comprado logado no site: o acesso da ferramenta fica ligado à conta (entra pelo mesmo login, inclusive Google).
      if (d.vincular_user_id && users.getById(d.vincular_user_id)) {
        const u = users.getById(d.vincular_user_id);
        db.run('UPDATE users SET cliente_id = ? WHERE id = ?', contaId, u.id);
        if (!u.tipo || u.tipo === 'afiliado') {
          const pd = d.perfil_dados || {};
          const cols = { ...pd, tipo: 'afiliado', plano: p.id, assinatura_ate: validade,
            status: ['pending', 'onboarding'].includes(u.status) ? 'active' : u.status,
            ...(u.tipo ? {} : { aceite_termos_em: nowSql() }) };
          db.run(`UPDATE users SET ${Object.keys(cols).map(c => `${c} = ?`).join(', ')} WHERE id = ?`, ...Object.values(cols), u.id);
        } else if (d.trocar_de && planos.plano(d.trocar_de)?.conta === 'usuario') {
          // Saiu da loja para a ferramenta: a conta vira de afiliado e a loja sai do ar, sem apagar (volta se assinar de novo)
          db.run(`UPDATE users SET tipo = 'afiliado', plano = ?, assinatura_ate = ? WHERE id = ?`, p.id, validade, u.id);
          if (u.tipo === 'empresa') db.run('UPDATE lojas SET oculta = 2 WHERE user_id = ? AND oculta = 0', u.id);
        }
      }
    } else {
      contaTipo = 'usuario';
      const perfil = p.perfis.includes(d.perfil_conta) ? d.perfil_conta : p.perfil;
      if (d.renovar_user_id && users.getById(d.renovar_user_id)) {
        contaId = d.renovar_user_id;
        const u = users.getById(contaId);
        validade = somaDias(u.assinatura_ate, pedido.dias);
        db.run(`UPDATE users SET plano = ?, assinatura_ate = ?, tipo = CASE WHEN tipo IS NULL OR tipo = 'afiliado' OR ? = 1 THEN ? ELSE tipo END,
                status = CASE WHEN status IN ('pending', 'onboarding') THEN 'active' ELSE status END WHERE id = ?`, p.id, validade, d.mudar_tipo ? 1 : 0, perfil, contaId);
        if (perfil === 'empresa') db.run('UPDATE lojas SET oculta = 0 WHERE user_id = ? AND oculta = 2', contaId);
        // Conta que ainda não tinha perfil (ou que virou loja): grava os dados preenchidos na compra.
        if (d.perfil_dados && (!u.tipo || d.mudar_tipo)) {
          const cols = { ...d.perfil_dados, ...(u.tipo ? {} : { aceite_termos_em: nowSql() }) };
          db.run(`UPDATE users SET ${Object.keys(cols).map(c => `${c} = ?`).join(', ')} WHERE id = ?`, ...Object.values(cols), contaId);
        }
      } else {
        validade = somaDias(null, pedido.dias);
        const { email: em, nome, senha_hash, ...resto } = d;
        const cols = { email: em, nome, senha_hash, status: 'active', plano: p.id, assinatura_ate: validade, aceite_termos_em: nowSql(), ...resto, tipo: perfil };
        delete cols.renovar_user_id; delete cols.perfil_conta; delete cols.afiliado_confirmado;
        contaId = Number(db.run(`INSERT INTO users (${Object.keys(cols).join(', ')}) VALUES (${Object.keys(cols).map(() => '?').join(', ')})`,
          ...Object.values(cols)).lastInsertRowid);
      }
      // Plano com a ferramenta junto: a mesma conta ganha o painel de afiliado (mesmo login, mesma validade)
      if (p.ferramenta) clientes.liberarPlano(users.getById(contaId), p.id, atual => somaDias(atual, pedido.dias), { confirmado: d.afiliado_confirmado === true });
      users.logAction(users.getById(contaId), 'assinatura_aprovada', `${p.nome} ${validade === planos.SEM_VENCIMENTO ? 'sem vencimento' : `até ${validade.slice(0, 10)}`} (${origem})`);
    }
    // Não guarda a senha (hash) além do necessário.
    const semSenha = { ...d }; delete semSenha.senha_hash;
    db.run(`UPDATE pagamentos SET status = 'aprovado', aprovado_em = datetime('now'), conta_tipo = ?, conta_id = ?, validade_ate = ?, dados = ?, observacao = ? WHERE id = ?`,
      contaTipo, contaId, validade, JSON.stringify(semSenha), `aprovado por: ${origem}`, pedido.id);
  });
  const atualizado = db.get('SELECT * FROM pagamentos WHERE id = ?', pedidoId);
  if (atualizado?.status === 'aprovado' && !atualizado.email_enviado) enviarConfirmacao(atualizado).catch(err => console.error('[PAGAMENTO] e-mail:', err.message));
  // Troca de plano: para de cobrar o plano que saiu (a nova assinatura, se houver, continua)
  if (atualizado?.status === 'aprovado' && atualizado.trocado_de) {
    const d2 = JSON.parse(atualizado.dados || '{}');
    const contas = [d2.trocar_user_id && ['usuario', d2.trocar_user_id], d2.trocar_cliente_id && ['cliente', d2.trocar_cliente_id]].filter(Boolean);
    assinaturas.pararDaConta(contas, atualizado.trocado_de, atualizado.token).catch(err => console.error('[ASSINATURA]', err.message));
  }
  return atualizado;
}

const fmtDia = sql => new Date(String(sql).replace(' ', 'T') + 'Z').toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

async function enviarConfirmacao(pedido) {
  if (!email.configurado()) return false;
  const p = planos.plano(pedido.plano);
  const site = String(settings.get('site_url') || '').replace(/\/+$/, '') || 'o site Ofertou!';
  const onde = p.conta === 'cliente' ? `${site}/cliente` : `${site}/conta`;
  const semVenc = pedido.validade_ate === planos.SEM_VENCIMENTO;
  const gratis = !(pedido.valor > 0);
  const teste = pedido.metodo === 'teste';
  const validade = semVenc ? 'sem vencimento' : fmtDia(pedido.validade_ate);
  const proximo = teste ? `Seu período grátis vai até essa data. Nada é cobrado sem você escolher: para continuar, assine em ${site}/assinar?plano=${p.id}`
    : pedido.renovacao_auto ? 'A renovação é automática no cartão. Você pode desligar quando quiser em Minha conta → Meus planos.'
    : 'Para renovar, é só assinar o mesmo plano de novo com o mesmo e-mail e senha: os dias são somados.';
  const texto = [
    `Olá${pedido.nome ? `, ${pedido.nome.split(' ')[0]}` : ''}!`, '',
    teste ? `Seu período grátis do plano ${p.nome} começou.` : gratis ? `Seu plano ${p.nome} (grátis) está ativo.` : `Seu pagamento foi confirmado e o plano ${p.nome} está ativo.`, '',
    `Valor: ${gratis ? 'grátis' : `R$ ${pedido.valor.toFixed(2).replace('.', ',')}`}`,
    `Validade: ${validade}`,
    `Acesso: ${onde} (entre com o e-mail ${pedido.email} e a senha que você cadastrou)`, '',
    proximo, '',
    'Obrigado!', 'Ofertou!',
  ].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#161b18;line-height:1.55">
    <h2 style="color:#0c8f4f;margin:0 0 12px">${gratis ? 'Plano ativado! 🎉' : 'Pagamento confirmado! 🎉'}</h2>
    <p>Olá${pedido.nome ? `, ${escHtml(pedido.nome.split(' ')[0])}` : ''}! Seu plano <b>${escHtml(p.nome)}</b> está ativo.</p>
    <table style="border-collapse:collapse;margin:12px 0">
      <tr><td style="padding:4px 12px 4px 0;color:#48514c">Valor</td><td><b>${gratis ? 'grátis' : `R$ ${pedido.valor.toFixed(2).replace('.', ',')}`}</b></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#48514c">Validade</td><td><b>${validade}</b></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#48514c">Acesso</td><td><a href="${escHtml(onde)}">${escHtml(onde)}</a></td></tr>
    </table>
    <p style="color:#48514c">Entre com o e-mail <b>${escHtml(pedido.email)}</b> e a senha que você cadastrou. ${escHtml(proximo)}</p>
    <p>Obrigado!<br>Ofertou!</p></div>`;
  await email.enviar({ para: pedido.email, assunto: `${gratis ? 'Plano ativado' : 'Pagamento confirmado'} — ${p.nome} (${semVenc ? 'sem vencimento' : `válido até ${validade}`})`, texto, html });
  db.run('UPDATE pagamentos SET email_enviado = 1 WHERE id = ?', pedido.id);
  return true;
}
const escHtml = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Entrega o login (cookie de sessão) uma única vez, ao navegador que fez o pedido (tem o token).
function entregarLogin(pedido, req, res) {
  if (pedido.status !== 'aprovado' || pedido.login_entregue) return null;
  db.run('UPDATE pagamentos SET login_entregue = 1 WHERE id = ?', pedido.id);
  if (pedido.conta_tipo === 'cliente') {
    const c = clientes.getById(pedido.conta_id);
    if (c) clientes.criarSessao(req, res, c);
    return '/';
  }
  users.createSession(req, res, pedido.conta_id);
  return '/';
}

// Como pagar nas formas confirmadas pelo admin (dados que o próprio admin cadastrou para receber).
const MANUAIS = ['pix_manual', 'transferencia', 'link', 'combinar'];
const TIPO_CHAVE = { cpf: 'CPF', cnpj: 'CNPJ', email: 'E-mail', telefone: 'Telefone', aleatoria: 'Chave aleatória' };
function instrucoesManuais(pedido, s) {
  const base = { tipo: pedido.metodo, whatsapp: s.pag_whatsapp || s.whatsapp_anuncios || '', recado: s.pag_instrucoes || '' };
  if (pedido.metodo === 'pix_manual') {
    return { ...base, chave: s.pix_chave, chave_tipo: TIPO_CHAVE[s.pix_tipo] || '', nome: s.pix_nome, banco: s.pix_banco };
  }
  if (pedido.metodo === 'transferencia') {
    return { ...base, banco: s.ted_banco, agencia: s.ted_agencia, conta: s.ted_conta,
      tipo_conta: s.ted_tipo_conta === 'poupanca' ? 'Poupança' : 'Corrente', titular: s.ted_titular, documento: s.ted_documento };
  }
  if (pedido.metodo === 'combinar') return base;
  return { ...base, nome: s.pag_link_nome, url: (planos.plano(pedido.plano) || {}).link_pagamento || '' };
}

// Situação do pedido para a página de pagamento (sem dados pessoais).
function publico(pedido) {
  const p = planos.plano(pedido.plano);
  const s = settings.getAll();
  return {
    status: pedido.status, plano: p.nome, valor: pedido.valor, dias: pedido.dias, metodo: pedido.metodo, email: pedido.email,
    cartao_salvo: pedido.metodo === 'assinatura' && /"cartao_salvo":true/.test(pedido.dados || ''), recusado: /recusou o cartão/.test(pedido.observacao || ''),
    validade_ate: pedido.validade_ate, gratis: pedido.metodo === 'gratis' || pedido.metodo === 'teste', teste: pedido.metodo === 'teste', renovacao_auto: Boolean(pedido.renovacao_auto), ciclo: pedido.ciclo || 'mensal', sem_vencimento: pedido.validade_ate === planos.SEM_VENCIMENTO,
    pix: pedido.metodo === 'pix' ? { copia_cola: pedido.pix_qr, qr_base64: pedido.pix_qr_base64, expira: pedido.pix_expira } : null,
    manual: MANUAIS.includes(pedido.metodo) ? instrucoesManuais(pedido, s) : null,
    email_configurado: email.configurado(s),
  };
}

const porToken = token => db.get('SELECT * FROM pagamentos WHERE token = ?', String(token || ''));

// Aviso do Mercado Pago (webhook): só usamos o id para consultar o pagamento na API.
async function webhook(body, query) {
  const id = body?.data?.id || query['data.id'] || (query.topic === 'payment' ? query.id : null);
  const s = settings.getAll();
  if (!s.mp_access_token) return;
  // Renovação automática: o aviso só adianta a conferência na API
  const tipo = String(body?.type || query.type || query.topic || '');
  if (/^subscription_preapproval/.test(tipo)) {
    if (/^[\w-]{6,64}$/.test(String(id))) await assinaturas.conferirPorId(id);
    return;
  }
  if (tipo === 'subscription_authorized_payment') {
    if (!/^\d+$/.test(String(id))) return;
    const ap = await mp('get', `/authorized_payments/${id}`, null, s).catch(() => null);
    if (ap?.preapproval_id) await assinaturas.conferirPorId(ap.preapproval_id);
    return;
  }
  if (!id || !/^\d+$/.test(String(id))) return;
  const pay = await mp('get', `/v1/payments/${id}`, null, s).catch(() => null);
  const pedido = pay?.external_reference && porToken(pay.external_reference);
  if (pedido) {
    if (!pedido.mp_payment_id) db.run('UPDATE pagamentos SET mp_payment_id = ? WHERE id = ?', String(pay.id), pedido.id);
    await verificar(db.get('SELECT * FROM pagamentos WHERE id = ?', pedido.id));
  }
}

// ── Painel do admin ──────────────────────────────────────────────────────────
function listar(limit = 200) {
  require('./arrependimento'); // colunas do reembolso (direito de arrependimento)
  return db.all(`SELECT id, plano, valor, dias, metodo, status, email, nome, mp_payment_id, conta_tipo, conta_id, validade_ate,
                 email_enviado, observacao, created_at, aprovado_em, reembolso_status, reembolso_em, reembolso_obs FROM pagamentos ORDER BY id DESC LIMIT ?`, limit);
}

function confirmarManual(id) {
  const p = db.get('SELECT * FROM pagamentos WHERE id = ?', id);
  if (!p) throw fail('Pedido não encontrado.', 404);
  if (p.status === 'aprovado') throw fail('Este pedido já foi aprovado.');
  if (!['pendente', 'expirado'].includes(p.status)) throw fail('Só dá para confirmar pedidos pendentes.');
  db.run(`UPDATE pagamentos SET status = 'pendente' WHERE id = ?`, id);
  return aprovar(id, 'confirmação manual do admin');
}

function cancelar(id) {
  db.run(`UPDATE pagamentos SET status = 'cancelado', observacao = 'cancelado pelo admin' WHERE id = ? AND status IN ('pendente', 'expirado')`, id);
}

async function reenviarEmail(id) {
  const p = db.get('SELECT * FROM pagamentos WHERE id = ?', id);
  if (!p || p.status !== 'aprovado') throw fail('Só pedidos aprovados recebem o e-mail.');
  if (!email.configurado()) throw fail('Configure o e-mail (SMTP) no painel primeiro.');
  db.run('UPDATE pagamentos SET email_enviado = 0 WHERE id = ?', id);
  await enviarConfirmacao(p);
}


module.exports = {
  metodosDisponiveis, criarPedido, verificar, aprovar, entregarLogin, publico, porToken, webhook,
  listar, confirmarManual, cancelar, reenviarEmail, enviarConfirmacao, mp,
};
