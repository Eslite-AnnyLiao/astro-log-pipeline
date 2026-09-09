'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCFLine } = require('../bin/daily-pipeline');

function freshDisplay() {
  return { cf: { hours: 0, hits: 0, done: false, error: null } };
}

test('parseCFLine：slot 進度行累加 hours（跨小時範圍算時數）', () => {
  const display = freshDisplay();
  parseCFLine('  08:00~12:00 (TW) ', display);
  assert.equal(display.cf.hours, 4);
});

test('parseCFLine：Routing target 總數行累加進 hits（client.js fetchSingleTypeLogs 印的格式）', () => {
  const display = freshDisplay();
  parseCFLine('Routing target astro-ssr: 522152 次', display);
  assert.equal(display.cf.hits, 522152);
});

test('parseCFLine：Astro cache hit astro-ssg 總數行累加進 hits', () => {
  const display = freshDisplay();
  parseCFLine('Astro cache hit astro-ssg: 380 次', display);
  assert.equal(display.cf.hits, 380);
});

test('parseCFLine：商品頁一輪查詢會分開印 Routing target 跟 SSG 兩行，兩者都要累加（回歸測試：\
舊版 fetchAllLogs 印在同一行 "SSR: N 次  SSG: N 次"，重構成分開兩行印後 parseCFLine 曾經完全比對不到、\
display.cf.hits 卡在 0）', () => {
  const display = freshDisplay();
  parseCFLine('Routing target astro-ssr: 522152 次', display);
  parseCFLine('Astro cache hit astro-ssg: 380 次', display);
  assert.equal(display.cf.hits, 522152 + 380);
});

test('parseCFLine：分類頁沒有 SSG，只會印 Routing target 那行，hits 只算這一行', () => {
  const display = freshDisplay();
  parseCFLine('Routing target astro-ssr: 4325 次', display);
  assert.equal(display.cf.hits, 4325);
});

test('parseCFLine：不相關的行不影響 hours/hits', () => {
  const display = freshDisplay();
  parseCFLine('查詢時間範圍 (UTC): 2026-09-08T00:00:00.000Z ~ 2026-09-08T23:59:59.999Z', display);
  assert.equal(display.cf.hours, 0);
  assert.equal(display.cf.hits, 0);
});
