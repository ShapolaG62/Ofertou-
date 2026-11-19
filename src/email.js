// Envio de e-mails (confirmação de assinatura) por SMTP — configurado em Painel → Planos e pagamentos.
// Ex.: Gmail → smtp.gmail.com, porta 587, usuário = seu e-mail, senha = "senha de app" do Google.
const nodemailer = require('nodemailer');
const settings = require('./settings');

function configurado(s = settings.getAll()) {
  return Boolean(s.smtp_host && s.smtp_user && s.smtp_pass);
}

// Identificação de quem mantém o site, no fim de todo e-mail (Decreto 7.962/2013)
function rodapeLegal(s) {
  if (!s.legal_nome) return '';
  // Mesma versão do site: CPF mascarado e só cidade/UF para pessoa física (settings.identificacaoPublica)
  const id = settings.identificacaoPublica(s);
  return [`Ofertou! — mantido por ${s.legal_nome}`, id.documento, id.endereco, s.legal_email].filter(Boolean).join(' · ');
}
const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function enviar({ para, assunto, texto, html }) {
  // Conta do cadastro rápido ainda sem e-mail (endereço provisório .invalid): não há para onde mandar
  if (/\.invalid$/i.test(String(para || '').trim())) return { ignorado: true };
  const s = settings.getAll();
  if (!configurado(s)) throw new Error('E-mail (SMTP) não configurado no painel.');
  const porta = Number(s.smtp_port) || 587;
  const transporte = nodemailer.createTransport({
    host: s.smtp_host,
    port: porta,
    secure: porta === 465,
    auth: { user: s.smtp_user, pass: s.smtp_pass },
    connectionTimeout: 15000,
  });
  const rodape = rodapeLegal(s);
  if (rodape) {
    if (texto) texto = `${texto}\n\n—\n${rodape}`;
    if (html) html = `${html}<hr style="border:0;border-top:1px solid #ddd;margin:20px 0 10px"><p style="font-size:12px;color:#777">${esc(rodape)}</p>`;
  }
  await transporte.sendMail({ from: s.smtp_from || s.smtp_user, to: para, subject: assunto, text: texto, html });
}

module.exports = { configurado, enviar, rodapeLegal };
