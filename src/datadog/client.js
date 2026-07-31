'use strict';

const http = require('../lib/http');
const { sleep } = http;

const DATADOG_SITE = 'api.us5.datadoghq.com';
const PAGE_LIMIT = 1000;
const AGGREGATE_BUCKET_LIMIT = 10000;
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
    res = await http.httpsRequest('POST', url, headers, JSON.stringify(params));
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

async function fetchAggregatePage(apiKey, appKey, params, retries = 0) {
  const url = `https://${DATADOG_SITE}/api/v2/logs/analytics/aggregate`;
  const headers = { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey };

  if (DEBUG) {
    console.log(`\n[DEBUG] POST ${url}`);
    console.log('[DEBUG] headers:', JSON.stringify(headers));
    console.log('[DEBUG] Request body:');
    console.log(JSON.stringify(params, null, 2));
  }

  let res;
  try {
    res = await http.httpsRequest('POST', url, headers, JSON.stringify(params));
  } catch (err) {
    if (retries < MAX_RETRIES) {
      console.log(`  [網路錯誤] ${err.message}，10s 後重試 (${retries + 1}/${MAX_RETRIES})...`);
      await sleep(10_000);
      return fetchAggregatePage(apiKey, appKey, params, retries + 1);
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
    const resetSec = parseInt(res.headers['x-ratelimit-reset'] || res.headers['retry-after'] || '10', 10);
    const waitSec = resetSec + 1;
    console.log(`  [429 Rate Limited] 等待 ${waitSec}s 後重試 (${retries + 1}/${MAX_RETRIES})...`);
    await sleep(waitSec * 1000);
    return fetchAggregatePage(apiKey, appKey, params, retries + 1);
  }

  if ([408, 500, 502, 503, 504].includes(res.status)) {
    if (retries >= MAX_RETRIES) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 500)}`);
    console.log(`  [${res.status} Aggregate 暫時失敗] 30s 後重試 (${retries + 1}/${MAX_RETRIES})...`);
    await sleep(30_000);
    return fetchAggregatePage(apiKey, appKey, params, retries + 1);
  }

  if (res.status !== 200) {
    const err = new Error(`HTTP ${res.status}: ${res.body.slice(0, 500)}`);
    if (
      res.status === 400
      && (
        res.body.includes('Reached paging limit of 1000 values')
        || res.body.includes('Cannot generate more than 10000 groups across all dimensions')
      )
    ) {
      err.code = 'DATADOG_AGGREGATE_PAGING_LIMIT';
    }
    throw err;
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

// onPage 為 optional callback：傳了就每頁呼叫 onPage(data) 而不在記憶體中累積整批 log
// （給量體可能上看百萬筆的查詢用，避免整批常駐記憶體導致 OOM），回傳總筆數而非陣列。
// 不傳 onPage 時行為與過去一致：回傳累積好的完整 log 陣列，供小量查詢或測試使用。
async function fetchAllLogs(apiKey, appKey, query, fromISO, toISO, label, onPage) {
  console.log(`[${label}] Query: ${query}`);

  const allLogs = onPage ? null : [];
  let cursor = null;
  let page = 1;
  let total = 0;
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

    if (onPage) {
      await onPage(data);
    } else {
      allLogs.push(...data);
    }
    total += data.length;
    console.log(` ${data.length} 筆（累計 ${total}）`);

    const nextCursor = result.meta?.page?.after;
    if (!nextCursor || data.length === 0) break;

    cursor = nextCursor;
    page++;
    await throttleByRateLimit(headers);
  }

  console.log(`  共 ${total} 筆\n`);
  return onPage ? total : allLogs;
}

// count-only 查詢，不下載明細、不分頁，用於不需要逐筆記錄、只需要總數的場景（例如計算式取得的統計值）
async function fetchAggregateCount(apiKey, appKey, query, fromISO, toISO, retries = 0) {
  const { parsed } = await fetchAggregatePage(apiKey, appKey, {
    compute: [{ aggregation: 'count' }],
    filter: { query, from: fromISO, to: toISO },
  });

  return parsed.data?.buckets?.[0]?.computes?.c0 ?? 0;
}

function facetValue(by, facet) {
  const plain = facet.replace(/^@/, '');
  return by[facet] ?? by[plain] ?? null;
}

function bucketKey(bucket, groupByFacets, keyLabels) {
  const by = bucket.by || {};
  if (groupByFacets.length === 1) {
    return facetValue(by, groupByFacets[0]);
  }

  const parts = groupByFacets
    .map((facet, idx) => {
      const value = facetValue(by, facet);
      if (value == null || value === '') return null;
      return `${keyLabels?.[idx] || facet.replace(/^@/, '')}=${value}`;
    })
    .filter(Boolean);
  return parts.length ? parts.join('/') : null;
}

async function fetchAggregate404Counts(apiKey, appKey, config, fromISO, toISO, label) {
  console.log(`[${label}] Aggregate Query: ${config.query}`);
  console.log(`  group_by=${config.groupByFacets.join(', ')} cardinality=${config.traceFacet}`);

  const rows = [];
  const bucketLimit = config.bucketLimit || AGGREGATE_BUCKET_LIMIT;
  let cursor = null;
  let page = 1;
  let rawCountTotal = 0;
  let distinctCountTotal = 0;

  while (true) {
    const params = {
      compute: [
        { type: 'total', aggregation: 'count' },
        { type: 'total', aggregation: 'cardinality', metric: config.traceFacet },
      ],
      filter: { query: config.query, from: fromISO, to: toISO },
      group_by: config.groupByFacets.map((facet) => ({
        type: 'facet',
        facet,
        limit: bucketLimit,
        sort: { type: 'alphabetical', order: 'asc' },
      })),
      ...(cursor ? { page: { cursor } } : {}),
    };

    process.stdout.write(`  aggregate 第 ${page} 頁...`);
    const { parsed: result, headers } = await fetchAggregatePage(apiKey, appKey, params);
    const buckets = result.data?.buckets || [];

    for (const bucket of buckets) {
      const key = bucketKey(bucket, config.groupByFacets, config.keyLabels);
      if (!key) continue;
      if (!Object.prototype.hasOwnProperty.call(bucket.computes || {}, 'c1')) {
        throw new Error(`Aggregate API 沒有回傳 cardinality compute c1，請確認 traceFacet "${config.traceFacet}" 是可做 cardinality 的欄位`);
      }
      const rawCount = Number(bucket.computes?.c0 ?? 0);
      const distinctCount = Number(bucket.computes?.c1 ?? 0);
      rows.push({ key, count: distinctCount, rawCount });
      rawCountTotal += rawCount;
      distinctCountTotal += distinctCount;
    }

    console.log(` ${buckets.length} buckets（累計 ${rows.length} key）`);

    const nextCursor = result.meta?.page?.after;
    if (!nextCursor || buckets.length === 0) {
      if (!nextCursor && buckets.length === bucketLimit) {
        console.log(`  ⚠️  最後一頁剛好等於 limit=${bucketLimit}，請用 Datadog UI/API spot check 是否有截斷`);
      }
      break;
    }

    cursor = nextCursor;
    page++;
    await throttleByRateLimit(headers);
  }

  console.log(`  共 ${rows.length} 個 key，raw count ${rawCountTotal}，distinct trace count ${distinctCountTotal}\n`);
  return { rows, rawCountTotal, distinctCountTotal };
}

module.exports = { setDebug, fetchAllLogs, fetchAggregateCount, fetchAggregate404Counts };
