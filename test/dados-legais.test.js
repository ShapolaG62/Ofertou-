// Dados de quem mantém o site: CPF e endereço residencial não saem inteiros em público (site, rodapé, e-mails).
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const PASTA = fs.mkdtempSync(path.join(os.tmpdir(), 'ofertou-legal-'));
process.env.DATA_DIR = PASTA;
process.env.DISABLE_MINER = '1';
process.env.DISABLE_AGENDA = '1';

const db = require('../src/db');
assert.ok(db.DB_PATH.startsWith(PASTA), 'os testes só rodam no banco temporário');
const settings = require('../src/settings');

test.after(() => { try { db.db.close(); } catch { /* */ } try { fs.rmSync(PASTA, { recursive: true, force: true }); } catch { /* */ } });

test('pessoa física: CPF mascarado e só cidade/UF, em qualquer formato digitado', () => {
  settings.set('legal_nome', 'Fulano de Tal');
  for (const [doc, endereco] of [['123.456.789-09', 'Rua 1, nº 10, Centro, CEP 77000-000, Palmas/TO'], ['12345678909', 'Av. Brasil 500 - Bairro Novo - São Paulo - SP']]) {
    settings.set('legal_documento', doc);
    settings.set('legal_endereco', endereco);
    const pub = settings.getPublic();
    assert.match(pub.legal_documento, /^CPF \*\*\*\.456\.789-\*\*$/);
    assert.ok(!JSON.stringify(pub).includes('12345678909') && !JSON.stringify(pub).includes('123.456.789-09'), 'o CPF inteiro não aparece');
    assert.ok(!/Rua|Av\.|CEP|\d{5}-?\d{3}/.test(pub.legal_endereco), `sem rua e CEP (${pub.legal_endereco})`);
    assert.equal(pub.legal_pessoa_fisica, '1');
  }
  assert.equal(settings.getPublic().legal_endereco, 'São Paulo/SP');
  settings.set('legal_endereco', 'Rua 1, nº 10, Centro');
  assert.equal(settings.getPublic().legal_endereco, '', 'sem cidade/UF reconhecível: não mostra nada');
});

test('CNPJ (empresa) sai completo, com o endereço completo', () => {
  settings.set('legal_documento', '12.345.678/0001-95');
  settings.set('legal_endereco', 'Rua 2, 20, Sala 3, Centro, Palmas/TO');
  const pub = settings.getPublic();
  assert.equal(pub.legal_documento, 'CNPJ 12.345.678/0001-95');
  assert.equal(pub.legal_endereco, 'Rua 2, 20, Sala 3, Centro, Palmas/TO');
  assert.equal(pub.legal_pessoa_fisica, '');
});

test('o painel continua vendo o valor completo para editar', () => {
  settings.set('legal_documento', '123.456.789-09');
  assert.equal(settings.getAll().legal_documento, '123.456.789-09');
});
