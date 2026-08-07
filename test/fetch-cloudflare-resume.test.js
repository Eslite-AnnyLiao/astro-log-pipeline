'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('../src/lib/http');
const { fetchAndSave } = require('../src/cloudflare/fetch-cloudflare');
const { resetRateLimiterForTests } = require('../src/cloudflare/client');

const SLOT_MS = 4 * 3600_000; // 跟 client.js 的 SLOT_HOURS=4 一致
const DATE_DIGITS = '20260804';
const slotFrom = (i) => i * SLOT_MS;

// 縮小成剛好 2 個 slot（真實的一整天是 6 個 slot = 12 次請求，會真的撞到 CF 6 req/60s rate limit）
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

function outDirFor() {
  return path.join(process.cwd(), 'daily-analysis-result', 'TEST-cf-resume');
}

test('fetchAndSave：中途失敗後重跑，會從中斷的 slot 續傳，不重查已完成的 slot，最終輸出正確', async (t) => {
  resetRateLimiterForTests();
  fs.rmSync(outDirFor(), { recursive: true, force: true });
  t.after(() => fs.rmSync(outDirFor(), { recursive: true, force: true }));

  const args = { accountId: 'acc', apiToken: 'token', worker: 'www-eslite-com' };

  // 第 1 個 slot（index 0）成功，第 2 個 slot（index 1）失敗，模擬下載到一半中斷
  t.mock.method(http, 'httpsRequest', async (_method, _url, _headers, body) => {
    const parsed = JSON.parse(body);
    if (parsed.timeframe.from === slotFrom(1)) return { status: 400, headers: {}, body: '模擬第 2 個 slot 查詢失敗' };
    return makeCfSuccess(1);
  });

  await assert.rejects(
    fetchAndSave(args, DATE_DIGITS, '2026-08-04', outDirFor(), 'product', twoSlotRange),
    /HTTP 400/,
  );

  // 重跑：改用永遠成功的 mock，驗證第 1 個 slot（index 0）不會被重查
  // 重置 rate limiter：它是跨這兩次呼叫共用的 module 單例，兩次呼叫合計的請求數會超過
  // 6 req/60s 真的觸發等待，這裡只是模擬「重新執行一次 script」，不該帶著上次的配額。
  resetRateLimiterForTests();
  const requests = [];
  t.mock.method(http, 'httpsRequest', async (_method, _url, _headers, body) => {
    requests.push(JSON.parse(body));
    return makeCfSuccess(1);
  });

  const { jsonPath } = await fetchAndSave(args, DATE_DIGITS, '2026-08-04', outDirFor(), 'product', twoSlotRange);

  assert.ok(requests.every((r) => r.timeframe.from !== slotFrom(0)), '不該重查第 1 個 slot（index 0）');
  assert.equal(requests.length, 2); // 續傳只需要補第 2 個 slot 的 ssr + ssg 兩次查詢

  const output = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(output.hourly.length, 2); // 第 1 個 slot 從 checkpoint 續傳、第 2 個 slot 重新查到，都是 ssr=ssg=1
  assert.ok(output.hourly.every((h) => h.ssrHitCount === 1 && h.ssgHitCount === 1));
  assert.equal(output.total_ssr_hits, 2);
  assert.equal(output.total_ssg_hits, 2);

  // 成功完成後 checkpoint 應該被清掉
  const checkpointPath = jsonPath.replace(/\.json$/, '.checkpoint.json');
  assert.equal(fs.existsSync(checkpointPath), false);
});
