const db = require('./db');

// Termos buscados automaticamente em todas as lojas com coleta automática (lista em search-terms.js).
// Formato de cada linha: "termo" ou "termo | categoria".
const { DEFAULT_SEARCH_TERMS } = require('./search-terms');

const DEFAULTS = {
  // Site / redes sociais (públicos)
  whatsapp_link: 'https://chat.whatsapp.com/KRMTOE1KWMzK5CzopNC41e',
  whatsapp_anuncios: '556282417271', // número que atende empresas interessadas em anunciar
  telegram_link: '',
  instagram_user: '',
  adsense_client: '',            // ID de editor do Google AdSense (ca-pub-...)
  adsense_ativo: '0',            // mostrar anúncios do Google nos espaços sem campanha de anunciante
  adsense_slot_topo: '',         // códigos dos blocos de anúncio (data-ad-slot) de cada espaço
  adsense_slot_meio: '',
  adsense_slot_lateral: '',
  adsense_slot_paginas: '',
  ga_id: '',
  // Responsável pelo site (aparece nos Termos de Uso e na Política de Privacidade — LGPD)
  legal_nome: '',               // nome completo ou razão social do responsável (controlador dos dados)
  legal_documento: '',          // CPF ou CNPJ
  legal_endereco: '',           // endereço físico completo (Decreto 7.962/2013)
  legal_email: '',              // e-mail de contato e do encarregado de dados (DPO)
  legal_encarregado: '',        // nome do encarregado pelo tratamento de dados (DPO)

  // Mineração
  search_terms: DEFAULT_SEARCH_TERMS,
  mining_terms_per_run: '60', // termos por rodada; a lista inteira é percorrida em rodízio
  mining_interval_min: '120',
  ml_categorias_por_rodada: '200', // Mercado Livre: categorias da árvore varridas por rodada (mais vendidos de cada uma); 0 = desliga
  offer_max_age_hours: '24',
  manual_offer_days: '3',
  min_discount_pct: '5',
  // Capi minerando (animação no site): '1' = só durante a mineração, '0' = o tempo todo; intervalo entre um clipe e outro
  capi_so_mineracao: '0',
  capi_intervalo_seg: '10',
  stores_enabled: JSON.stringify({ amazon: true, mercadolivre: true, aliexpress: true, shopee: true, kabum: true }),

  // Afiliados
  amazon_tag: '',
  ml_matt_word: '',
  ml_matt_tool: '',
  ml_client_id: '',
  ml_client_secret: '',
  shopee_app_id: '',
  shopee_app_secret: '',
  shopee_afiliado_id: '',        // ID de afiliado da Shopee (vai nos links quando não há a API)
  aliexpress_app_key: '',
  aliexpress_app_secret: '',
  aliexpress_tracking_id: '',
  backup_dias: '7',          // backups diários guardados (além de 1 por semana das últimas 4 semanas)
  backup_pasta_externa: '',  // pasta sincronizada com a nuvem no servidor (Google Drive, OneDrive): recebe uma cópia
  kabum_afiliado: '',        // modelo do link de afiliado da KaBuM! com {url} (ou parâmetros para acrescentar)
  magalu_store: '',

  // Cadastro de usuários do site: 'aberto' (entra na hora), 'aprovacao' (admin libera) ou 'fechado'
  signup_consumidor: 'aprovacao',
  signup_empresa: 'aprovacao',
  signup_afiliado: 'aprovacao',
  loja_max_produtos: '300',

  // '1' = só usuários logados e liberados veem as ofertas (a primeira página vira o login)
  exigir_login: '1',

  // Login com Google (Google Cloud > APIs e serviços > Credenciais > ID do cliente OAuth)
  google_client_id: '',
  google_client_secret: '',
  // Endereço público do site (ex.: https://tanoofertou.com.br). Vazio = usa o endereço acessado.
  site_url: '',

  // Postagem automática nas redes sociais (APIs oficiais)
  telegram_bot_token: '',   // @BotFather
  telegram_chat_id: '',     // @canal ou id do grupo (-100...)
  facebook_page_id: '',
  facebook_page_token: '',  // token de acesso da página (também usado pelo Instagram)
  instagram_business_id: '',
  x_api_key: '',
  x_api_secret: '',
  x_access_token: '',
  x_access_secret: '',

  // WhatsApp: API própria (src/whatsapp-proprio.js)
  whatsapp_groups: '[]',        // grupos de destino: [{ id, nome, categorias }]
  whatsapp_intervalo_s: '90',   // espera entre uma oferta e outra no WhatsApp
  alertas_wa_ativo: '1',        // alertas de ofertas no WhatsApp particular de quem pedir (src/alertas-whatsapp.js)
  alertas_wa_ultimo: '',        // até quando as ofertas novas já foram conferidas (UTC)

  // Planos pagos (página de login) — nome, preço (R$) e dias de acesso de cada um
  plano_consumidor_nome: 'Caçador de Ofertas',
  plano_consumidor_preco: '9.90',
  plano_consumidor_dias: '30',
  plano_consumidor_ativo: '1',
  plano_empresa_nome: 'Loja Parceira',
  plano_empresa_preco: '49.90',
  plano_empresa_dias: '30',
  plano_empresa_ativo: '1',
  plano_pro_nome: 'Afiliado Pro',
  plano_pro_preco: '79.90',
  plano_pro_dias: '30',
  plano_pro_ativo: '1',
  // Formas de recebimento (Painel → Planos). Cada uma liga/desliga sozinha.
  //  • Mercado Pago: Pix com QR code e cartão pelo checkout, confirmação automática.
  //  • Pix pela chave, transferência bancária e link de pagamento: o admin confirma cada pedido.
  mp_access_token: '',
  mp_public_key: '',            // Public Key do Mercado Pago (formulário de cartão dentro do site; não é secreta)
  pag_mp_pix: '1',
  pag_mp_cartao: '1',
  pag_mp_parcelas: '1',         // parcelas máximas no cartão
  pag_pix_ativo: '1',
  pix_chave: '',
  pix_tipo: '',                 // cpf, cnpj, email, telefone ou aleatoria
  pix_nome: '',
  pix_banco: '',
  pix_cidade: '',               // cidade do recebedor (vai no Pix "copia e cola" das taxas das lojas)
  // Taxa de uso do site nos pedidos às lojas parceiras (%) e aplicação do Mercado Pago (marketplace) que conecta as lojas
  taxa_site_pct: '1',
  mp_mkt_client_id: '',
  mp_mkt_client_secret: '',
  pag_ted_ativo: '0',
  ted_banco: '',
  ted_agencia: '',
  ted_conta: '',
  ted_tipo_conta: 'corrente',
  ted_titular: '',
  ted_documento: '',
  pag_link_ativo: '0',
  pag_link_nome: 'Cartão de crédito',
  pag_link_consumidor: '',      // links de pagamento prontos (PagBank, InfinitePay, PicPay…), um por plano
  pag_link_empresa: '',
  pag_link_pro: '',
  // App nas lojas (Google Play / App Store) com compras validadas pelo RevenueCat
  app_ativo: '0',
  rc_chave_android: '',         // chave pública do SDK (goog_...)
  rc_chave_ios: '',             // chave pública do SDK (appl_...)
  rc_chave_secreta: '',         // chave secreta da API (sk_...)
  rc_webhook_auth: '',          // valor do cabeçalho Authorization configurado no webhook do RevenueCat
  app_produto_consumidor: 'ofertou_consumidor_mensal',
  app_produto_empresa: 'ofertou_empresa_mensal',
  app_produto_pro: 'ofertou_pro_mensal',
  pag_whatsapp: '',             // WhatsApp para o comprovante (vazio = o mesmo dos anúncios)
  pag_instrucoes: '',           // recado extra na tela de pagamento
  // E-mail de confirmação (SMTP — ex.: Gmail com "senha de app")
  smtp_host: '',
  smtp_port: '587',
  smtp_user: '',
  smtp_pass: '',
  smtp_from: '',

  // Postagens agendadas (3 vezes por dia)
  agenda_ativa: '0',
  agenda_horarios: '09:00,14:00,20:00', // horário de Brasília
  agenda_qtd: '5',
  agenda_redes: '["whatsapp"]',
  agenda_completar: '1',        // completa a fila com as melhores ofertas do momento
  // Modo contínuo: entre o início e o fim, uma postagem a cada X a Y minutos (intervalo aleatório, parece gente)
  agenda_modo: 'horarios',      // 'horarios' (nos horários fixos) ou 'continuo'
  agenda_inicio: '08:00',
  agenda_fim: '22:00',
  agenda_intervalo_min: '20',   // minutos
  agenda_intervalo_max: '40',
  agenda_por_vez: '1',          // ofertas em cada envio do modo contínuo
  agenda_lojas: '',             // lojas das ofertas automáticas (vazio = todas), ex.: mercadolivre,amazon
  agenda_palavras_bloqueadas: 'capinha, capa para celular, pelicula, cabo usb, suporte para celular', // nunca postar ofertas com estas palavras
  agenda_palavras_permitidas: '', // se preenchido: só ofertas com pelo menos uma destas palavras
  relampago_ativo: '1',           // radar de ofertas relâmpago
  agenda_relampago: '1',          // postar as ofertas relâmpago na hora
  ml_coleta_ofertas_em: '',       // última coleta das ofertas do Mercado Livre pela extensão
  ml_coleta_cupons_em: '',        // última coleta dos cupons do Mercado Livre pela extensão
  agenda_cupons_ativa: '0',       // postar a lista de cupons sozinho nos horários abaixo
  agenda_cupons_horarios: '12:00',
  agenda_cupons_redes: '["whatsapp"]', // redes que recebem a lista de cupons
  agenda_cupons_pos: '0',         // de onde a próxima lista de cupons continua
  agenda_cupons_ultima: '',       // resultado do último envio da lista de cupons
  // A mineração nunca traz produtos com estas palavras (src/palavras-proibidas.js). Editável em Painel → Mineração.
  mineracao_palavras_proibidas: [
    'arma', 'revólver', 'espingarda', 'carabina', 'fuzil', 'rifle', 'munição', 'munições', 'pólvora', 'pistola airsoft', 'pistola de airsoft', 'pistola de pressão', 'marcador de paintball', 'soco inglês', 'taser', 'spray de pimenta', 'gás de pimenta', 'coldre para pistola',
    'droga', 'maconha', 'cannabis', 'cocaína', 'haxixe', 'lsd', 'ecstasy', 'óleo de cbd', 'óleo cbd', 'lança perfume', 'anabolizante', 'dichavador', 'bong',
    'cigarro', 'vape', 'vaper', 'pod descartável', 'narguile', 'narguilé', 'tabaco para', 'tabaco de', 'fumo de rolo', 'fumo para', 'tabacaria', 'charuto', 'cigarrilha', 'piteira', 'seda para enrolar',
    'sex shop', 'sexshop', 'sex toy', 'vibrador', 'consolo', 'dildo', 'masturbador', 'plug anal', 'lubrificante íntimo', 'gel íntimo', 'erótico', 'erótica', 'sexual', 'bdsm', 'fetiche', 'boneca inflável', 'pênis', 'peniano', 'peniana', 'clitoriano', 'clitóris', 'pompoarismo',
  ].join(', '),
  post_modelo: '',              // modelo do texto das postagens (public/js/modelo-post.js); vazio = padrão
  ia_sac_ativa: '1',
  wa_grupo_controle: '',
  // Repostar ofertas de outros grupos (src/repostar-grupos.js)
  repost_ativo: '0',
  repost_origens: '[]',         // grupos de outras pessoas de onde as ofertas são pegas: [{ id, nome }]
  repost_destinos: '[]',        // grupos deste número que recebem as repostagens: [{ id, nome }]
  repost_por_tipo: '1',         // respeita o tipo e a loja marcados em cada grupo de destino
  repost_por_hora: '10',
  repost_intervalo_min: '3',
  repost_desconto_min: '15',
  repost_lojas: '',             // vazio = todas as lojas com link de afiliado
  repost_inicio: '08:00',
  repost_fim: '22:00',
  ganhos_awin_publisher: '',    // KaBuM! pela Awin: ID de publisher (sincronização dos ganhos, src/ganhos-sync.js)
  ganhos_awin_token: '',        // chave da API da Awin        // grupo de automação (src/grupo-automacao.js): ID do grupo que dá os comandos            // Capi faz o primeiro atendimento do SAC (src/ia/assistente.js)
  grupo_titulo: '',             // página /grupo: título (vazio = padrão)
  grupo_texto: '',              // página /grupo: texto abaixo do título (vazio = padrão)
  grupo_pixel_meta: '',         // página /grupo: ID do Pixel da Meta (anúncios no Facebook/Instagram)
  grupos_convite: '',           // página /grupo: um grupo por linha "Nome | link de convite | limite" (src/grupos-convite.js)
};

