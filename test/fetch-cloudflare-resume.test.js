'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('../src/lib/http');
const { fetchAndSave } = require('../src/cloudflare/fetch-cloudflare');
const { resetRateLimiterForTests } = require('../src/cloudflare/client');

const SLOT_MS = 4 * 3600_000; // 跟 client.js 的 SLOT_HOURS=4 一致
const DATE_DIGITS = '20260908';
const slotFrom = (i) => i * SLOT_MS;

// 縮小成剛好 2 個 slot（真實的一整天是 6 個 slot，會撞到 CF 6 req/60s rate limit）
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

function outDirFor(name) {
  return path.join(process.cwd(), 'daily-analysis-result', name);
}

function isRoutingTargetReq(parsed) {
  return parsed.parameters.filters.some((f) => String(f.value).startsWith('^Routing target for'));
}

test('fetchAndSave（商品頁，有 SSG）：Routing target 查完、SSG 中途失敗後重跑，只補 SSG 沒查完的 slot', async (t) => {
  resetRateLimiterForTests();
  const outDir = outDirFor('TEST-cf-resume-product');
  fs.rmSync(outDir, { recursive: true, force: true });
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  const args = { accountId: 'acc', apiToken: 'token', worker: 'www-eslite-com' };

  // Routing target 兩個 slot 都成功；SSG 第 1 個 slot 成功，第 2 個 slot 失敗（模擬中斷）
  t.mock.method(http, 'httpsRequest', async (_method, _url, _headers, body) => {
    const parsed = JSON.parse(body);
    if (isRoutingTargetReq(parsed)) return makeCfSuccess(10);
    if (parsed.timeframe.from === slotFrom(1)) return { status: 400, headers: {}, body: '模擬 SSG 第 2 個 slot 查詢失敗' };
    return makeCfSuccess(1);
  });

  await assert.rejects(
    fetchAndSave(args, DATE_DIGITS, '2026-09-08', outDir, 'product', twoSlotRange),
    /HTTP 400/,
  );

  // 重跑：Routing target 跟 SSG 都用永遠成功的 mock，驗證 Routing target 兩個 slot 都不會重查
  // （因為它上次就已經完整查完，中斷的只有 SSG），SSG 只補第 2 個 slot
  resetRateLimiterForTests();
  const requests = [];
  t.mock.method(http, 'httpsRequest', async (_method, _url, _headers, body) => {
    const parsed = JSON.parse(body);
    requests.push(parsed);
    if (isRoutingTargetReq(parsed)) return makeCfSuccess(10);
    return makeCfSuccess(1);
  });

  const { jsonPath } = await fetchAndSave(args, DATE_DIGITS, '2026-09-08', outDir, 'product', twoSlotRange);

  const routingReqs = requests.filter(isRoutingTargetReq);
  const ssgReqs = requests.filter((r) => !isRoutingTargetReq(r));
  assert.equal(routingReqs.length, 0, 'Routing target 上次已完整查完，重跑不該再查');
  assert.equal(ssgReqs.length, 1, 'SSG 只該補查中斷掉的第 2 個 slot');
  assert.ok(ssgReqs.every((r) => r.timeframe.from === slotFrom(1)));

  const output = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(output.routing_target_ssr_total, 20); // 兩個 slot 各 10
  assert.equal(output.total_ssg_hits, 2); // 第 1 個 slot 續傳帶進來的 1 + 第 2 個 slot 重查到的 1

  const checkpointPath = jsonPath.replace(/\.json$/, '.checkpoint.json');
  assert.equal(fs.existsSync(checkpointPath), false);
});

test('fetchAndSave（分類頁，無 SSG）：不查 astro-ssg，只查 Routing target', async (t) => {
  resetRateLimiterForTests();
  const outDir = outDirFor('TEST-cf-resume-category');
  fs.rmSync(outDir, { recursive: true, force: true });
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  const args = { accountId: 'acc', apiToken: 'token', worker: 'www-eslite-com' };
  const requests = [];
  t.mock.method(http, 'httpsRequest', async (_method, _url, _headers, body) => {
    const parsed = JSON.parse(body);
    requests.push(parsed);
    return makeCfSuccess(5);
  });

  const { jsonPath } = await fetchAndSave(args, DATE_DIGITS, '2026-09-08', outDir, 'category', twoSlotRange);

  assert.ok(requests.every(isRoutingTargetReq), '分類頁沒有 SSG，全部請求都該是 Routing target');
  assert.equal(requests.length, 2); // 2 個 slot，各查一次

  const output = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(output.routing_target_ssr_total, 10);
  assert.equal(output.total_ssg_hits, 0);
  assert.deepEqual(output.hourly_ssg_hits, []);
});
