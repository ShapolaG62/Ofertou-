// Identificação de quem mantém o site, no rodapé de todas as páginas (Decreto 7.962/2013, comércio eletrônico):
// nome ou razão social, CPF ou CNPJ, endereço e e-mail de contato — preenchidos em Painel → Site → Responsável pelo site.
// Também põe no topo o link "Pular para o conteúdo" (acessibilidade: quem usa teclado ou leitor de tela vai direto ao principal).
(() => {
  if (window.top !== window) return; // dentro de quadros (SAC, Moderação, Equipe no painel) não repete
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const css = document.createElement('style');
  css.textContent = `
  .rodape-legal { border-top: 1px solid var(--line, #e2e6e1); margin-top: 28px; padding: 14px max(16px, env(safe-area-inset-left, 0px)) calc(14px + env(safe-area-inset-bottom, 0px));
    font-size: 12.5px; line-height: 1.6; color: var(--ink-3, #6f7873); text-align: center; }
  .rodape-legal a { color: inherit; text-decoration: underline; }
  .rodape-legal > span + span::before { content: " · "; }
  .rodape-tema { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .rodape-tema .tema-ctl button { height: 26px; font-size: 12px; padding: 0 9px; }
  .pular-conteudo { position: fixed; left: 12px; top: -60px; z-index: 2147483200; padding: 10px 16px; border-radius: 10px;
    background: var(--brand, #0c8f4f); color: #fff; font-weight: 700; text-decoration: none; transition: top .15s; }
  .pular-conteudo:focus { top: 12px; outline: 3px solid #fff; outline-offset: 2px; }
  main[tabindex="-1"]:focus { outline: none; }`;
  document.head.appendChild(css);
  function pularConteudo() {
    const main = document.querySelector('main');
    if (!main || document.querySelector('.pular-conteudo')) return;
    if (!main.id) main.id = 'conteudo';
    if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
    const a = document.createElement('a');
    a.className = 'pular-conteudo';
    a.href = `#${main.id}`;
    a.textContent = 'Pular para o conteúdo';
    a.addEventListener('click', e => { e.preventDefault(); main.focus(); main.scrollIntoView(); });
    document.body.prepend(a);
  }
  // O servidor já manda o documento pronto para exibir (CPF mascarado ou CNPJ formatado: settings.identificacaoPublica)
  const formatarDoc = d => (d ? String(d) : '');
  async function montar() {
    let s = {};
    try { s = await fetch('/api/settings/public').then(r => r.json()); } catch { /* sem conexão: só o tema */ }
    const partes = !s.legal_nome ? ['<span class="rodape-tema">Tema <span data-tema-controle></span></span>'] : [
      `Ofertou! — mantido por ${esc(s.legal_nome)}`,
      s.legal_documento && esc(formatarDoc(s.legal_documento)),
      s.legal_endereco && esc(s.legal_endereco),
      s.legal_email && `<a href="mailto:${esc(s.legal_email)}">${esc(s.legal_email)}</a>`,
      '<a href="/privacidade">Termos de Uso e Privacidade</a>',
      '<a href="#" data-cookies-preferencias>Preferências de cookies</a>',
      '<span class="rodape-tema">Tema <span data-tema-controle></span></span>',
    ].filter(Boolean);
    const el = document.createElement('div');
    el.className = 'rodape-legal';
    el.setAttribute('role', 'contentinfo');
    el.innerHTML = partes.map(p => `<span>${p}</span>`).join('');
    // Fica dentro do rodapé da página, quando existe; senão, no fim da página
    (document.querySelector('body > footer, .site-footer') || document.body).appendChild(el);
  }
  const iniciar = () => { pularConteudo(); montar(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
