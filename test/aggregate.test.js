'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { toTW } = require('../src/lib/time');
const {
  parseDurationMs,
  extractReqId,
  readCSV,
  buildAggregates,
  calcRenderStats,
  calcHourlyRenderStats,
  calcMinuteStats,
  calcPeakMinuteUA,
  calcHighFreq,
  calcUAStats,
  calcUrlStats,
  calcSlowHM,
} = require('../src/analyzer/aggregate');

const SSR_VARIANT = {
  excludeUserAgents: ['EsliteDeployValidator/1.0'],
  extraBreakdown: { idField: 'productId', aggKey: 'productIdCount' },
  urlBuilder: (rec) => (rec.reqId ? `/product/${rec.reqId}` : null),
};

test('parseDurationMs：支援 ms/s 兩種單位字串，格式不符回傳 null', () => {
  assert.equal(parseDurationMs('500ms'), 500);
  assert.equal(parseDurationMs('1.5s'), 1500);
  assert.equal(parseDurationMs(''), null);
  assert.equal(parseDurationMs('abc'), null);
});

test('extractReqId：從 "page-render | xxx" 格式取出 request id', () => {
  assert.equal(extractReqId('page-render | req-123'), 'req-123');
  assert.equal(extractReqId('other content'), null);
  assert.equal(extractReqId(''), null);
});

test('readCSV：依 variantConfig 排除 UA、組出 reqId/productId/categoryKey/url', () => {
  const tmpFile = path.join(os.tmpdir(), `readcsv-test-${Date.now()}.csv`);
  const csv = [
    'Date,User agent,Duration,Content,@product_id',
    '2026-05-08T02:00:00.000Z,UA1,500ms,"page-render | req-1",p1',
    '2026-05-08T02:01:00.000Z,EsliteDeployValidator/1.0,10ms,"page-render | req-2",p2',
  ].join('\n');
  fs.writeFileSync(tmpFile, csv, 'utf8');

  return readCSV(tmpFile, SSR_VARIANT).then((records) => {
    fs.unlinkSync(tmpFile);
    assert.equal(records.length, 1); // 排除 UA 那筆被濾掉
    assert.equal(records[0].reqId, 'req-1');
    assert.equal(records[0].productId, 'p1');
    assert.equal(records[0].durationMs, 500);
    assert.equal(records[0].url, '/product/req-1');
  });
});

test('buildAggregates：依日期分桶計數，並算出 extraBreakdown', () => {
  const records = [
    { date: '2026-05-08T02:00:00.000Z', userAgent: 'UA1', url: '/product/1', durationMs: 500, productId: 'p1' },
    { date: '2026-05-08T02:00:30.000Z', userAgent: 'UA1', url: '/product/1', durationMs: 4000, productId: 'p1' },
    { date: '', userAgent: 'UA2', url: '/product/2', durationMs: 100, productId: 'p2' }, // 無 date，整筆略過
  ];
  const agg = buildAggregates(records, SSR_VARIANT);

  assert.deepEqual(agg.hourCount, { '2026-05-08 10:00': 2 });
  assert.deepEqual(agg.uaCount, { UA1: 2 });
  assert.deepEqual(agg.urlCount, { '/product/1': 2 });
  assert.equal(agg.renderItems.length, 2);
  assert.equal(agg.slowItems.length, 1); // 只有 4000ms 那筆 >= 3000
  assert.deepEqual(agg.productIdCount, { p1: 2 });
});

test('calcRenderStats：算出 avg/min/max/百分位與慢速件數，空陣列回傳 null', () => {
  assert.equal(calcRenderStats([]), null);
  const items = [100, 200, 300, 4000, 6000].map((ms) => ({ ms }));
  const stats = calcRenderStats(items);
  assert.equal(stats.count, 5);
  assert.equal(stats.min, 100);
  assert.equal(stats.max, 6000);
  assert.equal(stats.slow3to5, 1); // 4000
  assert.equal(stats.slowOver5, 1); // 6000
});

test('calcHourlyRenderStats：依小時分桶計算 count/avg/p50/p95/p99', () => {
  const items = [
    { ms: 100, date: '2026-05-08T02:00:00.000Z' },
    { ms: 300, date: '2026-05-08T02:30:00.000Z' },
    { ms: 200, date: '2026-05-08T03:00:00.000Z' },
  ];
  const result = calcHourlyRenderStats(items);
  assert.equal(result['2026-05-08 10:00'].count, 2);
  assert.equal(result['2026-05-08 10:00'].avg_ms, 200);
  assert.equal(result['2026-05-08 11:00'].count, 1);
});

