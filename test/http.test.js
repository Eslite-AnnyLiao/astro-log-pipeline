'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { httpsRequest } = require('../src/lib/http');

// 模擬曾經發生過的卡死情境：TCP 連線建立成功，但對方完全沒有回應（連 TLS handshake 都沒完成），
// 也沒有送 FIN/RST——這種情況不會觸發 req 的 'error' 事件，過去會讓 httpsRequest 的 Promise
// 永遠不 resolve 也不 reject，await 端因此無限期卡住（datadog-log-fetcher.js 卡死 2 小時的根因）。
test('httpsRequest：連線後對方毫無回應，超過 timeout 要 reject 而不是永遠卡住', async () => {
  const server = net.createServer((socket) => {
    // 刻意什麼都不做
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    await assert.rejects(
      () => httpsRequest('POST', `https://127.0.0.1:${port}/`, {}, '{}', 200),
      /逾時/,
    );
  } finally {
    server.close();
  }
});
