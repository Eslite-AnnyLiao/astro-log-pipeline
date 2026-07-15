'use strict';

// mergeCloudflareIntoCombined / mergeErrors404IntoCombined 是直接依 PROJECT_ROOT
// 組出固定的 daily-analysis-result / to-analyze-daily-data 路徑，沒有可注入的
// base dir，所以這裡用一個現實中不會出現的假日期（19700101）在專案實際目錄下
// 建立/清除 fixture，避免跟真實資料衝突；每個 test 用 try/finally 確保不留殘檔。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mergeCloudflareIntoCombined, mergeErrors404IntoCombined } = require('../bin/daily-pipeline.js');

const PROJECT_ROOT = path.join(__dirname, '..');
const DATE = '19700101';
const KIND = 'product';

const cfPath = path.join(PROJECT_ROOT, `./daily-analysis-result/cloudflare/${KIND}/cloudflare-cache-hit-product-${DATE}.json`);
const combinedPath = path.join(PROJECT_ROOT, `./daily-analysis-result/datadog-export/combined/combined-${DATE}_analysis.json`);
const csvPath = path.join(PROJECT_ROOT, `./to-analyze-daily-data/product/404-errors/404-errors-${DATE}.csv`);

function cleanup() {
  for (const p of [cfPath, combinedPath, csvPath]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

test('mergeCloudflareIntoCombined：CF JSON 不存在 → 回傳 false，不寫入任何東西', () => {
  cleanup();
  try {
    assert.equal(fs.existsSync(cfPath), false);
    const merged = mergeCloudflareIntoCombined(DATE, KIND);
    assert.equal(merged, false);
    assert.equal(fs.existsSync(combinedPath), false);
  } finally {
    cleanup();
  }
});

test('mergeCloudflareIntoCombined：CF JSON 存在但 combined JSON 不存在 → 回傳 false，略過 merge', () => {
  cleanup();
  try {
    ensureDir(cfPath);
    fs.writeFileSync(cfPath, JSON.stringify({ total_ssr_hits: 1, total_ssg_hits: 2, total_hits: 3, hourly: {} }), 'utf8');
    const merged = mergeCloudflareIntoCombined(DATE, KIND);
    assert.equal(merged, false);
    assert.equal(fs.existsSync(combinedPath), false);
  } finally {
    cleanup();
  }
});

test('mergeCloudflareIntoCombined：兩者都存在 → 寫入 cache hit 數據，保留 combined 原有的其他欄位', () => {
  cleanup();
  try {
    ensureDir(cfPath);
    fs.writeFileSync(cfPath, JSON.stringify({ total_ssr_hits: 10, total_ssg_hits: 20, total_hits: 30, hourly: { '10:00': 5 } }), 'utf8');
    ensureDir(combinedPath);
    fs.writeFileSync(combinedPath, JSON.stringify({ existing_key: 'keep-me' }), 'utf8');

    const merged = mergeCloudflareIntoCombined(DATE, KIND);
    assert.equal(merged, true);

    const combined = JSON.parse(fs.readFileSync(combinedPath, 'utf8'));
    assert.equal(combined.existing_key, 'keep-me'); // 原有欄位沒被覆蓋掉
    assert.deepEqual(combined.cloudflare_cache_hit, {
      total_ssr_hits: 10, total_ssg_hits: 20, total_hits: 30, hourly: { '10:00': 5 },
    });
  } finally {
    cleanup();
  }
});

test('mergeErrors404IntoCombined：404 CSV 不存在 → 回傳 false', () => {
  cleanup();
  try {
    const merged = mergeErrors404IntoCombined(DATE, KIND);
    assert.equal(merged, false);
  } finally {
    cleanup();
  }
});

test('mergeErrors404IntoCombined：解析 CSV 並依次數彙總、排序 top10，寫入 combined JSON', () => {
  cleanup();
  try {
    ensureDir(csvPath);
    const csv = ['product_id,404 次數', 'p1,5', 'p2,10', 'p3,5'].join('\n');
    fs.writeFileSync(csvPath, csv, 'utf8');
    ensureDir(combinedPath);
    fs.writeFileSync(combinedPath, JSON.stringify({}), 'utf8');

    const merged = mergeErrors404IntoCombined(DATE, KIND);
    assert.equal(merged, true);

    const combined = JSON.parse(fs.readFileSync(combinedPath, 'utf8'));
    const errors = combined.errors_404;
    assert.equal(errors.total_404_count, 20); // 5+10+5
    assert.equal(errors.affected_product_count, 3);
    assert.deepEqual(errors.distribution, { 5: 2, 10: 1 }); // 兩筆是 5 次，一筆是 10 次
    assert.equal(errors.top10[0].product_id, 'p2'); // 次數最高排第一
    assert.equal(errors.top10[0].count, 10);
  } finally {
    cleanup();
  }
});
