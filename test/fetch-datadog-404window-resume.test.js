'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('../src/lib/http');
const { fetchWindowed404ToFile } = require('../src/datadog/fetch-datadog');

function makeRes(data, cursor) {
  return {
    status: 200,
    headers: { 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': '10' },
    body: JSON.stringify({ data, meta: cursor ? { page: { after: cursor } } : {} }),
  };
}

function makeLog(key, traceId) {
  return { attributes: { attributes: { httpStatus: 404, key, otel: { trace_id: traceId } } } };
}

// windowHours=12 → 一天切成剛好 2 個時間窗，讓測試只需要處理 2 段
function makeE() {
  return {
    windowHours: 12,
    extractKey: (custom) => custom.key,
    keyLabel: 'Key',
  };
}

function outPathFor(name) {
  const dir = path.join(process.cwd(), 'to-analyze-daily-data', 'TEST-404window');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.csv`);
}

function cleanup() {
  fs.rmSync(path.join(process.cwd(), 'to-analyze-daily-data', 'TEST-404window'), { recursive: true, force: true });
}

test('fetchWindowed404ToFile：中途失敗後重跑，會從未完成的時間窗續傳，已完成窗口的資料不會遺失也不會重複', async (t) => {
  cleanup();
  t.after(cleanup);

  const e = makeE();
  const outPath = outPathFor('fail-then-pass');
  const dateDigits = '20260804';

  let windowCallCount = 0;
  t.mock.method(http, 'httpsRequest', async () => {
    windowCallCount++;
    if (windowCallCount === 1) return makeRes([makeLog('p1', 't1'), makeLog('p1', 't2')]); // 第 1 個窗口成功
    return { status: 400, headers: {}, body: '模擬第 2 個窗口查詢失敗' }; // 第 2 個窗口失敗
  });

  await assert.rejects(
    fetchWindowed404ToFile('key', 'app', e, 'product', 'query', dateDigits, outPath),
    /HTTP 400/,
  );

  // checkpoint 應該記錄第 1 個窗口已完成、且帶著它抓到的 404 key
  const checkpoint = JSON.parse(fs.readFileSync(`${outPath}.checkpoint.json`, 'utf8'));
  assert.equal(checkpoint.completedWindows, 1);
  assert.deepEqual(checkpoint.map, [['p1', ['t1', 't2']]]);

  // 重跑：改用永遠成功的 mock，驗證第 1 個窗口不會被重查（不會再收到窗口 1 那兩筆 log）
  let resumeCallCount = 0;
  t.mock.method(http, 'httpsRequest', async () => {
    resumeCallCount++;
    return makeRes([makeLog('p2', 't3')]); // 第 2 個窗口的資料
  });

  const { map, raw404Total } = await fetchWindowed404ToFile('key', 'app', e, 'product', 'query', dateDigits, outPath);

  assert.equal(resumeCallCount, 1); // 只該查第 2 個窗口，不重查第 1 個
  assert.equal(raw404Total, 3); // 第 1 個窗口 2 筆 + 第 2 個窗口 1 筆
  assert.equal(map.size, 2);
  assert.deepEqual([...map.get('p1')].sort(), ['t1', 't2']);
  assert.deepEqual([...map.get('p2')], ['t3']);

  const content = fs.readFileSync(outPath, 'utf8');
  assert.equal(content, 'Key,404 次數\np1,2\np2,1');

  // 成功完成後 checkpoint 不會被清掉，留著當完成紀錄（completedWindows === 總窗口數），
  // 供之後重跑判斷「已完成，略過」。
  const finalCheckpoint = JSON.parse(fs.readFileSync(`${outPath}.checkpoint.json`, 'utf8'));
  assert.equal(finalCheckpoint.completedWindows, 2);
});

test('fetchWindowed404ToFile：正式檔已存在且 checkpoint 留著完成紀錄時，重跑會直接略過、完全不打 API', async (t) => {
  cleanup();
  t.after(cleanup);

  const e = makeE();
  const outPath = outPathFor('skip-if-done');
  const dateDigits = '20260804';

  t.mock.method(http, 'httpsRequest', async () => makeRes([makeLog('p1', 't1')]));
  const { raw404Total: firstTotal } = await fetchWindowed404ToFile('key', 'app', e, 'product', 'query', dateDigits, outPath);
  assert.equal(firstTotal, 2); // makeE 的 windowHours=12 → 2 個窗口，各回傳一筆 log

  // 模擬 process 級重跑：正式檔已存在、checkpoint 也還留著完成紀錄，這次應該完全不打 API。
  t.mock.method(http, 'httpsRequest', async () => {
    throw new Error('不該再打 API：這個 404 統計已經下載完成過了');
  });

  const { map, raw404Total } = await fetchWindowed404ToFile('key', 'app', e, 'product', 'query', dateDigits, outPath);
  assert.equal(raw404Total, 2);
  assert.equal(map.size, 1);
  assert.deepEqual([...map.get('p1')], ['t1']);
});

test('fetchWindowed404ToFile：查詢條件跟上次 checkpoint 不同時不會誤續傳，從頭開始跑完整 2 個窗口', async (t) => {
  cleanup();
  t.after(cleanup);

  const e = makeE();
  const outPath = outPathFor('mismatch');
  const dateDigits = '20260804';

  let call = 0;
  t.mock.method(http, 'httpsRequest', async () => {
    call++;
    if (call === 1) return makeRes([makeLog('p1', 't1')]);
    return { status: 400, headers: {}, body: '模擬失敗' };
  });

  await assert.rejects(fetchWindowed404ToFile('key', 'app', e, 'product', 'query-A', dateDigits, outPath));

  let resumeCalls = 0;
  t.mock.method(http, 'httpsRequest', async () => {
    resumeCalls++;
    return makeRes([makeLog('p9', 't9')]);
  });

  // 換了 query（模擬程式邏輯改了查詢字串），不該沿用舊 checkpoint 的 completedWindows
  const { map } = await fetchWindowed404ToFile('key', 'app', e, 'product', 'query-B', dateDigits, outPath);

  assert.equal(resumeCalls, 2); // 兩個窗口都要重新查（從頭開始）
  assert.equal(map.size, 1);
  assert.deepEqual([...map.get('p9')], ['t9']);
});
