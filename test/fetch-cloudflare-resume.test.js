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

// 商品頁現在有三條獨立查詢：Routing target astro-ssr、Routing target astro-ssg、
// Astro cache hit astro-ssg，用訊息內容分辨是哪一條。
function classifyReq(parsed) {
  const msg = parsed.parameters.filters.find((f) => f.key === 'message')?.value || '';
  if (msg.includes('Routing target') && msg.includes('astro-ssr')) return 'routingSsr';
  if (msg.includes('Routing target') && msg.includes('astro-ssg')) return 'routingSsg';
  if (msg.includes('Astro cache hit') && msg.includes('astro-ssg')) return 'cacheHitSsg';
  throw new Error(`無法辨識的查詢訊息: ${msg}`);
}

test('fetchAndSave（商品頁，有 SSG）：Routing target astro-ssr/astro-ssg 查完、SSG cache-hit 中途失敗後重跑，只補沒查完的那條', async (t) => {
  resetRateLimiterForTests();
  const outDir = outDirFor('TEST-cf-resume-product');
  fs.rmSync(outDir, { recursive: true, force: true });
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  const args = { accountId: 'acc', apiToken: 'token', worker: 'www-eslite-com' };

  // 執行順序是 routingSsr → cacheHitSsg → routingSsg（見 fetch-cloudflare.js 的 fetchAndSave）。
  // 讓 routingSsr、cacheHitSsg 兩個都完整查完，routingSsg 第 2 個 slot 失敗（模擬中斷），
  // 驗證前兩個「已完成」的查詢不會因為第三個失敗而被重跑。
  t.mock.method(http, 'httpsRequest', async (_method, _url, _headers, body) => {
    const parsed = JSON.parse(body);
    const kind = classifyReq(parsed);
    if (kind === 'routingSsr') return makeCfSuccess(10);
    if (kind === 'cacheHitSsg') return makeCfSuccess(1);
    if (parsed.timeframe.from === slotFrom(1)) return { status: 400, headers: {}, body: '模擬 Routing target astro-ssg 第 2 個 slot 查詢失敗' };
    return makeCfSuccess(3);
  });

  await assert.rejects(
    fetchAndSave(args, DATE_DIGITS, '2026-09-08', outDir, 'product', twoSlotRange),
    /HTTP 400/,
  );

  // 重跑：全部用永遠成功的 mock，驗證前兩條（routingSsr、cacheHitSsg）都不會重查
  // （上次就已經完整查完，中斷的只有 routingSsg），routingSsg 只補第 2 個 slot
  resetRateLimiterForTests();
  const requests = [];
  t.mock.method(http, 'httpsRequest', async (_method, _url, _headers, body) => {
    const parsed = JSON.parse(body);
    requests.push(parsed);
    const kind = classifyReq(parsed);
    if (kind === 'routingSsr') return makeCfSuccess(10);
    if (kind === 'cacheHitSsg') return makeCfSuccess(1);
    return makeCfSuccess(3);
  });

  const { jsonPath } = await fetchAndSave(args, DATE_DIGITS, '2026-09-08', outDir, 'product', twoSlotRange);

  const byKind = { routingSsr: 0, routingSsg: 0, cacheHitSsg: 0 };
  requests.forEach((r) => byKind[classifyReq(r)]++);
  assert.equal(byKind.routingSsr, 0, 'Routing target astro-ssr 上次已完整查完，重跑不該再查');
  assert.equal(byKind.cacheHitSsg, 0, 'SSG cache-hit 上次已完整查完，重跑不該再查');
  assert.equal(byKind.routingSsg, 1, 'Routing target astro-ssg 只該補查中斷掉的第 2 個 slot');

  const output = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(output.routing_target_ssr_total, 20); // 兩個 slot 各 10
  assert.equal(output.routing_target_ssg_total, 6); // 兩個 slot 各 3
  assert.equal(output.total_ssg_hits, 2); // 第 1 個 slot 續傳帶進來的 1 + 第 2 個 slot 重查到的 1

  const checkpointPath = jsonPath.replace(/\.json$/, '.checkpoint.json');
  assert.equal(fs.existsSync(checkpointPath), false);
});

test('fetchAndSave（分類頁，無 SSG）：不查 astro-ssg 相關的任何查詢，只查 Routing target astro-ssr', async (t) => {
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

  assert.ok(requests.every((r) => classifyReq(r) === 'routingSsr'), '分類頁沒有 SSG，全部請求都該是 Routing target astro-ssr');
  assert.equal(requests.length, 2); // 2 個 slot，各查一次

  const output = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(output.routing_target_ssr_total, 10);
  assert.equal(output.routing_target_ssg_total, null);
  assert.equal(output.total_ssg_hits, 0);
  assert.deepEqual(output.hourly_ssg_hits, []);
  assert.deepEqual(output.hourly_routing_target_ssg, []);
});
