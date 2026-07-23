'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('stream');
const {
  formatDuration,
  logsToCsv,
  writePageRows,
  ssrMapRow,
  categoryMapRow,
  extractProductId,
  extractCategoryKey,
  merge404Logs,
  process404Logs,
  logs404ToCsv,
} = require('../src/datadog/csv-mappers');

test('formatDuration：null/空字串 → 空字串', () => {
  assert.equal(formatDuration(null), '');
  assert.equal(formatDuration(''), '');
});

test('formatDuration：非數字字串 → 原樣回傳', () => {
  assert.equal(formatDuration('abc'), 'abc');
});

test('formatDuration：<=10000 視為 ms，四捨五入', () => {
  assert.equal(formatDuration(500), '500ms');
  assert.equal(formatDuration(10000), '10000ms'); // 邊界值，等於門檻仍視為 ms
});

test('formatDuration：>10000 視為 ns，換算成 ms', () => {
  assert.equal(formatDuration(20_000_000), '20ms');
  assert.equal(formatDuration(10001), '0ms'); // 剛超過門檻，換算後四捨五入為 0ms
});

test('logsToCsv：header 加上每筆記錄依 mapRow 轉出的欄位', () => {
  const csv = logsToCsv(
    [{ a: 1, b: 'x' }, { a: 2, b: 'y' }],
    { header: 'a,b', mapRow: (log) => [log.a, log.b] },
  );
  assert.equal(csv, 'a,b\n1,x\n2,y');
});

test('writePageRows：逐行寫入，內容與順序正確', async () => {
  const written = [];
  const ws = new Writable({
    write(chunk, _enc, cb) { written.push(chunk.toString()); cb(); },
  });

  await writePageRows(ws, [{ a: 1, b: 'x' }, { a: 2, b: 'y' }], (log) => [log.a, log.b]);

  assert.deepEqual(written, ['1,x\n', '2,y\n']);
});

test('writePageRows：write() 回傳 false 時會等 drain 才繼續寫下一行（避免資料堆積在 stream buffer 裡而失去省記憶體的意義）', async () => {
  const written = [];
  let drainCount = 0;
  // highWaterMark 設得極小，讓每次 write 都超過門檻回傳 false，強迫這個函式一定要走 drain 分支
  const ws = new Writable({
    highWaterMark: 1,
    write(chunk, _enc, cb) {
      written.push(chunk.toString());
      setImmediate(cb); // 模擬非同步磁碟寫入，讓呼叫端有機會在 callback 前就疊加下一筆
    },
  });
  ws.on('drain', () => { drainCount++; });

  const page = [{ a: 1, b: 'x' }, { a: 2, b: 'y' }, { a: 3, b: 'z' }];
  await writePageRows(ws, page, (log) => [log.a, log.b]);

  assert.deepEqual(written, ['1,x\n', '2,y\n', '3,z\n']); // 內容與順序仍然正確
  assert.ok(drainCount > 0, '應該至少觸發一次 drain，證明真的有走等待路徑，而不是把資料硬塞進 buffer');
});

test('ssrMapRow：從 attributes.attributes 取出 user_agent/duration，缺值以空字串代替', () => {
  const log = {
    attributes: {
      timestamp: '2026-05-08T00:00:00Z',
      message: 'page-render | req-1',
      attributes: { user_agent: 'UA1', duration: 500 },
    },
  };
  assert.deepEqual(ssrMapRow(log), ['2026-05-08T00:00:00Z', 'UA1', '500ms', 'page-render | req-1']);
});

test('categoryMapRow：額外帶出 L1/L2/L3', () => {
  const log = {
    attributes: {
      timestamp: 't',
      message: 'm',
      attributes: { user_agent: 'UA2', '@duration': 20_000_000, L1: '1', L2: '2', L3: '3' },
    },
  };
  assert.deepEqual(categoryMapRow(log), ['t', 'UA2', '20ms', '1', '2', '3', 'm']);
});

test('extractProductId：依序 fallback productId → @productId → product_id → @product_id', () => {
  assert.equal(extractProductId({ productId: 'p1' }), 'p1');
  assert.equal(extractProductId({ '@productId': 'p2' }), 'p2');
  assert.equal(extractProductId({ product_id: 'p3' }), 'p3');
  assert.equal(extractProductId({ '@product_id': 'p4' }), 'p4');
  assert.equal(extractProductId({}), null);
});

test('extractCategoryKey：只帶存在的層級，格式為 L1=x/L2=y/L3=z', () => {
  assert.equal(extractCategoryKey({ L1: '1', L2: '2', L3: '3' }), 'L1=1/L2=2/L3=3');
});

test('extractCategoryKey：只有中間層級存在時只輸出該層', () => {
  assert.equal(extractCategoryKey({ L2: '35718' }), 'L2=35718');
});

test('extractCategoryKey：都不存在 → null', () => {
  assert.equal(extractCategoryKey({}), null);
});

test('process404Logs：同一 key 下相同 trace_id 視為同一次，只非 404 的紀錄會被排除', () => {
  const logs = [
    { attributes: { attributes: { httpStatus: 404, productId: 'p1', otel: { trace_id: 't1' } } } },
    { attributes: { attributes: { httpStatus: 404, productId: 'p1', otel: { trace_id: 't1' } } } }, // 重複 trace，不重複計
    { attributes: { attributes: { httpStatus: 404, productId: 'p1', otel: { trace_id: 't2' } } } },
    { attributes: { attributes: { httpStatus: 200, productId: 'p1', otel: { trace_id: 't3' } } } }, // 非 404，排除
    { attributes: { attributes: { httpStatus: 404, productId: 'p2', otel: { trace_id: 't4' } } } },
  ];
  const result = process404Logs(logs, extractProductId);
  assert.equal(result.size, 2);
  assert.equal(result.get('p1').size, 2);
  assert.equal(result.get('p2').size, 1);
});

test('merge404Logs：可把多頁 404 log 累加到同一個 Map 並去重 trace_id', () => {
  const result = new Map();
  merge404Logs([
    { attributes: { attributes: { httpStatus: 404, productId: 'p1', otel: { trace_id: 't1' } } } },
    { attributes: { attributes: { httpStatus: 500, productId: 'p1', otel: { trace_id: 't2' } } } },
  ], extractProductId, result);
  merge404Logs([
    { attributes: { attributes: { httpStatus: 404, productId: 'p1', otel: { trace_id: 't1' } } } },
    { attributes: { attributes: { httpStatus: 404, productId: 'p1', otel: { trace_id: 't3' } } } },
    { attributes: { attributes: { httpStatus: 404, productId: 'p2', otel: { trace_id: 't4' } } } },
  ], extractProductId, result);

  assert.equal(result.size, 2);
  assert.deepEqual([...result.get('p1')].sort(), ['t1', 't3']);
  assert.deepEqual([...result.get('p2')], ['t4']);
});

test('logs404ToCsv：輸出 header 與每個 key 的 404 次數（Set 大小）', () => {
  const result = new Map([
    ['p1', new Set(['t1', 't2'])],
    ['p2', new Set(['t4'])],
  ]);
  assert.equal(logs404ToCsv(result, 'product_id'), 'product_id,404 次數\np1,2\np2,1');
});
