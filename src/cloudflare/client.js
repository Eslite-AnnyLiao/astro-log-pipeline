'use strict';

const { sleep, httpsRequest } = require('../lib/http');

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
      await sleep(waitMs);
      return this.throttle();
    }

    this.timestamps.push(Date.now());
  }
}

const rateLimiter = new RateLimiter(RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS);
let DEBUG = false;
function setDebug(v) { DEBUG = v; }

async function verifyToken(accountId, apiToken) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify`;
  const headers = { Authorization: `Bearer ${apiToken}` };
  let res;
  try {
    res = await httpsRequest('GET', url, headers, null);
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
    res = await httpsRequest('POST', url, headers, JSON.stringify(body));
  } catch (err) {
    if (retries < MAX_RETRIES) {
      console.log(`  [網路錯誤] ${err.message}，10s 後重試 (${retries + 1}/${MAX_RETRIES})...`);
      await sleep(10_000);
      return callObservabilityAPI(accountId, apiToken, subpath, body, retries + 1);
    }
    throw err;
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
    await sleep(retryAfterSec * 1000);
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

async function fetchAllLogs(accountId, apiToken, dateDigits, worker, pathPrefix, typeLabel, buildUTCRange) {
  const { fromMs, toMs, startDisplay, endDisplay } = buildUTCRange(dateDigits);
  const SLOT_MS = SLOT_HOURS * 3600_000;
  const hourlyResults = [];

  console.log(`查詢時間範圍 (UTC): ${startDisplay} ~ ${endDisplay}`);
  console.log(`Worker: ${worker || '（不限）'}`);
  console.log(`頁面類型: ${typeLabel}`);
  console.log(`Cache hit 條件: astro-ssr / astro-ssg（每 ${SLOT_HOURS} 小時並行查詢）`);
  console.log('');

  let slotStart = fromMs;

  while (slotStart < toMs) {
    const slotEnd = Math.min(slotStart + SLOT_MS - 1, toMs);
    const label = `${twHHMM(slotStart)}~${twHHMM(slotEnd)} (TW)`;
    process.stdout.write(`  ${label} `);

    const [ssrCount, ssgCount] = await Promise.all([
      fetchCalcCount(accountId, apiToken, buildCacheHitFilters(worker, 'astro-ssr', pathPrefix), slotStart, slotEnd),
      fetchCalcCount(accountId, apiToken, buildCacheHitFilters(worker, 'astro-ssg', pathPrefix), slotStart, slotEnd),
    ]);

    console.log(`ssr=${ssrCount} ssg=${ssgCount}`);

    if (ssrCount > 0 || ssgCount > 0) {
      hourlyResults.push({ hour: twHHMM(slotStart), ssrHitCount: ssrCount, ssgHitCount: ssgCount });
    }

    slotStart += SLOT_MS;
  }

  const totalSsrHits = hourlyResults.reduce((s, r) => s + r.ssrHitCount, 0);
  const totalSsgHits = hourlyResults.reduce((s, r) => s + r.ssgHitCount, 0);
  console.log(`\nAstro cache hit  SSR: ${totalSsrHits} 次  SSG: ${totalSsgHits} 次\n`);
  return { totalSsrHits, totalSsgHits, hourly: hourlyResults };
}

module.exports = {
  setDebug,
  verifyToken,
  callObservabilityAPI,
  buildCacheHitFilters,
  fetchCalcCount,
  fetchAllLogs,
};
