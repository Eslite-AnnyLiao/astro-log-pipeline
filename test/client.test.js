'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../src/lib/http');
const { fetchAllLogs, fetchAggregate404Counts } = require('../src/datadog/client');

// x-ratelimit-remaining > 0 讓 throttleByRateLimit 走 300ms 的短分支，測試才不會被拖慢
function makeRes(data, cursor) {
  return {
    status: 200,
    headers: { 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': '10' },
    body: JSON.stringify({ data, meta: cursor ? { page: { after: cursor } } : {} }),
  };
}

function makeAggregateRes(buckets, cursor) {
  return {
    status: 200,
    headers: { 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': '10' },
    body: JSON.stringify({ data: { buckets }, meta: cursor ? { page: { after: cursor } } : {} }),
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

test('fetchAggregate404Counts：用 group_by + cardinality 查 404 統計，並用 cursor 拉下一頁', async (t) => {
  const requests = [];
  t.mock.method(http, 'httpsRequest', async (_method, _url, _headers, body) => {
    const parsedBody = JSON.parse(body);
    requests.push(parsedBody);
    if (requests.length === 1) {
      return makeAggregateRes([
        { by: { productId: 'p1' }, computes: { c0: 3, c1: 2 } },
      ], 'cursor-1');
    }
    return makeAggregateRes([
      { by: { '@productId': 'p2' }, computes: { c0: 1, c1: 1 } },
    ]);
  });

  const result = await fetchAggregate404Counts('key', 'app', {
    query: '@service:ssr-product-page @name:page-render @httpStatus:404',
    groupByFacets: ['@productId'],
    traceFacet: '@otel.trace_id',
  }, 'from', 'to', '404-product');

  assert.deepEqual(result.rows, [
    { key: 'p1', count: 2, rawCount: 3 },
    { key: 'p2', count: 1, rawCount: 1 },
  ]);
  assert.equal(result.rawCountTotal, 4);
  assert.equal(result.distinctCountTotal, 3);
  assert.deepEqual(requests[0].compute, [
    { type: 'total', aggregation: 'count' },
    { type: 'total', aggregation: 'cardinality', metric: '@otel.trace_id' },
  ]);
  assert.deepEqual(requests[0].group_by, [
    {
      type: 'facet',
      facet: '@productId',
      limit: 10000,
      sort: { type: 'alphabetical', order: 'asc' },
    },
  ]);
  assert.equal(requests[1].page.cursor, 'cursor-1');
});

test('fetchAggregate404Counts：多 facet group_by 會組回 L1/L2/L3 key', async (t) => {
  t.mock.method(http, 'httpsRequest', async () => makeAggregateRes([
    { by: { L1: '1', L2: '12', L3: '35718' }, computes: { c0: 4, c1: 2 } },
  ]));

  const result = await fetchAggregate404Counts('key', 'app', {
    query: '@service:ssr-category-page @name:page-render @httpStatus:404',
    groupByFacets: ['@L1', '@L2', '@L3'],
    keyLabels: ['L1', 'L2', 'L3'],
    traceFacet: '@otel.trace_id',
  }, 'from', 'to', '404-category');

  assert.deepEqual(result.rows, [
    { key: 'L1=1/L2=12/L3=35718', count: 2, rawCount: 4 },
  ]);
});

test('fetchAggregate404Counts：bucket 有資料但缺 c1 時丟錯，避免 cardinality 欄位設錯後寫出 0', async (t) => {
  t.mock.method(http, 'httpsRequest', async () => makeAggregateRes([
    { by: { productId: 'p1' }, computes: { c0: 3 } },
  ]));

  await assert.rejects(
    fetchAggregate404Counts('key', 'app', {
      query: '@service:ssr-product-page @name:page-render @httpStatus:404',
      groupByFacets: ['@productId'],
      traceFacet: '@trace_id',
    }, 'from', 'to', '404-product'),
    /沒有回傳 cardinality compute c1/,
  );
});

test('fetchAggregate404Counts：Datadog bucket paging 上限錯誤會帶 code，供 fetcher fallback', async (t) => {
  let call = 0;
  const errors = [
    'invalid_argument(Reached paging limit of 1000 values.)',
    'invalid_argument(Cannot generate more than 10000 groups across all dimensions. Consider specifying or adjusting the limit parameters.)',
  ];
  t.mock.method(http, 'httpsRequest', async () => {
    const body = JSON.stringify({ errors: [errors[call]] });
    call++;
    return { status: 400, headers: {}, body };
  });

  await assert.rejects(
    fetchAggregate404Counts('key', 'app', {
      query: '@service:ssr-product-page @name:page-render @httpStatus:404',
      groupByFacets: ['@productId'],
      traceFacet: '@otel.trace_id',
    }, 'from', 'to', '404-product'),
    (err) => err.code === 'DATADOG_AGGREGATE_PAGING_LIMIT',
  );
  await assert.rejects(
    fetchAggregate404Counts('key', 'app', {
      query: '@service:ssr-category-page @name:page-render @httpStatus:404',
      groupByFacets: ['@L1', '@L2', '@L3'],
      traceFacet: '@otel.trace_id',
    }, 'from', 'to', '404-category'),
    (err) => err.code === 'DATADOG_AGGREGATE_PAGING_LIMIT',
  );
});
