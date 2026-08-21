'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDDLine, formatDDStage } = require('../bin/daily-pipeline');

function freshDisplay() {
  return { dd: { pages: 0, aggregatePages: 0, startTime: null, stage: '' } };
}

test('formatDDStage：subQuery variant（如 product-ssr）換成「頁面類型 明細」', () => {
  assert.equal(formatDDStage('product-ssr'), '商品頁 明細');
  assert.equal(formatDDStage('category-ssr'), '分類頁 明細');
});

test('formatDDStage：404 aggregate label（如 404-product）換成「頁面類型 404 聚合查詢」', () => {
  assert.equal(formatDDStage('404-product'), '商品頁 404 聚合查詢');
});

test('formatDDStage：404 windowed label（如 "404-product 00:00-04:00"）換成「頁面類型 404（時間窗）」', () => {
  assert.equal(formatDDStage('404-product 00:00-04:00'), '商品頁 404（00:00-04:00）');
  assert.equal(formatDDStage('404-category 16:00-20:00'), '分類頁 404（16:00-20:00）');
});

test('formatDDStage：不認得的 label 原樣回傳，不噴錯', () => {
  assert.equal(formatDDStage('unknown-thing'), 'unknown-thing');
});

test('parseDDLine：看到 "[label] Query:" 這種區段標記會更新 display.dd.stage', () => {
  const display = freshDisplay();
  parseDDLine('[product-ssr] Query: @cloudflare.script_name:x @service:ssr-product-page @name:page-render', display);
  assert.equal(display.dd.stage, '商品頁 明細');

  parseDDLine('[404-product] Aggregate Query: @cloudflare.script_name:x', display);
  assert.equal(display.dd.stage, '商品頁 404 聚合查詢');

  parseDDLine('[404-category 04:00-08:00] Query: @cloudflare.script_name:x', display);
  assert.equal(display.dd.stage, '分類頁 404（04:00-08:00）');
});

test('parseDDLine：頁碼計數器只會累加，不會因為新的區段標記或字面頁碼變小而倒退（模擬 process 級重試時同一個 display 物件持續累計）', () => {
  const display = freshDisplay();

  // 模擬 attempt 1：product-ssr 抓到第 2332 頁後中斷
  for (let i = 1; i <= 5; i++) parseDDLine(`  第 ${i} 頁... 1000 筆（累計 ${i * 1000}）`, display);
  assert.equal(display.dd.pages, 5);

  // 模擬 attempt 2（真實情境是全新 child process，重跑後從 checkpoint 續傳，子程序自己印出的
  // 頁碼字面上可能又是「第 1 頁」開始描述新的區段，但 display 物件本身沒有被重置）：
  // 累計計數器應該繼續往上加，不會因為文字裡的頁碼變小而倒退回去，也不會歸零。
  parseDDLine('[404-product] Aggregate Query: ...', display);
  parseDDLine('  aggregate 第 1 頁... 10000 buckets（累計 10000 key）', display);
  assert.equal(display.dd.aggregatePages, 1);
  assert.equal(display.dd.pages, 5, '一般頁碼計數器不該被 aggregate 頁面影響');

  parseDDLine('[404-product 00:00-04:00] Query: ...', display);
  parseDDLine('  第 1 頁... 200 筆（累計 200）', display);
  assert.equal(display.dd.pages, 6, '即使子程序印出的字面頁碼是「第 1 頁」，累計計數器仍然只會繼續往上加');
});