test('calcMinuteStats：max/min/avg/total，空物件回傳全 0', () => {
  assert.deepEqual(calcMinuteStats({}), { max: 0, min: 0, avg: 0, total: 0, sorted: [] });
  const stats = calcMinuteStats({ '10:00': 5, '10:01': 10, '10:02': 1 });
  assert.equal(stats.max, 10);
  assert.equal(stats.min, 1);
  assert.equal(stats.avg, 5.33); // 16/3 四捨五入到小數點後 2 位
  assert.equal(stats.total, 3);
  assert.deepEqual(stats.sorted[0], ['10:01', 10]); // 依數量降冪排序
});

test('calcPeakMinuteUA：找出峰值分鐘與該分鐘的 UA 排行，排除指定 UA', () => {
  // minuteCount 的 key 需與 minuteLabel() 產生的格式一致（實際使用方式見 buildAggregates），
  // 這裡才能正確依 peakMin 去比對 records 的分鐘
  const minuteCount = { '2026-05-08 10:00': 3, '2026-05-08 10:01': 1 };
  const records = [
    { date: '2026-05-08T02:00:00.000Z', userAgent: 'UA1' },
    { date: '2026-05-08T02:00:10.000Z', userAgent: 'UA1' },
    { date: '2026-05-08T02:00:20.000Z', userAgent: 'Excluded' },
    { date: '2026-05-08T02:01:00.000Z', userAgent: 'UA2' },
  ];
  const variantConfig = { excludeUserAgents: ['Excluded'] };
  const result = calcPeakMinuteUA(minuteCount, records, variantConfig);
  assert.equal(result.peakMin, '2026-05-08 10:00');
  assert.equal(result.peakCount, 3);
  assert.equal(result.uaRanking.length, 1); // Excluded 被濾掉，只剩 UA1
  assert.equal(result.uaRanking[0].ua, 'UA1');
  assert.equal(result.uaRanking[0].count, 2);
});

test('calcPeakMinuteUA：空 minuteCount 回傳 null', () => {
  assert.equal(calcPeakMinuteUA({}, [], null), null);
});

test('calcHighFreq：一分鐘 >20 次或一秒 >5 次才算違規', () => {
  const uaMinutely = { '10:00': { UA1: 21, UA2: 20 } };
  const uaSecondly = { '10:00:00': { UA1: 6, UA2: 5 } };
  const hf = calcHighFreq(uaMinutely, uaSecondly);
  assert.equal(hf.totalMinVio, 1); // 只有 UA1 (21 > 20)
  assert.equal(hf.totalSecVio, 1); // 只有 UA1 (6 > 5)
  assert.equal(hf.uniqueViolatingUA, 1);
});

test('calcUAStats：依 UA 分組計算佔比與平均 render time', () => {
  const uaCount = { UA1: 3, UA2: 1 };
  const uaHourly = { '10:00': { UA1: 3, UA2: 1 } };
  const renderItems = [{ ua: 'UA1', ms: 100 }, { ua: 'UA1', ms: 300 }];
  const stats = calcUAStats(uaCount, uaHourly, renderItems);
  assert.equal(stats.total, 4);
  assert.equal(stats.ranking[0].ua, 'UA1');
  assert.equal(stats.ranking[0].avgMs, 200);
  assert.equal(stats.ranking[1].avgMs, null); // UA2 沒有 render time 記錄
});

test('calcUrlStats：total/unique/top10 依次數排序，top15slow 依耗時排序', () => {
  const urlCount = { '/a': 3, '/b': 1 };
  const renderItems = [
    { ms: 500, url: '/a', ua: 'UA1', date: '2026-05-08T02:00:00.000Z' },
    { ms: 5000, url: '/b', ua: 'UA2', date: '2026-05-08T02:01:00.000Z' },
  ];
  const stats = calcUrlStats(urlCount, renderItems, toTW);
  assert.equal(stats.total, 4);
  assert.equal(stats.unique, 2);
  assert.equal(stats.top10[0].url, '/a');
  assert.equal(stats.top15slow[0].url, '/b'); // 5000ms 排第一
});

test('calcSlowHM：依 hh:mm 分桶，找出出現次數最多的時間點', () => {
  const slowItems = [{ hm: '10:00' }, { hm: '10:00' }, { hm: '10:01' }];
  const result = calcSlowHM(slowItems);
  assert.equal(result.total, 3);
  assert.equal(result.duplicates.length, 1);
  assert.deepEqual(result.mostFrequent, [{ time: '10:00', count: 2 }]);
});
