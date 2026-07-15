'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDate,
  toTW,
  hourLabel,
  minuteLabel,
  hmLabel,
  secondLabel,
  buildTWRange,
  buildUTCRange,
} = require('../src/lib/time');

test('normalizeDate：8 碼純數字直接回傳', () => {
  assert.equal(normalizeDate('20260508'), '20260508');
});

test('normalizeDate：YYYY-MM-DD 格式去除分隔符後回傳 8 碼', () => {
  assert.equal(normalizeDate('2026-05-08'), '20260508');
});

test('normalizeDate：清除非數字後長度不足 8 碼 → null', () => {
  assert.equal(normalizeDate('2026-5-8'), null);
});

test('normalizeDate：空字串 → null', () => {
  assert.equal(normalizeDate(''), null);
});

test('toTW：UTC ISO 字串轉台灣時區（+8 小時），含毫秒', () => {
  assert.equal(toTW('2026-05-08T02:00:00.000Z'), '2026-05-08 10:00:00.000');
});

test('toTW：跨日邊界（UTC 20:00 → 台灣時區為隔天 04:00）', () => {
  assert.equal(toTW('2026-05-08T20:00:00.000Z'), '2026-05-09 04:00:00.000');
});

test('toTW：字串前後夾單引號時會先被去除', () => {
  assert.equal(toTW("'2026-05-08T02:00:00.000Z'"), '2026-05-08 10:00:00.000');
});

test('toTW：無法解析的日期字串 → null', () => {
  assert.equal(toTW('not-a-date'), null);
});

test('hourLabel：只取到小時，分鐘/秒歸零', () => {
  assert.equal(hourLabel('2026-05-08T02:30:45.000Z'), '2026-05-08 10:00');
});

test('minuteLabel：取到分鐘', () => {
  assert.equal(minuteLabel('2026-05-08T02:30:45.000Z'), '2026-05-08 10:30');
});

test('hmLabel：只回傳 HH:MM，不含日期', () => {
  assert.equal(hmLabel('2026-05-08T02:30:45.000Z'), '10:30');
});

test('secondLabel：取到秒', () => {
  assert.equal(secondLabel('2026-05-08T02:30:45.000Z'), '2026-05-08 10:30:45');
});

test('buildTWRange：回傳台灣時區當日 00:00:00 ~ 23:59:59 的 ISO 字串（+08:00 offset）', () => {
  assert.deepEqual(buildTWRange('20260508'), {
    fromISO: '2026-05-08T00:00:00+08:00',
    toISO: '2026-05-08T23:59:59+08:00',
  });
});

test('buildUTCRange：台灣時區當日對應的 UTC 範圍會落在前一天下午（-8 小時）', () => {
  const r = buildUTCRange('20260508');
  assert.equal(r.startDisplay, '2026-05-07 16:00:00');
  assert.equal(r.endDisplay, '2026-05-08 15:59:59');
  assert.equal(r.toMs - r.fromMs, 24 * 3600 * 1000 - 1);
});

test('buildUTCRange：月份／年份邊界（1/1 台灣時區換算後跨到前一年 12/31 UTC）', () => {
  const r = buildUTCRange('20260101');
  assert.equal(r.startDisplay, '2025-12-31 16:00:00');
});
