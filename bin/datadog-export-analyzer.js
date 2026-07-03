#!/usr/bin/env node
'use strict';

// 分析 Datadog Export CSV 格式（商品頁 SSG / SSR、分類頁 SSR）
//
// 用法:
//   node bin/datadog-export-analyzer.js --type product-ssr --input ./to-analyze-daily-data/product/ssr/xxx.csv
//   node bin/datadog-export-analyzer.js --type product-ssr --date <YYYYMMDD> [--output <dir>]
//   node bin/datadog-export-analyzer.js --type combined --date <YYYYMMDD>
//   node bin/datadog-export-analyzer.js --type all --date <YYYYMMDD>
//
// 要加新頁面類型，改 src/config/variants.js（分析 variant）與 src/config/page-kinds.js
// （下載來源），不用改這支檔案或 src/analyzer/*.js 的邏輯本體。

const { main } = require('../src/analyzer/analyze');

main().catch((err) => {
  console.error('執行錯誤:', err.message);
  process.exit(1);
});
