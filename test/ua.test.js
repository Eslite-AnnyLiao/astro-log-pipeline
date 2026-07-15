'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseUA, pct } = require('../src/lib/ua');

test('parseUA：空字串／null／undefined → Unknown/Unknown', () => {
  assert.deepEqual(parseUA(''), { browser: 'Unknown', os: 'Unknown' });
  assert.deepEqual(parseUA(null), { browser: 'Unknown', os: 'Unknown' });
  assert.deepEqual(parseUA(undefined), { browser: 'Unknown', os: 'Unknown' });
});

test('parseUA：Chrome on Windows 10/11', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
  assert.deepEqual(parseUA(ua), { browser: 'Chrome 91.0.4472.124', os: 'Windows 10/11' });
});

test('parseUA：Firefox on Linux', () => {
  const ua = 'Mozilla/5.0 (X11; Linux x86_64; rv:91.0) Gecko/20100101 Firefox/91.0';
  assert.deepEqual(parseUA(ua), { browser: 'Firefox 91.0', os: 'Linux' });
});

test('parseUA：Safari on macOS，版本號底線轉句點', () => {
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Safari/605.1.15';
  assert.deepEqual(parseUA(ua), { browser: 'Safari 14.1.2', os: 'macOS 10.15.7' });
});

test('parseUA：Edge（Chromium 版，UA 同時含 Chrome/ 與 Edg/）判斷為 Edge 而非 Chrome', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 Edg/91.0.864.59';
  assert.deepEqual(parseUA(ua), { browser: 'Edge 91.0.864.59', os: 'Windows 10/11' });
});

test('parseUA：StatusCake 監控機器人', () => {
  assert.deepEqual(parseUA('StatusCake'), { browser: 'StatusCake Bot', os: 'Unknown' });
});

test('parseUA：Windows 7 (NT 6.1)', () => {
  assert.equal(parseUA('Windows NT 6.1').os, 'Windows 7');
});

test('parseUA：Android 附帶版本號', () => {
  const ua = 'Mozilla/5.0 (Linux; Android 11; SM-G975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36';
  assert.deepEqual(parseUA(ua), { browser: 'Chrome 91.0.4472.120', os: 'Android 11' });
});

// 真實 iPhone/iPad UA 一律含有字面上的 "like Mac OS X"（版本號不緊接在
// "Mac OS X " 後面，例如 "CPU iPhone OS 17_5 like Mac OS X"），OS 判斷需先比對
// iPhone/iPad 再比對 Mac OS X，否則會被誤判成籠統的 "macOS"。
test('parseUA：真實 iPhone UA（字串同時含 "like Mac OS X"）仍需正確判斷為 iOS (iPhone)', () => {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  assert.deepEqual(parseUA(ua), { browser: 'Safari 17.5', os: 'iOS (iPhone)' });
});

test('parseUA：真實 iPad UA（字串同時含 "like Mac OS X"）仍需正確判斷為 iOS (iPad)', () => {
  const ua = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  assert.deepEqual(parseUA(ua), { browser: 'Safari 17.5', os: 'iOS (iPad)' });
});

test('pct：空陣列 → 0', () => {
  assert.equal(pct([], 50), 0);
});

test('pct：整數索引直接命中，不需內插', () => {
  const sorted = [1, 2, 3, 4, 5];
  assert.equal(pct(sorted, 0), 1);
  assert.equal(pct(sorted, 50), 3);
  assert.equal(pct(sorted, 100), 5);
});

test('pct：索引落在兩點之間時做線性內插', () => {
  const sorted = [1, 2, 3, 4];
  assert.equal(pct(sorted, 50), 2.5);
});
