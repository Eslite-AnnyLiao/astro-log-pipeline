'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../src/lib/http');
const { fetchAllLogs, resetRateLimiterForTests } = require('../src/cloudflare/client');

const SLOT_MS = 4 * 3600_000; // 跟 client.js 內部 SLOT_HOURS=4 一致，測試用兩個 slot 的小範圍

// 涵蓋剛好 2 個 slot：[0, 4h) 與 [4h, 8h)
function twoSlotRange() {
  return { fromMs: 0, toMs: 2 * SLOT_MS - 1, startDisplay: 's', endDisplay: 'e' };
}

function makeCfSuccess(value) {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ success: true, result: { calculations: [{ aggregates: [{ value }] }] } }),
  };
}

// 用請求內容（timeframe.from + filter 是 ssr 還是 ssg）判斷回什麼值，不依賴呼叫順序——
// ssr/ssg 是用 Promise.all 平行送出的，順序不保證。
function mockBySlotAndType(countsBySlotFrom) {
  return async (_method, _url, _headers, body) => {
    const parsed = JSON.parse(body);
    const from = parsed.timeframe.from;
    const isSSR = parsed.parameters.filters.some((f) => String(f.value).includes('astro-ssr'));
    const slot = countsBySlotFrom[from];
    return makeCfSuccess(isSSR ? slot.ssr : slot.ssg);
  };
}

test('fetchAllLogs：不傳 opts 時行為與過去一致，兩個 slot 都查、結果正確加總', async (t) => {
  resetRateLimiterForTests();
  t.mock.method(http, 'httpsRequest', mockBySlotAndType({
    0: { ssr: 1, ssg: 2 },
    [SLOT_MS]: { ssr: 3, ssg: 4 },
  }));

  const { totalSsrHits, totalSsgHits, hourly } = await fetchAllLogs(
    'acc', 'token', '20260804', 'worker', '/product/', '商品頁', twoSlotRange,
  );

  assert.equal(totalSsrHits, 4);
  assert.equal(totalSsgHits, 6);
  assert.equal(hourly.length, 2);
});

test('fetchAllLogs：傳 initialHourly/initialSlotStart 時，從指定 slot 續傳，不重查已完成的 slot', async (t) => {
  resetRateLimiterForTests();
  const requests = [];
  t.mock.method(http, 'httpsRequest', async (_method, _url, _headers, body) => {
    requests.push(JSON.parse(body));
    return mockBySlotAndType({ [SLOT_MS]: { ssr: 3, ssg: 1 } })('POST', '', {}, body);
  });

  const { totalSsrHits, totalSsgHits, hourly } = await fetchAllLogs(
    'acc', 'token', '20260804', 'worker', '/product/', '商品頁', twoSlotRange,
    { initialHourly: [{ hour: '00:00', ssrHitCount: 5, ssgHitCount: 2 }], initialSlotStart: SLOT_MS },
  );

  // 只該查第 2 個 slot（from = SLOT_MS），第 1 個 slot（from = 0）不該再被打
  assert.ok(requests.every((r) => r.timeframe.from === SLOT_MS), '不該重查第 1 個 slot');
  assert.equal(requests.length, 2); // 第 2 個 slot 的 ssr + ssg 兩次查詢

  assert.equal(totalSsrHits, 5 + 3);
  assert.equal(totalSsgHits, 2 + 1);
  assert.equal(hourly.length, 2); // 續傳帶進來的 1 筆 + 這次查到的 1 筆
});

test('fetchAllLogs：每個 slot 查完就呼叫 onCheckpoint，帶上目前累積結果與下一個待查 slot 的起點', async (t) => {
  resetRateLimiterForTests();
  t.mock.method(http, 'httpsRequest', mockBySlotAndType({
    0: { ssr: 1, ssg: 0 },
    [SLOT_MS]: { ssr: 0, ssg: 2 },
  }));

  const checkpoints = [];
  await fetchAllLogs(
    'acc', 'token', '20260804', 'worker', '/product/', '商品頁', twoSlotRange,
    { onCheckpoint: (hourly, nextSlotStart) => checkpoints.push({ n: hourly.length, nextSlotStart }) },
  );

  assert.deepEqual(checkpoints, [
    { n: 1, nextSlotStart: SLOT_MS },
    { n: 2, nextSlotStart: 2 * SLOT_MS },
  ]);
});