// Chaves que o site público pode ler.
const PUBLIC_KEYS = ['whatsapp_link', 'telegram_link', 'instagram_user', 'adsense_client', 'ga_id',
  'legal_nome', 'legal_documento', 'legal_endereco', 'legal_email', 'legal_encarregado'];

// Chaves que nunca saem do servidor em texto puro (nem para o painel). As de serviços antigos continuam aqui porque
// os valores podem seguir salvos no banco.
const SECRET_KEYS = ['ml_client_secret', 'shopee_app_secret', 'aliexpress_app_secret', 'google_client_secret',
  'telegram_bot_token', 'facebook_page_token', 'x_api_secret', 'x_access_token', 'x_access_secret',
  'zapi_token', 'zapi_client_token', 'evolution_api_key', 'zapi2_token', 'ganhos_awin_token', 'mp_access_token', 'mp_mkt_client_secret', 'smtp_pass', 'rc_chave_secreta', 'rc_webhook_auth'];

// Chaves internas que o painel não pode alterar pela tela de configurações.
const INTERNAL_KEYS = ['mineracao_palavras_proibidas', 'ml_coleta_ofertas_em', 'ml_coleta_cupons_em', 'admin_password_hash', 'mining_cursor', 'agenda_ultimas', 'agenda_cupons_pos', 'agenda_cupons_ultima', 'ganhos_ml_estimado', 'ml_varredura'];

