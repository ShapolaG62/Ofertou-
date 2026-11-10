// Banco de dados SQLite usando o módulo nativo do Node (node:sqlite, Node >= 22.13).
// Não precisa compilar nada: funciona igual no Windows, no Linux e no Docker.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// Na Vercel a pasta do projeto é somente leitura: o banco vai para a pasta temporária (/tmp),
// que é apagada sempre que a Vercel recicla o servidor. Lá o site funciona só como vitrine de teste.
const DATA_DIR = process.env.DATA_DIR
  || (process.env.VERCEL ? path.join(require('os').tmpdir(), 'ofertas-do-gp') : path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'ofertas.db');
const db = new DatabaseSync(DB_PATH);

// Estrutura atual da tabela de usuários do site (também usada para migrar bancos antigos).
const USER_DATA_COLUMNS = [
  'cpf', 'data_nascimento', 'telefone',
  'cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf',
  'razao_social', 'inscricao_estadual', 'telefone_empresa', 'ramo', 'site_empresa',
  'emp_cep', 'emp_logradouro', 'emp_numero', 'emp_complemento', 'emp_bairro', 'emp_cidade', 'emp_uf',
  'aceite_termos_em',
];
const USERS_COLUMNS = `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT CHECK (tipo IS NULL OR tipo IN ('consumidor', 'empresa', 'afiliado')),
    nome TEXT,
    email TEXT NOT NULL UNIQUE,
    senha_hash TEXT,
    google_id TEXT UNIQUE,
    avatar_url TEXT,
    empresa_nome TEXT,
    cnpj TEXT,
    status TEXT NOT NULL DEFAULT 'onboarding'
      CHECK (status IN ('onboarding', 'pending', 'active', 'suspended', 'banned', 'rejected')),
    status_motivo TEXT,
    suspenso_ate TEXT,
    bloqueio_publicacao INTEGER NOT NULL DEFAULT 0,
    pode_postar INTEGER NOT NULL DEFAULT 0,
    plano TEXT,
    assinatura_ate TEXT,
    cliente_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT,
    ${USER_DATA_COLUMNS.map(c => `${c} TEXT`).join(',\n    ')}
`;

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  -- WAL + NORMAL: o banco não se corrompe nem se o programa cair; só uma queda de energia pode perder as últimas
  -- gravações. Com FULL, cada oferta gravada esperava o disco (~2 ms), e a mineração travava o site por segundos.
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL,
    store_product_id TEXT NOT NULL,
    plataforma TEXT NOT NULL,
    produto TEXT NOT NULL,
    preco_atual REAL NOT NULL,
    preco_anterior REAL NOT NULL,
    desconto_pct INTEGER NOT NULL,
    categoria TEXT,
    imagem TEXT,
    original_url TEXT NOT NULL,
    affiliate_url TEXT,
    aff_fixed INTEGER NOT NULL DEFAULT 0,
    fonte TEXT NOT NULL DEFAULT 'auto',
    oculto INTEGER NOT NULL DEFAULT 0,
    link_clicks INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,
    UNIQUE (store_id, store_product_id)
  );
  CREATE INDEX IF NOT EXISTS idx_offers_seen ON offers (last_seen_at);

  CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
    price REAL NOT NULL,
    checked_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_history_offer ON price_history (offer_id);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS store_status (
    store_id TEXT PRIMARY KEY,
    status TEXT,
    message TEXT,
    found INTEGER DEFAULT 0,
    saved INTEGER DEFAULT 0,
    last_run_at TEXT,
    last_success_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  -- Usuários do site (consumidores e empresas). Não têm acesso ao painel /admin.
  -- tipo fica vazio até a pessoa escolher o perfil no primeiro acesso (status 'onboarding').
  CREATE TABLE IF NOT EXISTS users (${USERS_COLUMNS});

  CREATE TABLE IF NOT EXISTS user_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  -- Loja de uma empresa dentro do site
  CREATE TABLE IF NOT EXISTS lojas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    nome TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    descricao TEXT,
    logo_url TEXT,
    site_url TEXT,
    feed_url TEXT,
    feed_tipo TEXT,
    feed_status TEXT,
    feed_mensagem TEXT,
    feed_ultima_sync TEXT,
    oculta INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS moderation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    user_email TEXT,
    acao TEXT NOT NULL,
    detalhe TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS blocked_emails (
    email TEXT PRIMARY KEY,
    motivo TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migrações simples: colunas adicionadas depois da primeira versão.
const offerColumns = db.prepare('PRAGMA table_info(offers)').all().map(c => c.name);
if (!offerColumns.includes('subcategoria')) db.exec('ALTER TABLE offers ADD COLUMN subcategoria TEXT');
// Comissão de afiliado informada pela API da loja (Shopee/AliExpress), em %: a total e a extra paga pelo vendedor
if (!offerColumns.includes('comissao_pct')) db.exec('ALTER TABLE offers ADD COLUMN comissao_pct REAL');
if (!offerColumns.includes('comissao_extra_pct')) db.exec('ALTER TABLE offers ADD COLUMN comissao_extra_pct REAL');
// Cupom de desconto do produto (KaBuM!, Magalu): preco_atual já é o preço com o cupom
if (!offerColumns.includes('cupom_codigo')) db.exec('ALTER TABLE offers ADD COLUMN cupom_codigo TEXT');
if (!offerColumns.includes('cupom_texto')) db.exec('ALTER TABLE offers ADD COLUMN cupom_texto TEXT');
if (!offerColumns.includes('preco_sem_cupom')) db.exec('ALTER TABLE offers ADD COLUMN preco_sem_cupom REAL');
if (!offerColumns.includes('loja_id')) {
  db.exec('ALTER TABLE offers ADD COLUMN loja_id INTEGER REFERENCES lojas(id) ON DELETE CASCADE');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_offers_loja ON offers (loja_id)');
// Painel: cupons em Mineração e cliques/novidades no resumo, sem percorrer a tabela inteira a cada abertura.
// Parciais: guardam só as poucas ofertas com cupom ou com clique, sem pesar na gravação das demais.
db.exec(`CREATE INDEX IF NOT EXISTS idx_offers_cupom ON offers (store_id, cupom_codigo) WHERE cupom_codigo IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_offers_cliques ON offers (link_clicks) WHERE link_clicks > 0;
  CREATE INDEX IF NOT EXISTS idx_offers_created ON offers (created_at);`);

// Bancos antigos: a tabela de usuários exigia tipo e senha (e depois não aceitava o perfil afiliado).
// Recria com a estrutura nova copiando os dados.
const usersSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'`).get()?.sql || '';
if (!usersSql.includes("'afiliado'")) {
  const oldCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE users_new (${USERS_COLUMNS})`);
    const newCols = db.prepare('PRAGMA table_info(users_new)').all().map(c => c.name);
    const common = oldCols.filter(c => newCols.includes(c)).join(', ');
    db.exec(`INSERT INTO users_new (${common}) SELECT ${common} FROM users`);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
// Permissão dada pelo admin para o usuário usar a tela de postagens nas redes sociais.
if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'pode_postar')) {
  db.exec('ALTER TABLE users ADD COLUMN pode_postar INTEGER NOT NULL DEFAULT 0');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_cpf ON users (cpf) WHERE cpf IS NOT NULL');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_cnpj ON users (cnpj) WHERE cnpj IS NOT NULL');

// Detalhes dos anúncios criados pelas empresas (1 para 1 com a oferta)
db.exec(`
  CREATE TABLE IF NOT EXISTS ad_details (
    offer_id INTEGER PRIMARY KEY REFERENCES offers(id) ON DELETE CASCADE,
    descricao TEXT,
    marca TEXT,
    modelo TEXT,
    condicao TEXT,
    garantia TEXT,
    parcelamento TEXT,
    frete TEXT,
    frete_valor REAL,
    prazo_entrega TEXT,
    estoque INTEGER,
    sku TEXT,
    ean TEXT,
    cupom_codigo TEXT,
    cupom_descricao TEXT,
    whatsapp TEXT,
    imagens TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Publicidade: campanhas de empresas que contrataram espaço no site e pedidos de contato.
db.exec(`
  CREATE TABLE IF NOT EXISTS banners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anunciante TEXT NOT NULL,
    contato TEXT,
    espaco TEXT NOT NULL,
    link TEXT NOT NULL,
    imagem TEXT NOT NULL,
    imagem_mobile TEXT,
    texto_alt TEXT,
    inicio TEXT NOT NULL,
    fim TEXT NOT NULL,
    ativo INTEGER NOT NULL DEFAULT 1,
    impressoes INTEGER NOT NULL DEFAULT 0,
    cliques INTEGER NOT NULL DEFAULT 0,
    observacoes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_banners_espaco ON banners (espaco, ativo);

  CREATE TABLE IF NOT EXISTS ad_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    empresa TEXT NOT NULL,
    email TEXT NOT NULL,
    telefone TEXT,
    espaco TEXT,
    mensagem TEXT,
    status TEXT NOT NULL DEFAULT 'novo',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Histórico das postagens automáticas nas redes sociais.
db.exec(`
  CREATE TABLE IF NOT EXISTS social_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id INTEGER,
    produto TEXT,
    rede TEXT NOT NULL,
    ok INTEGER NOT NULL,
    mensagem TEXT,
    autor TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_social_posts_offer ON social_posts (offer_id);

  -- Fila das postagens agendadas (3 vezes por dia)
  CREATE TABLE IF NOT EXISTS post_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id INTEGER NOT NULL,
    texto TEXT,
    autor TEXT,
    status TEXT NOT NULL DEFAULT 'pendente',
    resultado TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    posted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_post_queue_status ON post_queue (status, id);
`);

// Clientes da ferramenta (acesso vendido): painel próprio, links de afiliado e canais próprios.
db.exec(`
  CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    senha_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo', 'bloqueado')),
    validade TEXT NOT NULL,
    observacoes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );
  CREATE TABLE IF NOT EXISTS cliente_sessions (
    token_hash TEXT PRIMARY KEY,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cliente_config (
    cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (cliente_id, key)
  );
  -- Links de comissão gerados pela API (AliExpress/Shopee) com as chaves do cliente.
  CREATE TABLE IF NOT EXISTS cliente_links (
    cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    offer_id INTEGER NOT NULL,
    chave TEXT NOT NULL,
    link TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (cliente_id, offer_id)
  );
`);
for (const t of ['social_posts', 'post_queue']) {
  if (!db.prepare(`PRAGMA table_info(${t})`).all().some(c => c.name === 'cliente_id')) {
    db.exec(`ALTER TABLE ${t} ADD COLUMN cliente_id INTEGER`);
  }
}

// Assinaturas pagas (planos): validade da assinatura nas contas do site e pedidos de pagamento.
{
  const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!userCols.includes('plano')) db.exec('ALTER TABLE users ADD COLUMN plano TEXT');
  if (!userCols.includes('assinatura_ate')) db.exec('ALTER TABLE users ADD COLUMN assinatura_ate TEXT');
  // Loja parceira: 'pj' (empresa com CNPJ) ou 'pf' (pessoa física vendendo com CPF)
  if (!userCols.includes('empresa_tipo')) db.exec('ALTER TABLE users ADD COLUMN empresa_tipo TEXT');
}
db.exec(`
  CREATE TABLE IF NOT EXISTS pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    plano TEXT NOT NULL,
    valor REAL NOT NULL,
    dias INTEGER NOT NULL,
    metodo TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'aprovado', 'recusado', 'cancelado', 'expirado')),
    email TEXT NOT NULL,
    nome TEXT,
    dados TEXT NOT NULL,
    mp_payment_id TEXT,
    mp_preference_id TEXT,
    pix_qr TEXT,
    pix_qr_base64 TEXT,
    pix_expira TEXT,
    conta_tipo TEXT,
    conta_id INTEGER,
    validade_ate TEXT,
    login_entregue INTEGER NOT NULL DEFAULT 0,
    email_enviado INTEGER NOT NULL DEFAULT 0,
    observacao TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    aprovado_em TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pagamentos_status ON pagamentos (status, created_at);
`);

// Vídeo (sem som) nos banners de publicidade; a imagem continua obrigatória como capa.
const bannerCols = db.prepare('PRAGMA table_info(banners)').all().map(c => c.name);
if (!bannerCols.includes('video')) db.exec('ALTER TABLE banners ADD COLUMN video TEXT');
if (!bannerCols.includes('video_mobile')) db.exec('ALTER TABLE banners ADD COLUMN video_mobile TEXT');

// Perfis (estilo Steam) de todos que acessam o site: contas (u:<id>), clientes avulsos (c:<id>) e o admin.
db.exec(`
  CREATE TABLE IF NOT EXISTS perfis (
    dono TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    nome TEXT,
    titulo TEXT,
    bio TEXT,
    cidade TEXT,
    avatar TEXT,
    capa TEXT,
    cor TEXT,
    moldura TEXT,
    links TEXT,
    vitrine TEXT,
    oculto INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Contadores usados pelas conquistas (idas à loja, cliques nos links do afiliado...)
  CREATE TABLE IF NOT EXISTS metricas (
    dono TEXT NOT NULL,
    chave TEXT NOT NULL,
    valor INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (dono, chave)
  );
  CREATE TABLE IF NOT EXISTS conquistas_obtidas (
    dono TEXT NOT NULL,
    conquista TEXT NOT NULL,
    obtida_em TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (dono, conquista)
  );
  -- Vendas e compras confirmadas pelo admin (relatórios dos programas de afiliados / da loja)
  CREATE TABLE IF NOT EXISTS vendas_registro (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dono TEXT NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('afiliado', 'empresa', 'compra')),
    quantidade INTEGER NOT NULL,
    observacao TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_vendas_registro_dono ON vendas_registro (dono);
  -- Quem segue quem (donos de perfil: 'u:<id>', 'c:<id>' ou 'admin')
  CREATE TABLE IF NOT EXISTS seguidores (
    seguidor TEXT NOT NULL,
    seguido TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (seguidor, seguido)
  );
  CREATE INDEX IF NOT EXISTS idx_seguidores_seguido ON seguidores (seguido);
`);

// Plano assinado pelo cliente da ferramenta (os planos agora são criados no painel)
if (!db.prepare('PRAGMA table_info(clientes)').all().some(c => c.name === 'plano')) db.exec('ALTER TABLE clientes ADD COLUMN plano TEXT');

const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Consultas preparadas uma vez e reaproveitadas (preparar de novo a cada chamada custava tempo na mineração)
const preparadas = new Map();
function preparada(sql) {
  let st = preparadas.get(sql);
  if (!st) {
    if (preparadas.size >= 800) preparadas.clear(); // consultas montadas na hora (listas IN de tamanhos variados)
    st = db.prepare(sql);
    preparadas.set(sql, st);
  }
  return st;
}
const all = (sql, ...params) => preparada(sql).all(...params);
const get = (sql, ...params) => preparada(sql).get(...params);
const run = (sql, ...params) => preparada(sql).run(...params);

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, all, get, run, transaction, DB_PATH, UPLOADS_DIR };
