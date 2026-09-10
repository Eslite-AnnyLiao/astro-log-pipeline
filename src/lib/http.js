'use strict';

const https = require('https');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_TIMEOUT_MS = 60_000;

// timeoutMs 監控的是「socket 閒置多久沒有任何資料進出」，不是整個請求的總時長——連線建立、
// TLS handshake 卡住不動也算閒置，會觸發。底層連線靜默斷線但沒送 FIN/RST 時（不會觸發
// req 的 'error' 事件）就是靠這個 timeout 讓 Promise 有機會 reject，交給呼叫端既有的重試
// 邏輯處理，而不是永遠卡在 await（曾發生 datadog-log-fetcher.js 卡死 2 小時、無錯誤也無進度）。
function httpsRequest(method, urlStr, headers, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const bodyBuf = body ? Buffer.from(body, 'utf8') : null;
    const opts = {
      hostname: u.hostname,
      ...(u.port ? { port: u.port } : {}),
      path: u.pathname + u.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {}),
        ...headers,
      },
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`請求逾時：${timeoutMs}ms 內沒有任何回應（${method} ${u.hostname}${u.pathname}）`));
    });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

module.exports = { sleep, httpsRequest };
