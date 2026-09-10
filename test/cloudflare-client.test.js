'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../src/lib/http');
const { fetchRoutingTargetLogs, fetchCacheHitLogs, callObservabilityAPI, resetRateLimiterForTests } = require('../src/cloudflare/client');

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

function mockRoutingTargetBySlot(countsBySlotFrom, expectedType = 'astro-ssr') {
  return async (_method, _url, _headers, body) => {
    const parsed = JSON.parse(body);
    const from = parsed.timeframe.from;
    const isRoutingTarget = parsed.parameters.filters.some((f) => String(f.value) === `^Routing target for .+: ${expectedType}$`);
    assert.ok(isRoutingTarget, `fetchRoutingTargetLogs 應該查 Routing target for .+: ${expectedType} 這個訊息`);
    return makeCfSuccess(countsBySlotFrom[from]);
  };
}

test('callObservabilityAPI：網路層錯誤不設重試上限，超過舊版 MAX_RETRIES=3 之後恢復連線仍要能成功，不能提早放棄', async (t) => {
  resetRateLimiterForTests();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let call = 0;
  t.mock.method(http, 'httpsRequest', async () => {
    call++;
    if (call <= 5) throw new Error('模擬網路錯誤 ECONNRESET');
    return makeCfSuccess(42);
  });

  const promise = callObservabilityAPI('acc', 'token', 'query', {});
  await new Promise((resolve) => setImmediate(resolve)); // 讓第 1 次失敗跑完、排進第一個 sleep timer
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(10_000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const result = await promise;
  assert.equal(result.result.calculations[0].aggregates[0].value, 42);
  assert.equal(call, 6, '第 6 次呼叫才成功，證明重試次數確實超過了舊版上限 3 次');
});

test('fetchRoutingTargetLogs：不傳 opts 時兩個 slot 都查、結果正確加總', async (t) => {
  resetRateLimiterForTests();
  t.mock.method(http, 'httpsRequest', mockRoutingTargetBySlot({
    0: 10,
    [SLOT_MS]: 20,
  }));

  const { totalRoutingCount, hourly } = await fetchRoutingTargetLogs(
    'acc', 'token', '20260908', 'worker', '/product/', '商品頁', 'astro-ssr', twoSlotRange,
  );

  assert.equal(totalRoutingCount, 30);
  assert.equal(hourly.length, 2);
});

test('fetchRoutingTargetLogs：routingTarget 傳 astro-ssg 時查的是 SSG 的 Routing target，不是 SSR', async (t) => {
  resetRateLimiterForTests();
  t.mock.method(http, 'httpsRequest', mockRoutingTargetBySlot({
    0: 3,
    [SLOT_MS]: 4,
  }, 'astro-ssg'));

  const { totalRoutingCount } = await fetchRoutingTargetLogs(
    'acc', 'token', '20260908', 'worker', '/product/', '商品頁', 'astro-ssg', twoSlotRange,
  );

  assert.equal(totalRoutingCount, 7);
});

test('fetchRoutingTargetLogs：傳 initialHourly/initialSlotStart 時，從指定 slot 續傳，不重查已完成的 slot', async (t) => {
  resetRateLimiterForTests();
  const requests = [];
  t.mock.method(http, 'httpsRequest', async (_method, _url, _headers, body) => {
    requests.push(JSON.parse(body));
    return mockRoutingTargetBySlot({ [SLOT_MS]: 7 })('POST', '', {}, body);
  });

  const { totalRoutingCount, hourly } = await fetchRoutingTargetLogs(
    'acc', 'token', '20260908', 'worker', '/product/', '商品頁', 'astro-ssr', twoSlotRange,
    { initialHourly: [{ hour: '00:00', routingCount: 5 }], initialSlotStart: SLOT_MS },
  );

  assert.ok(requests.every((r) => r.timeframe.from === SLOT_MS), '不該重查第 1 個 slot');
  assert.equal(requests.length, 1); // 續傳只查第 2 個 slot，單一類型不用查兩次

  assert.equal(totalRoutingCount, 5 + 7);
  assert.equal(hourly.length, 2);
});

function mockCacheHitBySlot(countsBySlotFrom) {
  return async (_method, _url, _headers, body) => {
    const parsed = JSON.parse(body);
    const from = parsed.timeframe.from;
    const isCacheHit = parsed.parameters.filters.some((f) => String(f.value).startsWith('^Astro cache hit for'));
    assert.ok(isCacheHit, 'fetchCacheHitLogs 應該查 Astro cache hit 訊息，不是 Routing target');
    return makeCfSuccess(countsBySlotFrom[from]);
  };
}

test('fetchCacheHitLogs：不傳 opts 時兩個 slot 都查、結果正確加總（只查傳入的 cacheType）', async (t) => {
  resetRateLimiterForTests();
  t.mock.method(http, 'httpsRequest', mockCacheHitBySlot({
    0: 4,
    [SLOT_MS]: 6,
  }));

  const { totalHits, hourly } = await fetchCacheHitLogs(
    'acc', 'token', '20260804', 'worker', '/product/', '商品頁', 'astro-ssg', twoSlotRange,
  );

  assert.equal(totalHits, 10);
  assert.equal(hourly.length, 2);
});

test('fetchCacheHitLogs：只送一次 API 呼叫每 slot（不像舊版 fetchAllLogs 那樣連帶查 astro-ssr）', async (t) => {
  resetRateLimiterForTests();
  const requests = [];
  t.mock.method(http, 'httpsRequest', async (_method, _url, _headers, body) => {
    requests.push(JSON.parse(body));
    return mockCacheHitBySlot({ 0: 1, [SLOT_MS]: 1 })('POST', '', {}, body);
  });

  await fetchCacheHitLogs('acc', 'token', '20260804', 'worker', '/product/', '商品頁', 'astro-ssg', twoSlotRange);

  assert.equal(requests.length, 2); // 2 個 slot，每個 slot 只查一次（不是 ssr+ssg 兩次）
  assert.ok(requests.every((r) => r.parameters.filters.some((f) => String(f.value).includes('astro-ssg'))));
});

test('fetchCacheHitLogs：傳 initialHourly/initialSlotStart 時，從指定 slot 續傳，不重查已完成的 slot', async (t) => {
  resetRateLimiterForTests();
  const requests = [];
  t.mock.method(http, 'httpsRequest', async (_method, _url, _headers, body) => {
    requests.push(JSON.parse(body));
    return mockCacheHitBySlot({ [SLOT_MS]: 3 })('POST', '', {}, body);
  });

  const { totalHits, hourly } = await fetchCacheHitLogs(
    'acc', 'token', '20260804', 'worker', '/product/', '商品頁', 'astro-ssg', twoSlotRange,
    { initialHourly: [{ hour: '00:00', hitCount: 5 }], initialSlotStart: SLOT_MS },
  );

  assert.ok(requests.every((r) => r.timeframe.from === SLOT_MS), '不該重查第 1 個 slot');
  assert.equal(requests.length, 1);

  assert.equal(totalHits, 5 + 3);
  assert.equal(hourly.length, 2);
});
