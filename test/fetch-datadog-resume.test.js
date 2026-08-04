'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('../src/lib/http');
const { fetchSubQueryToFile } = require('../src/datadog/fetch-datadog');

function makeRes(data, cursor) {
  return {
    status: 200,
    headers: { 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': '10' },
    body: JSON.stringify({ data, meta: cursor ? { page: { after: cursor } } : {} }),
  };
}

function makeSq(name) {
  return {
    outputDirName: `TEST-resume/${name}`,
    filePattern: (d) => `test-${d}.csv`,
    header: 'id,val',
    variant: `test-${name}`,
    mapRow: (log) => [log.id, log.val],
  };
}

function outDirFor(sq) {
  return path.join(process.cwd(), 'to-analyze-daily-data', sq.outputDirName);
}

function checkpointPathFor(sq, dateDigits) {
  return path.join(outDirFor(sq), `${sq.filePattern(dateDigits)}.tmp.checkpoint.json`);
}

test('fetchSubQueryToFile：中途失敗後重跑，會從中斷的 cursor 續傳，不重抓已完成的頁，最終檔案內容完整且無重複', async (t) => {
  const sq = makeSq('fail-then-pass');
  const dateDigits = '20260804';
  fs.rmSync(outDirFor(sq), { recursive: true, force: true }); // 清掉上次跑到一半留下的殘留（若有）
  t.after(() => fs.rmSync(outDirFor(sq), { recursive: true, force: true }));

  let call = 0;
  t.mock.method(http, 'httpsRequest', async () => {
    call++;
    if (call === 1) return makeRes([{ id: 1, val: 'a' }, { id: 2, val: 'b' }], 'cursor-1');
    if (call === 2) return { status: 400, headers: {}, body: '模擬第 2 頁下載失敗' }; // 400 不會觸發內建重試，立刻拋錯
    if (call === 3) return makeRes([{ id: 3, val: 'c' }], 'cursor-2');
    return makeRes([{ id: 4, val: 'd' }]);
  });

  await assert.rejects(
    fetchSubQueryToFile('key', 'app', sq, 'query', 'from', 'to', dateDigits),
    /HTTP 400/,
  );

  // 中斷當下，checkpoint 應該記錄第 1 頁完成後的進度（cursor-1 / 累計 2 筆）
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPathFor(sq, dateDigits), 'utf8'));
  assert.equal(checkpoint.cursor, 'cursor-1');
  assert.equal(checkpoint.total, 2);

  // 重跑：應該從 cursor-1 續傳（call 3 開始），而不是從頭再打一次 call 1 的內容
  const { outPath, total } = await fetchSubQueryToFile('key', 'app', sq, 'query', 'from', 'to', dateDigits);

  assert.equal(call, 4, '總共應該只呼叫 4 次 API：第 1 頁 + 失敗的第 2 頁 + 續傳後的 2 頁，不會重抓第 1 頁');
  assert.equal(total, 4);
  assert.equal(fs.readFileSync(outPath, 'utf8'), 'id,val\n1,a\n2,b\n3,c\n4,d\n');

  // 成功完成後 checkpoint 應該被清掉，且 .tmp 檔已 rename 成正式檔名
  assert.equal(fs.existsSync(checkpointPathFor(sq, dateDigits)), false);
  assert.equal(fs.existsSync(`${outPath}.tmp`), false);
});

test('fetchSubQueryToFile：查詢條件跟上次 checkpoint 不同時（例如換了日期）不會誤續傳，從頭開始下載', async (t) => {
  const sq = makeSq('mismatch');
  const dateDigits = '20260804';
  fs.rmSync(outDirFor(sq), { recursive: true, force: true });
  t.after(() => fs.rmSync(outDirFor(sq), { recursive: true, force: true }));

  let call = 0;
  t.mock.method(http, 'httpsRequest', async () => {
    call++;
    if (call === 1) return makeRes([{ id: 1, val: 'a' }], 'cursor-1');
    if (call === 2) return { status: 400, headers: {}, body: '模擬失敗' };
    return makeRes([{ id: 9, val: 'z' }]);
  });

  await assert.rejects(fetchSubQueryToFile('key', 'app', sq, 'query-A', 'from', 'to', dateDigits));

  // 換了查詢字串（模擬程式邏輯改了 query），不該沿用舊 checkpoint 的 cursor
  const { total } = await fetchSubQueryToFile('key', 'app', sq, 'query-B', 'from', 'to', dateDigits);

  assert.equal(call, 3, '條件不同時應該視為全新下載，call 2 之後直接重打一次新的第 1 頁（call 3），不會带 cursor-1');
  assert.equal(total, 1);
});
