'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDDLine, formatDDStage, ddSpeedStats, resetDDAttempt } = require('../bin/daily-pipeline');

function freshDisplay() {
  return { dd: { pages: 0, aggregatePages: 0, startTime: null, pagesAtAttemptStart: 0, stage: '' } };
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

test('ddSpeedStats：沒有 resetDDAttempt 時（回歸情境），重試前的空檔時間會混進平均速度——證明舊行為確實會失真', () => {
  const display = freshDisplay();

  // attempt 1：5 頁，耗時模擬 5 秒（startTime 設在 5 秒前）
  display.dd.startTime = Date.now() - 5000;
  display.dd.pages = 5;

  // 卡了很久才重試（60 秒空檔，例如等待 retryAsync 的 delayMs，或行程被中斷到重新啟動之間的間隔）
  // ——如果沒有呼叫 resetDDAttempt，startTime 完全沒被動過，等於這段空檔也會被算進「已耗時」。
  const fakeNow = Date.now() + 60_000;
  const originalNow = Date.now;
  Date.now = () => fakeNow;
  try {
    display.dd.pages = 7; // attempt 2 又新抓了 2 頁，耗時應該很短，但 startTime 還停在 attempt 1 開始的時間點
    const speed = ddSpeedStats(display.dd);
    // 65 秒（5 秒 attempt1 + 60 秒空檔）/ 7 頁 ≈ 9.3s/頁，遠高於實際下載速度，就是使用者看到的誤導數字
    assert.ok(Number(speed.avgS) > 9, `未呼叫 resetDDAttempt 時，平均速度應該被空檔時間拖慢到明顯偏高，實際 ${speed.avgS}`);
  } finally {
    Date.now = originalNow;
  }
});

test('ddSpeedStats + resetDDAttempt：重試後只算「這次嘗試」新增的頁數跟時間，不含等待重試的空檔', () => {
  const display = freshDisplay();

  // attempt 1：5 頁，耗時 5 秒
  display.dd.startTime = Date.now() - 5000;
  display.dd.pages = 5;

  // 重試：resetDDAttempt 把「這次嘗試」的起點重設成現在，pagesAtAttemptStart 記住舊的累計頁數
  resetDDAttempt(display);
  assert.equal(display.dd.pagesAtAttemptStart, 5);
  assert.equal(display.dd.startTime, null);
  assert.equal(display.dd.pages, 5, 'pages 本身的累計值不受影響，不會被重試歸零');

  // 空檔 60 秒後才真的重新開始抓（模擬 retryAsync 的 delayMs，或行程重啟前的等待）
  const afterWaitNow = Date.now() + 60_000;
  const originalNow = Date.now;
  Date.now = () => afterWaitNow;
  try {
    parseDDLine('  第 1 頁... 1000 筆（累計 1000）', display); // 子程序重啟後第一行進度，startTime 在此刻才重新設定
    assert.equal(display.dd.pages, 6);

    // 再過 2 秒又抓了一頁（這次嘗試總共 2 頁，耗時 2 秒——完全不含前面 5 秒 + 60 秒空檔）
    Date.now = () => afterWaitNow + 2000;
    display.dd.pages = 7;
    const speed = ddSpeedStats(display.dd);
    assert.equal(speed.pagesThisAttempt, 2);
    assert.equal(Number(speed.elapsedS), 2);
    assert.equal(speed.avgS, '1.0');
  } finally {
    Date.now = originalNow;
  }
});
