'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadCheckpoint, saveCheckpoint, clearCheckpoint } = require('../src/lib/checkpoint');

function tmpCheckpointPath() {
  return path.join(os.tmpdir(), `checkpoint-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test('saveCheckpoint → loadCheckpoint：條件完全一致時讀回原本存的內容', () => {
  const p = tmpCheckpointPath();
  const data = { query: 'q', fromISO: 'f', toISO: 't', variant: 'v', cursor: 'c1', total: 10, bytesWritten: 123 };
  saveCheckpoint(p, data);
  assert.deepEqual(loadCheckpoint(p, { query: 'q', fromISO: 'f', toISO: 't', variant: 'v' }), data);
  clearCheckpoint(p);
});

test('loadCheckpoint：checkpoint 檔不存在 → null', () => {
  const p = tmpCheckpointPath();
  assert.equal(loadCheckpoint(p, { query: 'q', fromISO: 'f', toISO: 't', variant: 'v' }), null);
});

test('loadCheckpoint：query/fromISO/toISO/variant 任一跟本次不同 → null（不能沿用不同查詢條件下的 cursor）', () => {
  const p = tmpCheckpointPath();
  saveCheckpoint(p, { query: 'q1', fromISO: 'f', toISO: 't', variant: 'v', cursor: 'c1', total: 10, bytesWritten: 123 });

  assert.equal(loadCheckpoint(p, { query: 'q2', fromISO: 'f', toISO: 't', variant: 'v' }), null);
  assert.equal(loadCheckpoint(p, { query: 'q1', fromISO: 'f2', toISO: 't', variant: 'v' }), null);
  assert.equal(loadCheckpoint(p, { query: 'q1', fromISO: 'f', toISO: 't2', variant: 'v' }), null);
  assert.equal(loadCheckpoint(p, { query: 'q1', fromISO: 'f', toISO: 't', variant: 'v2' }), null);

  clearCheckpoint(p);
});

test('loadCheckpoint：JSON 損毀（例如寫到一半當機）→ null，不拋錯', () => {
  const p = tmpCheckpointPath();
  fs.writeFileSync(p, '{ "query": "q", "fromISO":', 'utf8'); // 故意截斷成非法 JSON
  assert.equal(loadCheckpoint(p, { query: 'q', fromISO: 'f', toISO: 't', variant: 'v' }), null);
  clearCheckpoint(p);
});

test('loadCheckpoint：只比對 expected 有列出的欄位，其他欄位（如 bytesWritten/hourly/map）由呼叫端自行決定怎麼用', () => {
  const p = tmpCheckpointPath();
  saveCheckpoint(p, { query: 'q', fromISO: 'f', toISO: 't', variant: 'v', cursor: 'c1' }); // 沒有 total/bytesWritten 也合法
  const result = loadCheckpoint(p, { query: 'q', fromISO: 'f', toISO: 't', variant: 'v' });
  assert.deepEqual(result, { query: 'q', fromISO: 'f', toISO: 't', variant: 'v', cursor: 'c1' });
  clearCheckpoint(p);
});

test('loadCheckpoint：expected 只帶部分欄位時，只比對那幾個欄位（給 CF slot / 404 window 這種 key 組合不同的用法）', () => {
  const p = tmpCheckpointPath();
  saveCheckpoint(p, { worker: 'w1', typeLabel: 'product', dateDigits: '20260804', nextSlotStart: 123, hourly: [] });
  assert.deepEqual(
    loadCheckpoint(p, { worker: 'w1', typeLabel: 'product', dateDigits: '20260804' }),
    { worker: 'w1', typeLabel: 'product', dateDigits: '20260804', nextSlotStart: 123, hourly: [] },
  );
  assert.equal(loadCheckpoint(p, { worker: 'w1', typeLabel: 'category', dateDigits: '20260804' }), null);
  clearCheckpoint(p);
});

test('clearCheckpoint：檔案不存在也不拋錯（force）', () => {
  const p = tmpCheckpointPath();
  assert.doesNotThrow(() => clearCheckpoint(p));
});