for (const [key, value] of Object.entries(DEFAULTS)) {
  db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', key, value);
}

// Termos de mineração acrescentados depois da instalação: entram uma única vez na lista já salva no banco
// (a lista do painel pode ter sido editada; nada é apagado, e quem tirar o termo depois não o vê voltar).
const TERMOS_NOVOS = [
  ['termos_2026_10_23', ['conjunto | moda', 'infantil | moda', 'mauricinho | moda', 'camisa | moda', 'gola padre | moda']],
];
for (const [marca, termos] of TERMOS_NOVOS) {
  if (db.get('SELECT 1 FROM settings WHERE key = ?', marca)) continue;
  const atual = String(db.get('SELECT value FROM settings WHERE key = ?', 'search_terms')?.value || '');
  const tem = new Set(atual.split('\n').map(l => l.split('|')[0].trim().toLowerCase()).filter(Boolean));
  const faltam = termos.filter(l => !tem.has(l.split('|')[0].trim().toLowerCase()));
  if (faltam.length) db.run('UPDATE settings SET value = ? WHERE key = ?', `${atual.replace(/\s+$/, '')}\n${faltam.join('\n')}`, 'search_terms');
  db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', marca, '1');
}

function getAll() {
  const map = {};
  for (const row of db.all('SELECT key, value FROM settings')) map[row.key] = row.value;
  return map;
}

