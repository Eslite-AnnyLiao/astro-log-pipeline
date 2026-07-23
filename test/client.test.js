'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../src/lib/http');
const { fetchAllLogs } = require('../src/datadog/client');

// x-ratelimit-remaining > 0 讓 throttleByRateLimit 走 300ms 的短分支，測試才不會被拖慢
function makeRes(data, cursor) {
  return {
    status: 200,
    headers: { 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': '10' },
    body: JSON.stringify({ data, meta: cursor ? { page: { after: cursor } } : {} }),
  };
}

test('fetchAllLogs：不傳 onPage 時回傳完整陣列（既有行為不變）', async (t) => {
  let call = 0;
  t.mock.method(http, 'httpsRequest', async () => {
    call++;
    if (call === 1) return makeRes([{ id: 1 }, { id: 2 }], 'cursor-1');
    return makeRes([{ id: 3 }]);
  });

  const logs = await fetchAllLogs('key', 'app', 'query', 'from', 'to', 'label');
  assert.deepEqual(logs, [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test('fetchAllLogs：傳 onPage 時逐頁呼叫 callback、回傳總筆數而非陣列', async (t) => {
  let call = 0;
  t.mock.method(http, 'httpsRequest', async () => {
    call++;
    if (call === 1) return makeRes([{ id: 1 }, { id: 2 }], 'cursor-1');
    return makeRes([{ id: 3 }]);
  });

  const pages = [];
  const total = await fetchAllLogs('key', 'app', 'query', 'from', 'to', 'label', async (page) => {
    pages.push(page);
  });

  assert.equal(total, 3);
  assert.deepEqual(pages, [[{ id: 1 }, { id: 2 }], [{ id: 3 }]]);
});

test('fetchAllLogs：傳 onPage 時會等上一頁的 onPage 做完才抓下一頁（backpressure 排序保證，避免無界累積）', async (t) => {
  let call = 0;
  t.mock.method(http, 'httpsRequest', async () => {
    call++;
    if (call === 1) return makeRes([{ id: 1 }], 'cursor-1');
    return makeRes([{ id: 2 }]);
  });

  const events = [];
  await fetchAllLogs('key', 'app', 'query', 'from', 'to', 'label', async (page) => {
    events.push(`start-${page[0].id}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push(`end-${page[0].id}`);
  });

  // 若沒有正確 await onPage，第 2 頁的請求會在第 1 頁的 onPage 做完前就被送出，順序會亂掉
  assert.deepEqual(events, ['start-1', 'end-1', 'start-2', 'end-2']);
});
