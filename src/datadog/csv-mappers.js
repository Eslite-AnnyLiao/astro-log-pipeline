'use strict';

const { csvRow } = require('../lib/csv');

function formatDuration(raw) {
  if (raw == null || raw === '') return '';
  const n = Number(raw);
  if (isNaN(n)) return String(raw);
  // Datadog duration 單位可能是 ns，>10000 視為 ns → 轉 ms
  return n > 10_000 ? `${Math.round(n / 1_000_000)}ms` : `${Math.round(n)}ms`;
}

// 泛化版 CSV 產生器：columnsSpec = { header, mapRow(log) => [欄位值...] }
function logsToCsv(logs, columnsSpec) {
  const rows = [columnsSpec.header];
  for (const log of logs) {
    rows.push(csvRow(...columnsSpec.mapRow(log)));
  }
  return rows.join('\n');
}

function ssrMapRow(log) {
  const attr = log.attributes || {};
  const custom = attr.attributes || {};
  return [attr.timestamp || '', custom.user_agent ?? '', formatDuration(custom.duration ?? custom['@duration']), attr.message || ''];
}

function categoryMapRow(log) {
  const attr = log.attributes || {};
  const custom = attr.attributes || {};
  return [
    attr.timestamp || '', custom.user_agent ?? '', formatDuration(custom.duration ?? custom['@duration']),
    custom.L1 ?? '', custom.L2 ?? '', custom.L3 ?? '', attr.message || '',
  ];
}

function extractProductId(custom) {
  return custom.productId ?? custom['@productId'] ?? custom.product_id ?? custom['@product_id'] ?? null;
}

// 分類頁沒有 product_id，改用 L1/L2/L3 組出 key，帶層級標籤避免看不出是哪一層，
// 例如 "L2=35718" 或 "L1=1/L2=12/L3=35718"
function extractCategoryKey(custom) {
  const levels = ['L1', 'L2', 'L3']
    .filter((lvl) => custom[lvl] != null && custom[lvl] !== '')
    .map((lvl) => `${lvl}=${custom[lvl]}`);
  return levels.length ? levels.join('/') : null;
}

// 回傳 Map<key, Set<traceId>>（key 由 extractKeyFn 決定，商品頁是 productId，分類頁是 L1/L2/L3）
// 同一次 page load（相同 trace_id）的不同 API 404 算同一次
function process404Logs(logs, extractKeyFn) {
  const result = new Map(); // key -> Set<traceId>
  for (const log of logs) {
    const attr = log.attributes || {};
    const custom = attr.attributes || {};

    if (Number(custom.httpStatus) !== 404) continue;

    const key = extractKeyFn(custom);
    if (!key) continue;

    const traceId = custom.otel?.trace_id ?? attr.timestamp ?? '';

    if (!result.has(key)) result.set(key, new Set());
    result.get(key).add(traceId);
  }
  return result;
}

function logs404ToCsv(result, keyLabel) {
  const rows = [`${keyLabel},404 次數`];
  for (const [key, traces] of result) {
    rows.push(csvRow(key, String(traces.size)));
  }
  return rows.join('\n');
}

module.exports = {
  formatDuration,
  logsToCsv,
  ssrMapRow,
  categoryMapRow,
  extractProductId,
  extractCategoryKey,
  process404Logs,
  logs404ToCsv,
};
