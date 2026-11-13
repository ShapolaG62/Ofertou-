// Loja lenta (Shopee) não prende a rodada: anda na lista com o próprio marcador e para no tempo limite.
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const PASTA = fs.mkdtempSync(path.join(os.tmpdir(), 'ofertou-tempo-'));
process.env.DATA_DIR = PASTA;
process.env.DISABLE_MINER = '1';
process.env.DISABLE_AGENDA = '1';

const db = require('../src/db');
assert.ok(db.DB_PATH.startsWith(PASTA), 'os testes só rodam no banco temporário');
const settings = require('../src/settings');
const miner = require('../src/miner');

test.after(() => { try { db.db.close(); } catch { /* */ } try { fs.rmSync(PASTA, { recursive: true, force: true }); } catch { /* */ } });
miner._paraTestes({ pausa: 0 });

function lojaLenta(ms) {
  const buscados = [];
  return {
    buscados,
    loja: { id: 'lenta', name: 'Lenta', automatic: true, tempoMaxMin: 50, isReady: () => ({ ready: true }),
      search: async q => { buscados.push(q); await new Promise(r => setTimeout(r, ms)); return { status: 'ok', deals: [] }; } },
  };
}

test('para no tempo limite e a próxima rodada continua do termo seguinte, dando a volta na lista', async () => {
  settings.set('search_terms', 'a\nb\nc\nd\ne');
  settings.set('mining_tempo_lenta_min', String(130 / 60000)); // ~130 ms por rodada
  const { loja, buscados } = lojaLenta(50);
  const r1 = await miner._mineStore(loja, [{ query: 'ignorado' }], settings.getAll(), () => {});
  assert.ok(buscados.length >= 2 && buscados.length < 5, `parou no tempo (${buscados.length} termos)`);
  assert.deepEqual(buscados, ['a', 'b', 'c'].slice(0, buscados.length), 'usa a lista inteira, não o lote da rodada');
  assert.match(r1.message, /Tempo da rodada acabou/);
  const feitos = buscados.length;
  await miner._mineStore(loja, [], settings.getAll(), () => {});
  assert.equal(buscados[feitos], ['a', 'b', 'c', 'd', 'e'][feitos], 'continua de onde parou, sem refazer o último');
  settings.set('mining_tempo_lenta_min', '50');
  await miner._mineStore(loja, [], settings.getAll(), () => {});
  assert.ok(buscados.slice(-5).sort().join() === 'a,b,c,d,e', 'com tempo de sobra, dá a volta inteira');
});

test('busca pontual (um termo pedido agora) não usa o rodízio próprio nem mexe no marcador', async () => {
  settings.set('mining_cursor_lenta', '2');
  const { loja, buscados } = lojaLenta(0);
  await miner._mineStore(loja, [{ query: 'perfume afnan' }], settings.getAll(), () => {}, { consulta: true });
  assert.deepEqual(buscados, ['perfume afnan']);
  assert.equal(settings.get('mining_cursor_lenta'), '2');
});
