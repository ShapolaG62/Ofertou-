// API própria de WhatsApp: conecta o número direto do servidor (biblioteca Baileys). É a única forma de envio do site.
// Cada dono tem a própria conexão: o site ('site') e cada cliente da ferramenta ('c:<id>').
//  • Conectar: o painel mostra o QR code; a sessão fica em data/ e volta sozinha ao religar o site.
//  • Conversas: nome e foto dos contatos e dos grupos. Só as mensagens novas têm o texto guardado (30 dias); o histórico antigo não.
//  • Grupos para postar: os que este número administra (criados por ele ou em que outra pessoa o fez administrador).
//    As mensagens só ficam guardadas dos grupos que ele criou e administra.
//  • Enviar: uma mensagem por vez, com pelo menos 3 segundos entre elas.
// Não é a API oficial do WhatsApp: o número pode ser banido. A pasta da sessão dá acesso à conta: nunca copie nem compartilhe.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const db = require('./db');
const net = require('./net');

const RAIZ = path.dirname(db.DB_PATH);
const DIAS_GUARDADOS = 30;
const LIMITE_ENVIO_MS = 45000;
const IDADE_MAX_COMANDO_S = 300; // comando que chegou enquanto o site estava fora do ar e já ficou velho não é executado
const FOTO_VALIDADE_MS = 24 * 3600000;
let intervaloEnvio = 3000;
let intervaloFoto = 300;

// Tabela criada na primeira versão, de um dono só: passa a ter o dono
db.db.exec(`
  CREATE TABLE IF NOT EXISTS whatsapp_mensagens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dono TEXT NOT NULL DEFAULT 'site',
    wa_id TEXT NOT NULL,
    chat TEXT NOT NULL,
    chat_nome TEXT,
    de_mim INTEGER NOT NULL DEFAULT 0,
    autor TEXT,
    tipo TEXT NOT NULL DEFAULT 'texto',
    texto TEXT,
    criado_em TEXT NOT NULL
  );
`);
if (!db.all('PRAGMA table_info(whatsapp_mensagens)').some(c => c.name === 'dono')) {
  db.db.exec(`ALTER TABLE whatsapp_mensagens ADD COLUMN dono TEXT NOT NULL DEFAULT 'site'`);
}
// Remetente em grupo, situação de entrega e os dados para baixar a mídia (só a referência, nunca o arquivo)
for (const [coluna, tipo] of [['participante', 'TEXT'], ['entrega', 'TEXT'], ['bruta', 'TEXT']]) {
  if (!db.all('PRAGMA table_info(whatsapp_mensagens)').some(c => c.name === coluna)) db.db.exec(`ALTER TABLE whatsapp_mensagens ADD COLUMN ${coluna} ${tipo}`);
}
db.db.exec(`
  DROP INDEX IF EXISTS idx_whatsapp_msg_unica;
  DROP INDEX IF EXISTS idx_whatsapp_msg_chat;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_msg_dono_unica ON whatsapp_mensagens (dono, chat, wa_id);
  CREATE INDEX IF NOT EXISTS idx_whatsapp_msg_dono_chat ON whatsapp_mensagens (dono, chat, id);
  CREATE TABLE IF NOT EXISTS whatsapp_contatos (
    dono TEXT NOT NULL,
    jid TEXT NOT NULL,
    nome TEXT,
    numero TEXT,
    conversa INTEGER NOT NULL DEFAULT 0,
    meu_grupo INTEGER,
    ultima_em TEXT,
    foto_arquivo TEXT,
    foto_em INTEGER,
    PRIMARY KEY (dono, jid)
  );
  CREATE INDEX IF NOT EXISTS idx_whatsapp_contatos_conversa ON whatsapp_contatos (dono, conversa, ultima_em);
  CREATE TABLE IF NOT EXISTS whatsapp_webhooks (dono TEXT PRIMARY KEY, url TEXT NOT NULL, segredo TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS whatsapp_ajustes (dono TEXT PRIMARY KEY, valores TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS whatsapp_etiquetas (dono TEXT NOT NULL, id TEXT NOT NULL, nome TEXT, cor INTEGER, PRIMARY KEY (dono, id));
`);

const log = (dono, m) => console.log(`[WHATSAPP ${dono}] ${m}`);
const falhou = (mensagem, status = 400) => Object.assign(new Error(mensagem), { status });
const donoDe = cid => (cid ? `c:${Number(cid)}` : 'site');
const cidDe = dono => (dono === 'site' ? null : Number(String(dono).slice(2)));
function validarDono(dono) {
  if (!/^(site|c:\d+)$/.test(String(dono))) throw falhou('Dono inválido.');
  return dono;
}
const pedaco = dono => (dono === 'site' ? '' : `-c${cidDe(dono)}`);
const pastaSessao = dono => path.join(RAIZ, `whatsapp-sessao${pedaco(dono)}`);
const pastaFotos = dono => path.join(RAIZ, `whatsapp-fotos${pedaco(dono)}`);

// ── Conversão de endereços e mensagens ──────────────────────────────────────
// Aceita o id em qualquer formato salvo antes ("120…-group", "120…@g.us") ou o número com DDI
function paraJid(id) {
  const t = String(id || '').trim();
  if (/^[\w.:-]+@(g\.us|s\.whatsapp\.net|lid)$/.test(t)) return t;
  if (/^\d[\d-]*-group$/.test(t)) return `${t.replace(/-group$/, '')}@g.us`;
  if (/^\d+-\d+$/.test(t)) return `${t}@g.us`; // grupo antigo: criador-data
  const d = t.replace(/\D/g, '');
  if (/^120\d{15,}$/.test(d)) return `${d}@g.us`;
  if (/^\d{10,15}$/.test(d)) return `${d}@s.whatsapp.net`;
  throw falhou('Destino inválido: informe o id do grupo ou o número com DDI e DDD.');
}
// "5511…:7@s.whatsapp.net" → "5511…@s.whatsapp.net"
const semAparelho = j => String(j || '').replace(/:\d+@/, '@');
const conversaValida = j => /@(g\.us|s\.whatsapp\.net|lid)$/.test(String(j || ''));

