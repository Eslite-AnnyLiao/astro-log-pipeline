'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { retryAsync } = require('../src/lib/retry');

test('retryAsync：前兩次失敗、第三次成功 → 自動重試後回傳成功結果', async () => {
  let calls = 0;
  const result = await retryAsync(async (attempt) => {
    calls++;
    if (attempt < 3) throw new Error(`fail-${attempt}`);
    return 'ok';
  }, { attempts: 3, delayMs: 0 });
  assert.equal(result, 'ok');
  assert.equal(calls, 3); // 確認真的重試了兩次才成功，不是第一次就過
});

test('retryAsync：所有嘗試都失敗 → 用盡重試次數後拋出最後一次的錯誤，不吞掉失敗', async () => {
  let calls = 0;
  await assert.rejects(
    () => retryAsync(async (attempt) => {
      calls++;
      throw new Error(`fail-${attempt}`);
    }, { attempts: 3, delayMs: 0 }),
    /fail-3/,
  );
  assert.equal(calls, 3);
});

test('retryAsync：第一次成功就不重試', async () => {
  let calls = 0;
  const result = await retryAsync(async () => {
    calls++;
    return 'ok';
  }, { attempts: 3, delayMs: 0 });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});