function get(key) {
  const row = db.get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : DEFAULTS[key];
}

function set(key, value) {
  db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, value == null ? '' : String(value)
  );
}

function getPublic() {
  const s = getAll();
  return Object.fromEntries(PUBLIC_KEYS.map(k => [k, s[k] || '']));
}

// Visão para o painel: segredos aparecem apenas como "configurado/não configurado".
function getForAdmin() {
  const s = getAll();
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (SECRET_KEYS.includes(key)) out[`${key}_set`] = Boolean(s[key]);
    else out[key] = s[key] ?? '';
  }
  return out;
}

// Salva somente chaves conhecidas. Segredo enviado vazio = manter o atual.
function updateFromAdmin(updates) {
  const changed = [];
  for (const [key, raw] of Object.entries(updates || {})) {
    if (!(key in DEFAULTS) || INTERNAL_KEYS.includes(key)) continue;
    let value = typeof raw === 'string' ? raw.trim() : raw;
    if (['stores_enabled', 'whatsapp_groups', 'agenda_redes'].includes(key) && typeof value === 'object') value = JSON.stringify(value);
    if (SECRET_KEYS.includes(key) && !value) continue;
    set(key, value);
    changed.push(key);
  }
  return changed;
}

function getNumber(key, fallback) {
  const n = Number(get(key));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getEnabledStores() {
  try { return JSON.parse(get('stores_enabled') || '{}'); } catch { return {}; }
}

function getSearchTerms() {
  return String(get('search_terms') || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [query, cat] = line.split('|').map(s => s.trim());
      return { query, cat: cat || null };
    })
    .filter(t => t.query);
}

module.exports = {
  DEFAULTS, getAll, get, set, getPublic, getForAdmin, updateFromAdmin,
  getNumber, getEnabledStores, getSearchTerms,
};
