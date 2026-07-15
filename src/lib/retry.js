'use strict';

const { sleep } = require('./http');

// 個別步驟（CF fetcher / DD fetcher）整支子程序失敗時的重試包裝，
// 跟各自 client.js 內部的單一 API 呼叫重試是不同層級：這裡重試的是整個
// spawn 出去的 fetcher script，用於 script 啟動失敗、或內部重試全部用盡後仍失敗的情況。
async function retryAsync(fn, { attempts = 3, delayMs = 0, onError } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (onError) onError(err, attempt);
      if (attempt < attempts && delayMs > 0) await sleep(delayMs);
    }
  }
  throw lastErr;
}

module.exports = { retryAsync };
