'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeCombinedAggregates, calcCombinedUAStats, labelSep } = require('../src/analyzer/combined');
const { COMBINED_ORDER, VARIANTS } = require('../src/config/variants');

test('labelSep：英文字母開頭的 label 前面加空格，中文不加', () => {
  assert.equal(labelSep('SSG'), ' ');
  assert.equal(labelSep('分類頁'), '');
});

test('mergeCombinedAggregates：依 COMBINED_ORDER 初始化每個 variant 的 key（即使沒有資料）', () => {
  const agg = mergeCombinedAggregates({});
  for (const id of COMBINED_ORDER) {
    assert.deepEqual(agg.hourCount[VARIANTS[id].combinedShortKey], {});
    assert.deepEqual(agg.uaCount[VARIANTS[id].combinedShortKey], {});
  }
  assert.deepEqual(agg.hourCount.total, {});
  assert.deepEqual(agg.uaCount.total, {});
});

test('mergeCombinedAggregates：把各 variant 的記錄依 shortKey 分別累計，並同時累計進 total', () => {
  const recordsByVariant = {
    'product-ssr': [
      { date: '2026-05-08T02:00:00.000Z', userAgent: 'UA1' },
      { date: '2026-05-08T02:00:30.000Z', userAgent: 'UA1' },
    ],
    'category-ssr': [
      { date: '2026-05-08T02:00:00.000Z', userAgent: 'UA2' },
    ],
  };
  const agg = mergeCombinedAggregates(recordsByVariant);

  assert.equal(agg.hourCount.ssr['2026-05-08 10:00'], 2);
  assert.equal(agg.hourCount.category['2026-05-08 10:00'], 1);
  assert.equal(agg.hourCount.total['2026-05-08 10:00'], 3); // 合計跨 variant 加總

  assert.equal(agg.uaCount.ssr.UA1, 2);
  assert.equal(agg.uaCount.category.UA2, 1);
  assert.equal(agg.uaCount.total.UA1, 2);
  assert.equal(agg.uaCount.total.UA2, 1);

  assert.equal(agg.minuteCount['2026-05-08 10:00'], 3);
});

test('calcCombinedUAStats：每個 UA 同時列出各 variant 的筆數與整體佔比', () => {
  const uaCount = {
    total: { UA1: 3, UA2: 1 },
    ssg: {},
    ssr: { UA1: 3 },
    category: { UA2: 1 },
  };
  const stats = calcCombinedUAStats(uaCount);
  assert.equal(stats.total, 4);
  assert.equal(stats.unique, 2);
  assert.equal(stats.ranking[0].ua, 'UA1');
  assert.equal(stats.ranking[0].ssr, 3);
  assert.equal(stats.ranking[0].category, 0);
  assert.equal(stats.ranking[0].pct, 75);
});
