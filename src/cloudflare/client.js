'use strict';

const http = require('../lib/http');

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 6;
const MAX_RETRIES = 3;

// Cloudflare Logs Explorer SQL API rate limit: 6 requests / minute
class RateLimiter {
  constructor(maxRequests, windowMs) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.timestamps = [];
  }

  async throttle() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxRequests) {
      const oldest = this.timestamps[0];
      const waitMs = this.windowMs - (now - oldest) + 100;
      console.log(
        `  [Rate Limiter] 已達 ${this.maxRequests} req/${this.windowMs / 1000}s，等待 ${Math.ceil(waitMs / 1000)}s...`,
      );
      await http.sleep(waitMs);
      return this.throttle();
    }

    this.timestamps.push(Date.now());
  }
}

const rateLimiter = new RateLimiter(RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS);

// 測試用：rateLimiter 是 module 內的單例、用真實 Date.now() 累積時間戳，同一個 process 裡
// 連續跑多個測試會共用同一份時間戳記錄，可能誤觸發「已達上限」而真的等待。跑測試前重置它。
function resetRateLimiterForTests() {
  rateLimiter.timestamps = [];
}
let DEBUG = false;
function setDebug(v) { DEBUG = v; }

async function verifyToken(accountId, apiToken) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify`;
  const headers = { Authorization: `Bearer ${apiToken}` };
  let res;
  try {
    res = await http.httpsRequest('GET', url, headers, null);
  } catch (err) {
    throw new Error(`Token 驗證網路錯誤: ${err.message}`);
  }
  if (res.status !== 200) {
    throw new Error(`Token 驗證失敗 (HTTP ${res.status}): ${res.body.slice(0, 200)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new Error(`Token 驗證回應無法解析: ${res.body.slice(0, 100)}`);
  }
  if (!parsed.success) {
    const errMsg = (parsed.errors || []).map((e) => e.message || JSON.stringify(e)).join(', ') || '未知錯誤';
    throw new Error(`Token 無效: ${errMsg}`);
  }
  return parsed.result;
}