const EMBRULHOS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'editedMessage'];
const TIPOS = {
  conversation: 'texto', extendedTextMessage: 'texto', imageMessage: 'imagem', videoMessage: 'video', audioMessage: 'audio',
  documentMessage: 'documento', stickerMessage: 'figurinha', contactMessage: 'contato', contactsArrayMessage: 'contato',
  locationMessage: 'localizacao', liveLocationMessage: 'localizacao', pollCreationMessage: 'enquete', pollCreationMessageV3: 'enquete',
  // Mensagens com botões (comuns em grupos de ofertas que postam por robô)
  buttonsMessage: 'texto', templateMessage: 'texto', interactiveMessage: 'texto', listMessage: 'texto',
};
// Texto da mensagem, incluindo o das mensagens com botões e os links dos botões
function textoDe(c) {
  const t = c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption || c.documentMessage?.caption
    || c.buttonsMessage?.contentText || c.templateMessage?.hydratedTemplate?.hydratedContentText || c.templateMessage?.hydratedFourRowTemplate?.hydratedContentText
    || c.interactiveMessage?.body?.text || c.listMessage?.description || '';
  const extra = [];
  const legenda = c.buttonsMessage?.imageMessage?.caption || c.interactiveMessage?.header?.imageMessage?.caption;
  if (legenda && !t.includes(legenda)) extra.push(legenda);
  for (const b of c.interactiveMessage?.nativeFlowMessage?.buttons || []) {
    try { const p = JSON.parse(b.buttonParamsJson || '{}'); if (p.url && !t.includes(p.url)) extra.push(p.url); } catch { /* botão sem link */ }
  }
  for (const b of c.templateMessage?.hydratedTemplate?.hydratedButtons || []) if (b.urlButton?.url && !t.includes(b.urlButton.url)) extra.push(b.urlButton.url);
  return [t, ...extra].filter(Boolean).join('\n');
}
function desembrulhar(m) {
  let atual = m;
  for (let i = 0; i < 5 && atual; i++) {
    const k = EMBRULHOS.find(x => atual[x]?.message);
    if (!k) break;
    atual = atual[k].message;
  }
  return atual || null;
}
const segundos = v => Number(v?.toNumber ? v.toNumber() : v) || 0;
const dataSql = s => new Date((s || Date.now() / 1000) * 1000).toISOString().replace('T', ' ').slice(0, 19);

// Mensagem do WhatsApp → formato do site (ou nulo: status, canais, reações e avisos internos não entram)
const TIPOS_COM_ARQUIVO = ['imagem', 'video', 'audio', 'documento', 'figurinha'];
function lerMensagem(m, serializar = null) {
  const chat = m?.key?.remoteJid;
  if (!chat || !m.key.id || /@(broadcast|newsletter)$/.test(chat)) return null;
  const c = desembrulhar(m.message);
  const chaveTipo = c && Object.keys(TIPOS).find(k => c[k]);
  if (!chaveTipo) return null;
  const texto = textoDe(c);
  return {
    wa_id: String(m.key.id), chat, de_mim: m.key.fromMe ? 1 : 0, autor: m.key.fromMe ? null : (m.pushName || null),
    tipo: TIPOS[chaveTipo], texto, segundos: segundos(m.messageTimestamp), participante: m.key.participant || null,
    bruta: TIPOS_COM_ARQUIVO.includes(TIPOS[chaveTipo]) && serializar ? serializar(m) : null,
  };
}

// ── Contatos e grupos conhecidos ────────────────────────────────────────────
function guardarContato(dono, jid, { nome = null, numero = null, conversa = 0, ultima = null, meuGrupo = null } = {}) {
  if (!conversaValida(jid)) return;
  db.run(`INSERT INTO whatsapp_contatos (dono, jid, nome, numero, conversa, ultima_em, meu_grupo) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (dono, jid) DO UPDATE SET nome = COALESCE(excluded.nome, nome), numero = COALESCE(excluded.numero, numero),
      conversa = MAX(conversa, excluded.conversa), ultima_em = COALESCE(excluded.ultima_em, ultima_em), meu_grupo = COALESCE(excluded.meu_grupo, meu_grupo)`,
  dono, jid, nome || null, numero || null, conversa, ultima, meuGrupo);
}
const nomeDoContato = c => c?.name || c?.notify || c?.verifiedName || null;

