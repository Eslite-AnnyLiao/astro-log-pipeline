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

  // 成功完成後 checkpoint 不會被清掉，留著當完成紀錄（cursor 已經是 null），供之後重跑判斷「已完成，略過」；
  // .tmp 檔則已經 rename 成正式檔名。
  const finalCheckpoint = JSON.parse(fs.readFileSync(checkpointPathFor(sq, dateDigits), 'utf8'));
  assert.equal(finalCheckpoint.cursor, null);
  assert.equal(finalCheckpoint.total, 4);
  assert.equal(fs.existsSync(`${outPath}.tmp`), false);
});

test('fetchSubQueryToFile：正式檔已存在且 checkpoint 留著完成紀錄時，重跑會直接略過、完全不打 API', async (t) => {
  const sq = makeSq('skip-if-done');
  const dateDigits = '20260804';
  fs.rmSync(outDirFor(sq), { recursive: true, force: true });
  t.after(() => fs.rmSync(outDirFor(sq), { recursive: true, force: true }));

  t.mock.method(http, 'httpsRequest', async () => makeRes([{ id: 1, val: 'a' }]));
  const { outPath, total: firstTotal } = await fetchSubQueryToFile('key', 'app', sq, 'query', 'from', 'to', dateDigits);
  assert.equal(firstTotal, 1);

  // 模擬 process 級重跑（例如 daily-pipeline.js 對整支子程序重試，重新 spawn 一份全新 process）：
  // 正式檔已經存在、checkpoint 也還留著 total，這次呼叫應該完全不打 API 就直接回傳。
  t.mock.method(http, 'httpsRequest', async () => {
    throw new Error('不該再打 API：這個 subQuery 已經下載完成過了');
  });

  const { total: secondTotal } = await fetchSubQueryToFile('key', 'app', sq, 'query', 'from', 'to', dateDigits);
  assert.equal(secondTotal, 1);
  assert.equal(fs.readFileSync(outPath, 'utf8'), 'id,val\n1,a\n', '略過重抓後，正式檔內容不應該被覆蓋或重複');
});

test('fetchSubQueryToFile：抓完最後一頁、checkpoint 存了 cursor:null，但中斷在 rename 成正式檔之前 → 重跑不會重抓，直接完成且不重複資料', async (t) => {
  const sq = makeSq('cursor-null-not-renamed');
  const dateDigits = '20260804';
  fs.rmSync(outDirFor(sq), { recursive: true, force: true });
  t.after(() => fs.rmSync(outDirFor(sq), { recursive: true, force: true }));

  const outDir = outDirFor(sq);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, sq.filePattern(dateDigits));
  const tmpPath = `${outPath}.tmp`;
  const checkpointPath = checkpointPathFor(sq, dateDigits);

  // 手動模擬「最後一頁已經寫完、onCheckpoint(null, total) 也存了，但還沒 rename」的中斷狀態
  // （見 client.js fetchAllLogs：nextCursor 在沒有下一頁時明確存成 null，不是 undefined）。
  const content = 'id,val\n1,a\n2,b\n';
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.writeFileSync(checkpointPath, JSON.stringify({
    query: 'query', fromISO: 'from', toISO: 'to', variant: sq.variant,
    cursor: null, total: 2, bytesWritten: Buffer.byteLength(content),
  }), 'utf8');

  t.mock.method(http, 'httpsRequest', async () => {
    throw new Error('不該再打 API：最後一頁其實已經抓完了，cursor:null 不代表要從頭開始');
  });

  const { outPath: finalPath, total } = await fetchSubQueryToFile('key', 'app', sq, 'query', 'from', 'to', dateDigits);

  assert.equal(total, 2);
  assert.equal(fs.existsSync(tmpPath), false, 'tmp 檔應該已經 rename 成正式檔');
  assert.equal(fs.readFileSync(finalPath, 'utf8'), content, '內容應該維持原樣，不會因為誤判成「從頭開始」而重複 append');
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