async function callObservabilityAPI(accountId, apiToken, subpath, body, retries = 0) {
  await rateLimiter.throttle();

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/${subpath}`;
  const headers = { Authorization: `Bearer ${apiToken}` };

  if (DEBUG) {
    console.log(`\n[DEBUG] POST ${url}`);
    console.log('[DEBUG] Request body:');
    console.log(JSON.stringify(body, null, 2));
  }

  let res;
  try {
    res = await http.httpsRequest('POST', url, headers, JSON.stringify(body));
  } catch (err) {
    // 網路層錯誤不設重試上限：跟 429 不同，這通常是本機網路或中繼點的暫時性問題，
    // 沒有「重試幾次就該放棄」的理由，就地一直重試，網路恢復就會自己接著抓（見
    // src/datadog/client.js 對應處理的相同理由）。
    console.log(`  [網路錯誤] ${err.message}，10s 後重試（第 ${retries + 1} 次）...`);
    await http.sleep(10_000);
    return callObservabilityAPI(accountId, apiToken, subpath, body, retries + 1);
  }

  if (DEBUG) {
    console.log(`[DEBUG] HTTP ${res.status}`);
    console.log('[DEBUG] Response body:');
    console.log(res.body.slice(0, 2000));
  }

  if (res.status === 429) {
    if (retries >= MAX_RETRIES) throw new Error('Rate limit (429) 超過最大重試次數');
    const retryAfterSec = parseInt(res.headers['retry-after'] || '60', 10);
    console.log(`  [429 Rate Limited] 等待 ${retryAfterSec}s 後重試 (${retries + 1}/${MAX_RETRIES})...`);
    await http.sleep(retryAfterSec * 1000);
    return callObservabilityAPI(accountId, apiToken, subpath, body, retries + 1);
  }

  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 500)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new Error(`無法解析回應 JSON: ${res.body.slice(0, 200)}`);
  }

  if (!parsed.success) {
    const errMsg = (parsed.errors || []).map((e) => e.message || JSON.stringify(e)).join(', ') || '未知錯誤';
    throw new Error(`API 錯誤: ${errMsg}`);
  }

  if (parsed.messages?.length) {
    parsed.messages.forEach((m) => console.log(`  [API message] ${JSON.stringify(m)}`));
  }

  return parsed;
}

function buildCacheHitFilters(worker, cacheType, pathPrefix) {
  const filters = [{ kind: 'filter', key: 'message', operation: 'regex', type: 'string', value: `^Astro cache hit for .+: ${cacheType}$` }];
  if (worker) filters.push({ kind: 'filter', key: '$metadata.service', operation: 'eq', type: 'string', value: worker });
  if (pathPrefix) filters.push({ kind: 'filter', key: '$workers.event.request.path', operation: 'regex', type: 'string', value: `^${pathPrefix}` });
  return filters;
}

// 2026-09-07 16:45 後，商品頁/分類頁的 SSR 快取搬進 Astro Worker Cache，
// 上面的 "Astro cache hit for X: astro-ssr" log 不再可靠（www-eslite-com 這層不再記錄到）。
// 改用路由決策當下就會印的 "Routing target for X: astro-ssr" log 取得「總流量」
// （不分 cache hit/miss，只要被路由到 SSR 就會印），再用 (這個總數 - 現有 ssr_records)
// 反推 SSR cache hit 數。SSG 的 cache-hit log 沒受影響，不用改。
function buildRoutingTargetFilters(worker, routingTarget, pathPrefix) {
  const filters = [{ kind: 'filter', key: 'message', operation: 'regex', type: 'string', value: `^Routing target for .+: ${routingTarget}$` }];
  if (worker) filters.push({ kind: 'filter', key: '$metadata.service', operation: 'eq', type: 'string', value: worker });
  if (pathPrefix) filters.push({ kind: 'filter', key: '$workers.event.request.path', operation: 'regex', type: 'string', value: `^${pathPrefix}` });
  return filters;
}

const twHHMM = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(11, 16);

async function fetchCalcCount(accountId, apiToken, filters, fromMs, toMs) {
  const body = {
    queryId: 'adhoc-query',
    timeframe: { from: fromMs, to: toMs },
    view: 'calculations',
    parameters: { filters, filterCombination: 'and', calculations: [{ operator: 'count' }] },
  };
  const result = await callObservabilityAPI(accountId, apiToken, 'query', body);
  const calcs = result.result?.calculations || [];
  return Number(calcs[0]?.aggregates?.[0]?.value) || 0;
}

const SLOT_HOURS = 4; // 每個查詢 slot 跨幾小時（減少 API 呼叫次數）

// 查單一種訊息在每個時間 slot 的 count，逐 slot 累加、支援中斷續傳。
// opts.initialHourly/initialSlotStart：從中斷處續傳用的起點，不傳就是從頭開始。
// opts.onCheckpoint(hourlyResults, nextSlotStart)：每個 slot 查完才呼叫，讓呼叫端把目前累積的
// hourly 結果跟「下一個還沒查的 slot」同步寫進 checkpoint 檔——slot 本身只有一次 count 查詢
// （非分頁），查完即代表該 slot 已確定落地，沒有「半個 slot」的中間狀態要處理。
async function fetchSingleTypeLogs(accountId, apiToken, dateDigits, worker, pathPrefix, typeLabel, buildUTCRange, buildFilters, conditionLabel, opts = {}) {
  const { initialHourly = [], initialSlotStart = null, onCheckpoint } = opts;
  const { fromMs, toMs, startDisplay, endDisplay } = buildUTCRange(dateDigits);
  const SLOT_MS = SLOT_HOURS * 3600_000;
  const hourlyResults = [...initialHourly];

  console.log(`查詢時間範圍 (UTC): ${startDisplay} ~ ${endDisplay}`);
  console.log(`Worker: ${worker || '（不限）'}`);
  console.log(`頁面類型: ${typeLabel}`);
  console.log(`查詢條件: ${conditionLabel}（每 ${SLOT_HOURS} 小時查詢）`);
  console.log('');

  let slotStart = initialSlotStart ?? fromMs;
  if (initialSlotStart) console.log(`  ↻ 偵測到中斷的下載進度，從 ${twHHMM(slotStart)} (TW) 之後續傳`);

  while (slotStart < toMs) {
    const slotEnd = Math.min(slotStart + SLOT_MS - 1, toMs);
    const label = `${twHHMM(slotStart)}~${twHHMM(slotEnd)} (TW)`;
    process.stdout.write(`  ${label} `);

    const count = await fetchCalcCount(accountId, apiToken, buildFilters(worker, pathPrefix), slotStart, slotEnd);
    console.log(`count=${count}`);

    if (count > 0) hourlyResults.push({ hour: twHHMM(slotStart), count });

    slotStart += SLOT_MS;
    if (onCheckpoint) onCheckpoint(hourlyResults, slotStart);
  }

  const total = hourlyResults.reduce((s, r) => s + r.count, 0);
  console.log(`\n${conditionLabel}: ${total} 次\n`);
  return { total, hourly: hourlyResults };
}

// 2026-09-07 16:45 後，商品頁/分類頁的 SSR 快取搬進 Astro Worker Cache，
// "Astro cache hit for X: astro-ssr" log 不再可靠。改用路由決策當下就會印的
// "Routing target for X: astro-ssr" log 取得「總流量」（不分 cache hit/miss，只要被
// 路由到 SSR 就會印），再用 (這個總數 - 現有 ssr_records) 反推 SSR cache hit 數。
// routingTarget 也可傳 'astro-ssg'：直接查商品頁 SSG 的總流量，取代原本用
// @cloudflare.handler_type:fetch 減法反推、容易被 SSR cache hit 混進去污染的估計值。
async function fetchRoutingTargetLogs(accountId, apiToken, dateDigits, worker, pathPrefix, typeLabel, routingTarget, buildUTCRange, opts = {}) {
  const initialHourly = (opts.initialHourly || []).map((h) => ({ hour: h.hour, count: h.routingCount }));
  const { total, hourly } = await fetchSingleTypeLogs(
    accountId, apiToken, dateDigits, worker, pathPrefix, typeLabel, buildUTCRange,
    (w, p) => buildRoutingTargetFilters(w, routingTarget, p),
    `Routing target ${routingTarget}`,
    {
      ...opts,
      initialHourly,
      onCheckpoint: opts.onCheckpoint
        ? (h, nextSlotStart) => opts.onCheckpoint(h.map((x) => ({ hour: x.hour, routingCount: x.count })), nextSlotStart)
        : undefined,
    },
  );
  return {
    totalRoutingCount: total,
    hourly: hourly.map((h) => ({ hour: h.hour, routingCount: h.count })),
  };
}

// SSG 的 cache-hit log 沒受 Astro Worker Cache 搬遷影響，維持查 "Astro cache hit for X: astro-ssg"，
// 只是不再跟 astro-ssr 綁在同一次查詢裡（astro-ssr 那半已經沒人要用，省下來的 API 呼叫額度
// 對本來就不穩定的下載有幫助）。
async function fetchCacheHitLogs(accountId, apiToken, dateDigits, worker, pathPrefix, typeLabel, cacheType, buildUTCRange, opts = {}) {
  const initialHourly = (opts.initialHourly || []).map((h) => ({ hour: h.hour, count: h.hitCount }));
  const { total, hourly } = await fetchSingleTypeLogs(
    accountId, apiToken, dateDigits, worker, pathPrefix, typeLabel, buildUTCRange,
    (w, p) => buildCacheHitFilters(w, cacheType, p),
    `Astro cache hit ${cacheType}`,
    {
      ...opts,
      initialHourly,
      onCheckpoint: opts.onCheckpoint
        ? (h, nextSlotStart) => opts.onCheckpoint(h.map((x) => ({ hour: x.hour, hitCount: x.count })), nextSlotStart)
        : undefined,
    },
  );
  return {
    totalHits: total,
    hourly: hourly.map((h) => ({ hour: h.hour, hitCount: h.count })),
  };
}

module.exports = {
  setDebug,
  verifyToken,
  callObservabilityAPI,
  buildCacheHitFilters,
  buildRoutingTargetFilters,
  fetchCalcCount,
  fetchRoutingTargetLogs,
  fetchCacheHitLogs,
  resetRateLimiterForTests,
};