// ── Fábrica do socket de verdade ────────────────────────────────────────────
let fabrica = criarSocketReal;
async function criarSocketReal(dono) {
  const b = await import('baileys');
  const pasta = pastaSessao(dono);
  fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
  const { state, saveCreds } = await b.useMultiFileAuthState(pasta);
  const logger = { level: 'silent', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
  const { version } = await b.fetchLatestWaWebVersion({}).catch(() => ({}));
  const socket = b.default({
    auth: { creds: state.creds, keys: b.makeCacheableSignalKeyStore(state.keys, logger) },
    ...(version ? { version } : {}),
    browser: b.Browsers.windows('Ofertou'),
    logger,
    syncFullHistory: false, // lista de conversas e nomes, sem baixar o histórico completo
    markOnlineOnConnect: false, // o celular continua recebendo as notificações normalmente
    getMessage: async () => undefined,
  });
  return {
    sock: socket, saveCreds, pareado: () => Boolean(state.creds.me), gerarId: () => b.generateMessageIDV2(socket.user?.id),
    // Referência para baixar a mídia depois, sem miniatura nem o resto da conversa citada
    serializar: m => JSON.stringify({ key: m.key, message: m.message, messageTimestamp: m.messageTimestamp }, (k, v) => (k === 'jpegThumbnail' || k === 'contextInfo' ? undefined : b.BufferJSON.replacer(k, v))),
    baixar: texto => b.downloadMediaMessage(JSON.parse(texto, b.BufferJSON.reviver), 'buffer', {}, { logger, reuploadRequest: socket.updateMediaMessage }),
  };
}

// ── Uma conexão ─────────────────────────────────────────────────────────────
class Conexao {
  constructor(dono) {
    this.dono = dono;
    this.estado = { fase: 'desligado', qr: null, numero: null, nome: null, erro: null, desde: null };
    this.sock = null;
    this.geracao = 0; // conexões antigas que ainda dispararem eventos são ignoradas
    this.tentativas = 0;
    this.timerVolta = null;
    this.abrindo = false;
    this.grupos = null;
    this.gerarId = null;
    this.serializar = null;
    this.baixar = null;
    this.timerOnline = null;
    this.saidas = new Set(); // ids das mensagens que esta API enviou: o que chegar de volta com esse id não é comando
    this.filaEnvio = Promise.resolve();
    this.ultimoEnvio = 0;
    this.filaFoto = Promise.resolve();
  }
  mudar(novo) {
    const antes = this.estado.fase;
    this.estado = { ...this.estado, ...novo };
    if (this.estado.fase !== antes) emitir(this.dono, 'conexao', { fase: this.estado.fase, erro: this.estado.erro });
  }
  fecharSocket() {
    clearTimeout(this.timerVolta);
    clearInterval(this.timerOnline);
    const s = this.sock;
    this.sock = null;
    this.grupos = null;
    try { s?.ev?.removeAllListeners?.(); s?.end?.(undefined); } catch { /* já estava fechado */ }
  }
  async abrir() {
    if (this.abrindo) return;
    this.abrindo = true;
    const minha = ++this.geracao;
    this.fecharSocket();
    this.mudar({ fase: 'conectando', qr: null });
    try {
      const criado = await fabrica(this.dono);
      if (minha !== this.geracao) { try { criado.sock.end?.(undefined); } catch { /* ignorado */ } return; }
      this.sock = criado.sock;
      this.gerarId = criado.gerarId || null;
      this.serializar = criado.serializar || null;
      this.baixar = criado.baixar || null;
      this.ouvir(criado, minha);
    } catch (err) {
      if (minha === this.geracao) { log(this.dono, `não abriu: ${err.message}`); this.mudar({ fase: 'desligado', erro: `Não foi possível abrir a conexão: ${err.message}` }); }
    } finally { this.abrindo = false; }
  }
  ouvir({ sock: s, saveCreds, pareado }, minha) {
    const vale = fn => (...a) => { if (minha !== this.geracao) return undefined; try { return fn(...a); } catch (err) { log(this.dono, err.message); return undefined; } };
    s.ev.on('creds.update', saveCreds);
    s.ev.on('connection.update', vale(u => { this.aoAtualizar(u, s, pareado).catch(err => log(this.dono, `erro na conexão: ${err.message}`)); }));
    s.ev.on('messages.upsert', vale(({ messages, type }) => { for (const m of messages || []) this.receber(m, type); }));
    s.ev.on('messaging-history.set', vale(({ chats, contacts }) => this.guardarLista(chats, contacts)));
    s.ev.on('chats.upsert', vale(chats => this.guardarLista(chats, [])));
    s.ev.on('contacts.upsert', vale(c => this.guardarLista([], c)));
    s.ev.on('contacts.update', vale(c => this.guardarLista([], c)));
    s.ev.on('messages.update', vale(lista => this.aoMudarEntrega(lista)));
    s.ev.on('call', vale(chamadas => { for (const c of chamadas || []) this.aoReceberChamada(c); }));
    s.ev.on('labels.edit', vale(e => {
      if (e.deleted) db.run('DELETE FROM whatsapp_etiquetas WHERE dono = ? AND id = ?', this.dono, String(e.id));
      else db.run(`INSERT INTO whatsapp_etiquetas (dono, id, nome, cor) VALUES (?, ?, ?, ?) ON CONFLICT (dono, id) DO UPDATE SET nome = excluded.nome, cor = excluded.cor`, this.dono, String(e.id), e.name || null, e.color ?? null);
    }));
    s.ev.on('groups.update', vale(() => { this.grupos = null; }));
    s.ev.on('groups.upsert', vale(() => { this.grupos = null; this.carregarGrupos().catch(() => {}); }));
    s.ev.on('group-participants.update', vale(ev => {
      this.grupos = null;
      require('./membros-grupo').receber(cidDe(this.dono), { event: 'group-participants.update', data: ev });
      emitir(this.dono, 'grupo', { id: ev.id, acao: ev.action, quantidade: ev.participants?.length || 0 });
    }));
  }
  async aoAtualizar({ connection, qr, lastDisconnect }, s, pareado) {
    if (qr) this.mudar({ fase: 'qr', qr: await QRCode.toDataURL(qr, { width: 320, margin: 2 }), erro: null });
    if (connection === 'open') {
      this.tentativas = 0;
      const id = String(s.user?.id || '');
      this.mudar({ fase: 'conectado', qr: null, erro: null, numero: id.split(/[:@]/)[0] || null, nome: s.user?.name || null, desde: new Date().toISOString() });
      log(this.dono, 'conectado');
      this.carregarGrupos().catch(err => log(this.dono, `grupos: ${err.message}`)); // nomes e quais são deste número
      this.aplicarAjustes();
    }
    if (connection === 'close') this.aoFechar(lastDisconnect?.error?.output?.statusCode, pareado);
  }
  aoFechar(codigo, pareado) {
    this.sock = null;
    this.grupos = null;
    const parar = erro => { this.mudar({ fase: 'desligado', qr: null, erro }); log(this.dono, `parado (${codigo}): ${erro}`); };
    if (codigo === 401) {
      apagarSessao(this.dono);
      this.mudar({ numero: null, nome: null });
      return parar('O WhatsApp desconectou este aparelho. Clique em Conectar e leia o QR code de novo.');
    }
    if (codigo === 403) return parar('O WhatsApp recusou este número (pode ter sido bloqueado). Confira o aplicativo no celular antes de tentar de novo.');
    if (codigo === 440) return parar('Esta sessão foi aberta em outro lugar. Feche a outra conexão e clique em Conectar.');
    if (!pareado()) return parar('O QR code venceu. Clique em Conectar para gerar outro.');
    if (codigo === 515) return void this.abrir(); // pedido normal do WhatsApp logo depois de ler o QR code
    this.tentativas++;
    const espera = Math.min(5000 * 2 ** (this.tentativas - 1), 300000);
    this.mudar({ fase: 'reconectando', erro: `Conexão caiu (${codigo || 'sem código'}). Tentando de novo em ${Math.round(espera / 1000)} s.` });
    log(this.dono, `caiu (${codigo}); nova tentativa em ${espera / 1000} s`);
    this.timerVolta = setTimeout(() => this.abrir(), espera);
    this.timerVolta.unref?.();
  }

  // Lista de conversas e nomes que o WhatsApp manda ao conectar. As mensagens antigas não são guardadas.
  guardarLista(chats = [], contatos = []) {
    db.transaction(() => {
      for (const c of (contatos || []).slice(0, 5000)) {
        const numero = /@s\.whatsapp\.net$/.test(c.phoneNumber || c.id || '') ? String(c.phoneNumber || c.id).split('@')[0] : null;
        guardarContato(this.dono, c.id, { nome: nomeDoContato(c), numero });
      }
      for (const c of (chats || []).slice(0, 2000)) {
        const s = segundos(c.conversationTimestamp || c.lastMessageRecvTimestamp);
        guardarContato(this.dono, c.id, { nome: c.name, conversa: 1, ultima: s ? dataSql(s) : null });
      }
    });
  }

  // ── Ajustes do número ──
  aplicarAjustes() {
    clearInterval(this.timerOnline);
    const a = lerAjustes(this.dono);
    const s = this.sock;
    if (!s) return;
    if (a.sempre_online) {
      const avisar = () => this.sock?.sendPresenceUpdate?.('available').catch(() => {});
      avisar();
      this.timerOnline = setInterval(avisar, 60000);
      this.timerOnline.unref?.();
    } else s.sendPresenceUpdate?.('unavailable').catch(() => {});
  }
  aoReceberChamada(c) {
    emitir(this.dono, 'chamada', { de: c.from, video: Boolean(c.isVideo), situacao: c.status });
    if (c.status !== 'offer') return;
    const a = lerAjustes(this.dono);
    if (!a.rejeitar_chamadas) return;
    this.sock?.rejectCall?.(c.id, c.from).catch(err => log(this.dono, `chamada: ${err.message}`));
    if (a.mensagem_chamada) this.enviar(c.from, { texto: a.mensagem_chamada }).catch(err => log(this.dono, `chamada: ${err.message}`));
  }
  aoMudarEntrega(lista) {
    for (const { key, update } of lista || []) {
      const entrega = ENTREGA[update?.status];
      if (!entrega || !key?.remoteJid || !key.id) continue;
      if (db.run('UPDATE whatsapp_mensagens SET entrega = ? WHERE dono = ? AND chat = ? AND wa_id = ?', entrega, this.dono, key.remoteJid, key.id).changes) {
        emitir(this.dono, 'entrega', { chat: key.remoteJid, id: key.id, entrega });
      }
    }
  }

  // ── Mensagens recebidas ──
  receber(bruta, tipoEvento) {
    const ajustes = lerAjustes(this.dono);
    if (bruta?.key?.remoteJid === 'status@broadcast') {
      if (ajustes.ler_status && !bruta.key.fromMe) this.sock?.readMessages?.([bruta.key]).catch(() => {});
      return;
    }
    const m = lerMensagem(bruta, this.serializar);
    if (!m) {
      // Chegou sem conteúdo (a chave do grupo ainda não veio): a repostagem mostra isso no registro
      const k = bruta?.key;
      if (bruta?.messageStubType === 2 && !k?.fromMe && String(k?.remoteJid || '').endsWith('@g.us')) require('./repostar-grupos').naoLida(cidDe(this.dono), k.remoteJid, k.id);
      return;
    }
    const ehGrupo = m.chat.endsWith('@g.us');
    const meu = !ehGrupo || db.get('SELECT meu_grupo FROM whatsapp_contatos WHERE dono = ? AND jid = ?', this.dono, m.chat)?.meu_grupo === 1;
    let nova = true;
    if (meu) { // de grupos de outras pessoas, nada fica guardado
      guardarContato(this.dono, m.chat, { nome: !ehGrupo && !m.de_mim ? m.autor : null, conversa: 1, ultima: dataSql(m.segundos) });
      nova = salvar(this.dono, m);
      if (nova && ajustes.ler_mensagens && tipoEvento === 'notify' && !m.de_mim) this.sock?.readMessages?.([bruta.key]).catch(() => {});
      if (nova) emitir(this.dono, 'mensagem', { chat: m.chat, de_mim: Boolean(m.de_mim), autor: m.autor, tipo: m.tipo, texto: m.texto, id: m.wa_id, em: dataSql(m.segundos) });
    }
    // Repostar de outros grupos: só ofertas novas dos grupos de origem escolhidos (nada delas fica guardado)
    // 'append': mensagens que chegaram enquanto a conexão caiu (a idade é conferida lá)
    if (ehGrupo && (tipoEvento === 'notify' || tipoEvento === 'append') && !m.de_mim && !this.saidas.has(m.wa_id)) require('./repostar-grupos').receber(cidDe(this.dono), m);
    // Grupo de automação: comandos só do que chegou agora. O que você digita no celular conta; o que esta API enviou, não.
    if (!nova || tipoEvento !== 'notify' || this.saidas.has(m.wa_id)) return;
    if (m.segundos && Date.now() / 1000 - m.segundos > IDADE_MAX_COMANDO_S) return;
    const ga = require('./grupo-automacao');
    const cid = cidDe(this.dono);
    ga.processar({ cid, s: ga.configDe(cid) }, { grupo: m.chat, texto: m.texto, deMim: false, autor: m.autor || '' })
      .catch(err => log(this.dono, `grupo de automação: ${err.message}`));
  }

  // ── Grupos ──
  exigir() {
    if (this.estado.fase !== 'conectado' || !this.sock) throw falhou('O WhatsApp não está conectado: abra o painel e leia o QR code.', 409);
    return this.sock;
  }
  async carregarGrupos() {
    const s = this.exigir();
    if (this.grupos && Date.now() - this.grupos.em < 300000) return this.grupos.lista;
    const todos = await s.groupFetchAllParticipating();
    const eu = new Set([s.user?.id, s.user?.lid, s.user?.phoneNumber].filter(Boolean).map(semAparelho));
    const lista = Object.values(todos || {}).filter(g => !g.isCommunity).map(g => {
      const participantes = g.participants || [];
      const minha = participantes.find(p => [p.id, p.lid, p.phoneNumber].some(x => x && eu.has(semAparelho(x))));
      const admin = Boolean(minha?.admin || minha?.isAdmin || minha?.isSuperAdmin);
      const criador = [g.owner, g.ownerPn].some(x => x && eu.has(semAparelho(x)));
      return {
        id: g.id, nome: g.subject || g.id, membros: Number.isInteger(g.size) ? g.size : (participantes.length || null),
        // meu: pode postar (é administrador); guardado: as mensagens ficam salvas (criou e administra)
        descricao: g.desc || null, so_admins_falam: Boolean(g.announce), admin, criador, meu: admin, guardado: admin && criador,
      };
    });
    lista.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    db.transaction(() => {
      for (const g of lista) guardarContato(this.dono, g.id, { nome: g.nome, conversa: g.guardado ? 1 : 0, meuGrupo: g.guardado ? 1 : 0 });
      for (const g of lista) if (!g.guardado) db.run('UPDATE whatsapp_contatos SET meu_grupo = 0, conversa = 0 WHERE dono = ? AND jid = ?', this.dono, g.id);
    });
    this.grupos = { em: Date.now(), lista };
    return lista;
  }

  // ── Fotos: guardadas em disco por 24 horas, uma busca de cada vez ──
  foto(jid) {
    const reg = db.get('SELECT foto_arquivo, foto_em FROM whatsapp_contatos WHERE dono = ? AND jid = ?', this.dono, jid);
    const arquivo = reg?.foto_arquivo ? path.join(pastaFotos(this.dono), reg.foto_arquivo) : null;
    const guardada = arquivo && fs.existsSync(arquivo) ? arquivo : null;
    if (reg?.foto_em && Date.now() - reg.foto_em < FOTO_VALIDADE_MS) return Promise.resolve(guardada);
    if (this.estado.fase !== 'conectado' || !this.sock) return Promise.resolve(guardada);
    const vez = this.filaFoto.then(() => this.buscarFoto(jid, guardada));
    this.filaFoto = vez.catch(() => {}).then(() => new Promise(r => setTimeout(r, intervaloFoto)));
    return vez;
  }
  async buscarFoto(jid, guardada) {
    const s = this.sock;
    if (!s) return guardada;
    guardarContato(this.dono, jid, {});
    let url = null;
    try { url = await s.profilePictureUrl(jid, 'image'); } catch { /* sem foto ou sem permissão */ }
    let saida = null, nomeArquivo = null;
    if (url) {
      try {
        const r = await net.safeGet(url, { responseType: 'arraybuffer', timeout: 15000 });
        if (r.status === 200) {
          const jpeg = await require('sharp')(Buffer.from(r.data)).resize(160, 160, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
          fs.mkdirSync(pastaFotos(this.dono), { recursive: true });
          nomeArquivo = `${crypto.createHash('sha1').update(jid).digest('hex')}.jpg`;
          saida = path.join(pastaFotos(this.dono), nomeArquivo);
          fs.writeFileSync(saida, jpeg);
        }
      } catch (err) { log(this.dono, `foto: ${err.message}`); }
    }
    db.run('UPDATE whatsapp_contatos SET foto_arquivo = ?, foto_em = ? WHERE dono = ? AND jid = ?', nomeArquivo, Date.now(), this.dono, jid);
    if (!saida && guardada) { try { fs.unlinkSync(guardada); } catch { /* já não existia */ } }
    return saida;
  }

  // ── Envio: uma mensagem por vez ──
  naFila(tarefa) {
    const vez = this.filaEnvio.then(async () => {
      const espera = this.ultimoEnvio + intervaloEnvio - Date.now();
      if (espera > 0) await new Promise(r => setTimeout(r, espera));
      try { return await tarefa(); } finally { this.ultimoEnvio = Date.now(); }
    });
    this.filaEnvio = vez.catch(() => {});
    return vez;
  }
  async enviar(para, { imagem, texto }) {
    const jid = paraJid(para);
    if (!imagem && !String(texto || '').trim()) throw falhou('Informe o texto ou a foto da mensagem.');
    this.exigir();
    const foto = imagem ? await prepararImagem(imagem) : null;
    return this.enviarConteudo(jid, foto ? { image: foto, caption: texto || '' } : { text: String(texto) });
  }
  // Qualquer tipo de mensagem, pela fila de envio
  enviarConteudo(jid, conteudo, opcoes = {}) {
    this.exigir();
    return this.naFila(async () => {
      const s = this.exigir();
      let destino = jid;
      if (destino.endsWith('@s.whatsapp.net')) { // celular: confere o número (no Brasil, o cadastro pode ser com ou sem o 9)
        const [achado] = await s.onWhatsApp(destino);
        if (!achado?.exists) throw falhou('Esse número não tem WhatsApp.');
        destino = achado.jid;
      }
      const messageId = this.gerarId?.() || `OFW${crypto.randomBytes(9).toString('hex').toUpperCase()}`;
      if (this.saidas.size > 5000) this.saidas.clear();
      this.saidas.add(messageId);
      let limite;
      const r = await Promise.race([
        s.sendMessage(destino, conteudo, { ...opcoes, messageId }),
        new Promise((_, nao) => { limite = setTimeout(() => nao(falhou('O WhatsApp não confirmou o envio a tempo.', 504)), LIMITE_ENVIO_MS); }),
      ]).finally(() => clearTimeout(limite));
      if (r?.key?.id) this.saidas.add(r.key.id);
      const m = destino === 'status@broadcast' ? null : lerMensagem(r, this.serializar);
      if (m) {
        guardarContato(this.dono, m.chat, { conversa: 1, ultima: dataSql(m.segundos) });
        salvar(this.dono, m);
      }
      return r?.key?.id || messageId;
    });
  }
}

const conexoes = new Map();
function conexao(dono) {
  validarDono(dono);
  if (!conexoes.has(dono)) conexoes.set(dono, new Conexao(dono));
  return conexoes.get(dono);
}

function salvar(dono, m) {
  const r = db.run(`INSERT OR IGNORE INTO whatsapp_mensagens (dono, wa_id, chat, chat_nome, de_mim, autor, tipo, texto, criado_em, participante, bruta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    dono, m.wa_id, m.chat, null, m.de_mim, m.autor, m.tipo, m.texto, dataSql(m.segundos), m.participante || null, m.bruta || null);
  return Number(r?.changes ?? 1) > 0;
}
function temSessao(dono) {
  try { return Boolean(JSON.parse(fs.readFileSync(path.join(pastaSessao(dono), 'creds.json'), 'utf8')).me); } catch { return false; }
}
const apagarSessao = dono => fs.rmSync(pastaSessao(dono), { recursive: true, force: true });

async function prepararImagem(imagem) {
  let bruto = imagem;
  if (!Buffer.isBuffer(bruto)) {
    const r = await net.safeGet(String(imagem), { responseType: 'arraybuffer', timeout: 30000 });
    if (r.status !== 200) throw falhou(`Não consegui baixar a foto (erro ${r.status}).`);
    bruto = Buffer.from(r.data);
  }
  // Lojas costumam entregar WebP; o WhatsApp espera JPEG em mensagem de foto
  return require('sharp')(bruto).rotate().resize({ width: 1280, withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
}

// ── Ajustes de cada número ──────────────────────────────────────────────────
const ENTREGA = { 0: 'erro', 1: 'pendente', 2: 'enviada', 3: 'entregue', 4: 'lida', 5: 'reproduzida' };
const AJUSTES_PADRAO = { rejeitar_chamadas: false, mensagem_chamada: '', sempre_online: false, ler_mensagens: false, ler_status: false };
function lerAjustes(dono) {
  let salvos = {};
  try { salvos = JSON.parse(db.get('SELECT valores FROM whatsapp_ajustes WHERE dono = ?', dono)?.valores || '{}'); } catch { /* usa o padrão */ }
  return { ...AJUSTES_PADRAO, ...salvos };
}
function salvarAjustes(dono, novos) {
  validarDono(dono);
  const a = lerAjustes(dono);
  for (const [k, v] of Object.entries(novos || {})) {
    if (!(k in AJUSTES_PADRAO)) throw falhou(`Ajuste desconhecido: ${k}.`);
    a[k] = k === 'mensagem_chamada' ? String(v ?? '').slice(0, 500) : Boolean(v);
  }
  db.run('INSERT INTO whatsapp_ajustes (dono, valores) VALUES (?, ?) ON CONFLICT (dono) DO UPDATE SET valores = excluded.valores', dono, JSON.stringify(a));
  conexao(dono).aplicarAjustes();
  return a;
}

// ── Avisos para outros programas (webhook) ──────────────────────────────────
function emitir(dono, evento, dados) {
  let w;
  try { w = db.get('SELECT url, segredo FROM whatsapp_webhooks WHERE dono = ?', dono); } catch { return; }
  if (!w) return;
  const corpo = JSON.stringify({ evento, em: new Date().toISOString(), dados });
  const assinatura = crypto.createHmac('sha256', w.segredo).update(corpo).digest('hex');
  net.safePost(w.url, corpo, { headers: { 'Content-Type': 'application/json', 'X-Ofertou-Assinatura': `sha256=${assinatura}` }, timeout: 8000 })
    .catch(err => log(dono, `webhook: ${err.message}`));
}
function salvarWebhook(dono, url) {
  validarDono(dono);
  if (!url) { db.run('DELETE FROM whatsapp_webhooks WHERE dono = ?', dono); return { url: null }; }
  const u = net.assertPublicUrl(String(url).trim());
  if (u.protocol !== 'https:') throw falhou('O endereço precisa começar com https://');
  const segredo = crypto.randomBytes(24).toString('hex');
  db.run(`INSERT INTO whatsapp_webhooks (dono, url, segredo) VALUES (?, ?, ?) ON CONFLICT (dono) DO UPDATE SET url = excluded.url, segredo = excluded.segredo`, dono, u.href, segredo);
  return { url: u.href, segredo }; // o segredo só aparece nesta resposta
}
const lerWebhook = dono => ({ url: db.get('SELECT url FROM whatsapp_webhooks WHERE dono = ?', validarDono(dono))?.url || null });

// ── O que o painel e a API usam ─────────────────────────────────────────────
function status(dono) {
  const { estado } = conexao(dono);
  return { ...estado, conectado: estado.fase === 'conectado', sessao_salva: temSessao(dono) };
}
const pronto = dono => status(dono).conectado || temSessao(dono);
async function conectar(dono) {
  const c = conexao(dono);
  if (['conectado', 'qr', 'conectando'].includes(c.estado.fase) && (c.sock || c.abrindo)) return status(dono);
  c.tentativas = 0;
  c.mudar({ erro: null });
  await c.abrir();
  return status(dono);
}
// Sai da conta neste aparelho e apaga do servidor a sessão, as fotos, os contatos e as mensagens guardadas.
async function desconectar(dono) {
  const c = conexao(dono);
  c.geracao++;
  const s = c.sock;
  clearTimeout(c.timerVolta);
  if (s) await Promise.race([s.logout().catch(() => {}), new Promise(r => setTimeout(r, 8000))]);
  c.fecharSocket();
  apagarSessao(dono);
  fs.rmSync(pastaFotos(dono), { recursive: true, force: true });
  db.run('DELETE FROM whatsapp_mensagens WHERE dono = ?', dono);
  db.run('DELETE FROM whatsapp_contatos WHERE dono = ?', dono);
  db.run('DELETE FROM whatsapp_etiquetas WHERE dono = ?', dono);
  c.mudar({ fase: 'desligado', qr: null, numero: null, nome: null, erro: null, desde: null });
  return status(dono);
}
// Fecha a conexão sem sair da conta (acesso do cliente vencido); volta ao renovar e conectar de novo
function fechar(dono, motivo) {
  const c = conexao(dono);
  c.geracao++;
  c.fecharSocket();
  c.mudar({ fase: 'desligado', qr: null, erro: motivo || null });
}
async function reiniciar(dono) {
  const c = conexao(dono);
  if (!temSessao(dono) && !c.sock) throw falhou('Este número ainda não foi conectado.', 409);
  c.tentativas = 0;
  c.mudar({ erro: null });
  await c.abrir();
  return status(dono);
}
// Para as funções extras (src/whatsapp-funcoes.js)
const socket = dono => conexao(dono).exigir();
const enviarConteudo = (dono, jid, conteudo, opcoes) => conexao(dono).enviarConteudo(jid, conteudo, opcoes);
const meuJid = dono => semAparelho(socket(dono).user?.id);
const gruposMudaram = dono => { conexao(dono).grupos = null; };
const linhaMensagem = (dono, chat, id) => db.get('SELECT * FROM whatsapp_mensagens WHERE dono = ? AND chat = ? AND wa_id = ?', dono, chat, id);
const ultimaMensagem = (dono, chat) => db.get('SELECT * FROM whatsapp_mensagens WHERE dono = ? AND chat = ? ORDER BY id DESC LIMIT 1', dono, chat);
const textoEditado = (dono, chat, id, texto) => db.run('UPDATE whatsapp_mensagens SET texto = ? WHERE dono = ? AND chat = ? AND wa_id = ?', texto, dono, chat, id);
const nomeConhecido = (dono, jid) => db.get('SELECT nome FROM whatsapp_contatos WHERE dono = ? AND jid = ?', dono, jid)?.nome || null;
const etiquetas = dono => db.all('SELECT id, nome, cor FROM whatsapp_etiquetas WHERE dono = ? ORDER BY nome', validarDono(dono));
function contatos(dono, { busca = '', limite = 200 } = {}) {
  const lim = Math.min(Math.max(Number(limite) || 200, 1), 5000);
  return db.all(`SELECT jid, nome, numero FROM whatsapp_contatos WHERE dono = ? AND jid NOT LIKE '%@g.us' AND (? = '' OR nome LIKE ? OR numero LIKE ?) ORDER BY nome LIMIT ?`,
    validarDono(dono), String(busca), `%${busca}%`, `%${busca}%`, lim);
}
async function baixarMidia(dono, linha, maximo) {
  const c = conexao(dono);
  c.exigir();
  if (!c.baixar) throw falhou('Download indisponível nesta conexão.', 501);
  const dados = JSON.parse(linha.bruta);
  const conteudo = desembrulhar(dados.message) || {};
  const tipo = Object.keys(conteudo).find(k => /Message$/.test(k) && conteudo[k]?.mimetype);
  const info = conteudo[tipo] || {};
  if (Number(info.fileLength?.low ?? info.fileLength) > maximo) throw falhou(`O arquivo passou de ${Math.round(maximo / 1048576)} MB.`, 413);
  const arquivo = await c.baixar(linha.bruta);
  if (arquivo.length > maximo) throw falhou(`O arquivo passou de ${Math.round(maximo / 1048576)} MB.`, 413);
  return { base64: arquivo.toString('base64'), mimetype: info.mimetype || null, nome: info.fileName || null, tamanho: arquivo.length };
}
// Grupos: só os que este número administra (pode postar), a não ser que peça todos
async function carregarGrupos(dono, { todos = false } = {}) {
  const lista = await conexao(dono).carregarGrupos();
  return todos ? lista : lista.filter(g => g.meu);
}
async function resumoGrupos(dono) {
  const lista = await conexao(dono).carregarGrupos();
  const meus = lista.filter(g => g.meu);
  return { grupos: meus, ocultos: lista.length - meus.length };
}
const enviar = (dono, para, msg) => conexao(dono).enviar(para, msg);
const foto = async (dono, jid) => conexao(dono).foto(paraJid(jid));
async function convite(dono, jid) {
  const id = paraJid(jid);
  const g = (await carregarGrupos(dono)).find(x => x.id === id);
  if (!g) throw falhou('Esse grupo não é deste número.', 404);
  const codigo = await conexao(dono).exigir().groupInviteCode(id);
  return codigo ? `https://chat.whatsapp.com/${codigo}` : null;
}
const nomeExibido = c => c.nome || (c.numero ? `+${c.numero}` : (/@s\.whatsapp\.net$/.test(c.chat) ? `+${c.chat.split('@')[0]}` : 'Contato sem nome'));
// Conversas com nome e a última mensagem guardada (se houver). Grupos: só os deste número.
function conversas(dono, { tipo = '', limite = 200 } = {}) {
  const onde = tipo === 'grupos' ? `AND c.jid LIKE '%@g.us'` : tipo === 'contatos' ? `AND c.jid NOT LIKE '%@g.us'` : '';
  const lim = Math.min(Math.max(Number(limite) || 200, 1), 500);
  return db.all(`SELECT c.jid AS chat, c.nome, c.numero, COALESCE(u.criado_em, c.ultima_em) AS criado_em, u.texto, u.tipo, u.de_mim, u.id
    FROM whatsapp_contatos c
    LEFT JOIN whatsapp_mensagens u ON u.id = (SELECT MAX(m.id) FROM whatsapp_mensagens m WHERE m.dono = c.dono AND m.chat = c.jid)
    WHERE c.dono = ? AND c.conversa = 1 AND (c.jid NOT LIKE '%@g.us' OR c.meu_grupo = 1) ${onde}
    ORDER BY COALESCE(u.criado_em, c.ultima_em, '') DESC LIMIT ?`, validarDono(dono), lim)
    .map(c => ({ ...c, nome: nomeExibido(c), grupo: c.chat.endsWith('@g.us') }));
}
// Lista as mensagens em ordem de chegada. depois: só as mais novas que esse id (para buscar as que chegaram).
function mensagens(dono, { chat, limite, depois, busca } = {}) {
  const lim = Math.min(Math.max(Number(limite) || 50, 1), 200);
  const onde = ['dono = ?'], args = [validarDono(dono)];
  if (chat) { onde.push('chat = ?'); args.push(paraJid(chat)); }
  if (Number(depois) > 0) { onde.push('id > ?'); args.push(Number(depois)); }
  if (busca) { onde.push('texto LIKE ?'); args.push(`%${String(busca)}%`); }
  const sql = `SELECT id, wa_id, chat, de_mim, autor, tipo, texto, criado_em, entrega, bruta IS NOT NULL AS tem_arquivo FROM whatsapp_mensagens WHERE ${onde.join(' AND ')}`;
  if (Number(depois) > 0) return db.all(`${sql} ORDER BY id ASC LIMIT ?`, ...args, lim);
  return db.all(`${sql} ORDER BY id DESC LIMIT ?`, ...args, lim).reverse();
}
function limpar() {
  db.run(`DELETE FROM whatsapp_mensagens WHERE criado_em < datetime('now', ?)`, `-${DIAS_GUARDADOS} days`);
}
// Acesso excluído: desconecta e apaga tudo o que está guardado deste número
async function esquecer(dono) {
  validarDono(dono);
  await desconectar(dono);
  db.run('DELETE FROM whatsapp_ajustes WHERE dono = ?', dono);
  db.run('DELETE FROM whatsapp_webhooks WHERE dono = ?', dono);
  try { db.run('DELETE FROM whatsapp_api_chaves WHERE dono = ?', dono); } catch { /* tabela criada com as rotas */ }
}
// Quem tem sessão salva neste servidor
function donosComSessao() {
  const donos = [];
  for (const nome of fs.readdirSync(RAIZ)) {
    const m = /^whatsapp-sessao(?:-c(\d+))?$/.exec(nome);
    if (m) donos.push(m[1] ? `c:${m[1]}` : 'site');
  }
  return donos.filter(temSessao);
}
const clienteAtivo = cid => Boolean(db.get(`SELECT 1 FROM clientes WHERE id = ? AND status = 'ativo' AND validade >= datetime('now')`, cid));
function fecharVencidos() {
  for (const [dono, c] of conexoes) {
    if (dono !== 'site' && c.sock && !clienteAtivo(cidDe(dono))) fechar(dono, 'O acesso à ferramenta venceu.');
  }
}
// Ao ligar o site: limpa as mensagens antigas e volta a conectar os números, um de cada vez
function iniciar() {
  limpar();
  setInterval(limpar, 6 * 3600000).unref();
  setInterval(fecharVencidos, 3600000).unref();
  const lista = donosComSessao().filter(d => d === 'site' || clienteAtivo(cidDe(d)));
  lista.forEach((dono, i) => {
    setTimeout(() => conectar(dono).catch(err => log(dono, `não reconectou: ${err.message}`)), i * 5000).unref?.();
  });
}

// Só para os testes: troca o WhatsApp de verdade por um simulado
function _paraTestes({ criar, intervalo, intervaloFotos } = {}) {
  if (criar) fabrica = criar;
  if (intervalo !== undefined) intervaloEnvio = intervalo;
  if (intervaloFotos !== undefined) intervaloFoto = intervaloFotos;
}

module.exports = {
  esquecer,
  prepararImagem, donoDe, cidDe, paraJid, lerMensagem, status, pronto, temSessao, conectar, desconectar, fechar, carregarGrupos, resumoGrupos, enviar, foto, convite,
  conversas, mensagens, salvarWebhook, lerWebhook, lerAjustes, salvarAjustes, reiniciar, socket, enviarConteudo, meuJid, gruposMudaram, linhaMensagem, ultimaMensagem,
  textoEditado, nomeConhecido, etiquetas, contatos, baixarMidia, iniciar, limpar, pastaSessao, pastaFotos, _paraTestes,
};
