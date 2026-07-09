'use strict';

const { sleep, httpsRequest } = require('../lib/http');

const DATADOG_SITE = 'api.us5.datadoghq.com';
const PAGE_LIMIT = 1000;
const MAX_RETRIES = 3;

let DEBUG = false;
function setDebug(v) { DEBUG = v; }

async function fetchLogsPage(apiKey, appKey, params, retries = 0) {
  const url = `https://${DATADOG_SITE}/api/v2/logs/events/search`;
  const headers = { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey };

  if (DEBUG) {
    console.log(`\n[DEBUG] POST ${url}`);
    console.log('[DEBUG] headers:', JSON.stringify(headers));
    console.log('[DEBUG] Request body:');
    console.log(JSON.stringify(params, null, 2));
  }

  let res;
  try {
    res = await httpsRequest('POST', url, headers, JSON.stringify(params));
  } catch (err) {
    if (retries < MAX_RETRIES) {
      console.log(`  [網路錯誤] ${err.message}，10s 後重試 (${retries + 1}/${MAX_RETRIES})...`);
      await sleep(10_000);
      return fetchLogsPage(apiKey, appKey, params, retries + 1);
    }
    throw err;
  }

  if (DEBUG) {
    console.log(`[DEBUG] HTTP ${res.status}`);
    console.log('[DEBUG] Response body:');
    console.log(res.body.slice(0, 3000));
  }

  if (res.status === 429) {
    if (retries >= MAX_RETRIES) throw new Error('Rate limit (429) 超過最大重試次數');
    // 此 endpoint 不會回 retry-after，改用 x-ratelimit-reset（秒）
    const resetSec = parseInt(res.headers['x-ratelimit-reset'] || res.headers['retry-after'] || '10', 10);
    const waitSec = resetSec + 1;
    console.log(`  [429 Rate Limited] 等待 ${waitSec}s 後重試 (${retries + 1}/${MAX_RETRIES})...`);
    await sleep(waitSec * 1000);
    return fetchLogsPage(apiKey, appKey, params, retries + 1);
  }

  if (res.status === 500) {
    if (retries >= MAX_RETRIES) throw new Error(`HTTP 500: ${res.body.slice(0, 500)}`);
    console.log(`  [500 Server Error] 30s 後重試 (${retries + 1}/${MAX_RETRIES})...`);
    await sleep(30_000);
    return fetchLogsPage(apiKey, appKey, params, retries + 1);
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

  return { parsed, headers: res.headers };
}

// 依 x-ratelimit-remaining / x-ratelimit-reset 自適應節流，貼著官方限制跑
// （Search API 限制為 2 requests / 10s，配額用盡才等到 reset，否則立即送下一頁）
async function throttleByRateLimit(headers) {
  const remaining = parseInt(headers['x-ratelimit-remaining'], 10);
  const resetSec = parseInt(headers['x-ratelimit-reset'], 10);
  if (Number.isNaN(remaining) || Number.isNaN(resetSec)) {
    await sleep(2000); // 沒有 rate limit header 時的保守 fallback
    return;
  }
  if (remaining > 0) {
    await sleep(300); // 還有配額，留一點緩衝避免時鐘誤差
  } else {
    await sleep((resetSec + 1) * 1000);
  }
}

async function fetchAllLogs(apiKey, appKey, query, fromISO, toISO, label) {
  console.log(`[${label}] Query: ${query}`);

  const allLogs = [];
  let cursor = null;
  let page = 1;
  let firstLogPrinted = false;

  while (true) {
    const params = {
      filter: { query, from: fromISO, to: toISO },
      sort: '-timestamp',
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    };

    process.stdout.write(`  第 ${page} 頁...`);
    const { parsed: result, headers } = await fetchLogsPage(apiKey, appKey, params);

    const data = result.data || [];

    if (DEBUG && !firstLogPrinted && data.length > 0) {
      console.log('\n[DEBUG] 第一筆 log attributes:');
      console.log(JSON.stringify(data[0].attributes, null, 2));
      firstLogPrinted = true;
    }

    allLogs.push(...data);
    console.log(` ${data.length} 筆（累計 ${allLogs.length}）`);

    const nextCursor = result.meta?.page?.after;
    if (!nextCursor || data.length === 0) break;

    cursor = nextCursor;
    page++;
    await throttleByRateLimit(headers);
  }

  console.log(`  共 ${allLogs.length} 筆\n`);
  return allLogs;
}

// count-only 查詢，不下載明細、不分頁，用於不需要逐筆記錄、只需要總數的場景（例如計算式取得的統計值）
async function fetchAggregateCount(apiKey, appKey, query, fromISO, toISO, retries = 0) {
  const url = `https://${DATADOG_SITE}/api/v2/logs/analytics/aggregate`;
  const headers = { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey };
  const body = JSON.stringify({
    compute: [{ aggregation: 'count' }],
    filter: { query, from: fromISO, to: toISO },
  });

  let res;
  try {
    res = await httpsRequest('POST', url, headers, body);
  } catch (err) {
    if (retries < MAX_RETRIES) {
      console.log(`  [網路錯誤] ${err.message}，10s 後重試 (${retries + 1}/${MAX_RETRIES})...`);
      await sleep(10_000);
      return fetchAggregateCount(apiKey, appKey, query, fromISO, toISO, retries + 1);
    }
    throw err;
  }

  if (res.status === 429) {
    if (retries >= MAX_RETRIES) throw new Error('Rate limit (429) 超過最大重試次數');
    const resetSec = parseInt(res.headers['x-ratelimit-reset'] || res.headers['retry-after'] || '10', 10);
    const waitSec = resetSec + 1;
    console.log(`  [429 Rate Limited] 等待 ${waitSec}s 後重試 (${retries + 1}/${MAX_RETRIES})...`);
    await sleep(waitSec * 1000);
    return fetchAggregateCount(apiKey, appKey, query, fromISO, toISO, retries + 1);
  }

  if (res.status === 500) {
    if (retries >= MAX_RETRIES) throw new Error(`HTTP 500: ${res.body.slice(0, 500)}`);
    console.log(`  [500 Server Error] 30s 後重試 (${retries + 1}/${MAX_RETRIES})...`);
    await sleep(30_000);
    return fetchAggregateCount(apiKey, appKey, query, fromISO, toISO, retries + 1);
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

  return parsed.data?.buckets?.[0]?.computes?.c0 ?? 0;
}

module.exports = { setDebug, fetchAllLogs, fetchAggregateCount };
