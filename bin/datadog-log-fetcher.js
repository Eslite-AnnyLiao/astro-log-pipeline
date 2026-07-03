#!/usr/bin/env node
'use strict';

// 從 Datadog Logs Search API 取得指定日期的 SSR / SSG / 分類頁 log，各存成 CSV
//
// 用法:
//   node bin/datadog-log-fetcher.js --date <YYYYMMDD>
//
// 說明:
//   apiKey / appKey 讀自 .env
//   --date    查詢日期（台灣時區），格式 YYYYMMDD 或 YYYY-MM-DD（必填）
//   --env     環境，預設 prd（astro-worker-prd），傳 stg 改為 astro-worker-stg
//   --type    下載範圍，預設 all，可傳 product / category 只下載其中一種（見 src/config/page-kinds.js）
//   --api-key / --app-key  選填，傳入時覆蓋 .env
//
// API: POST https://api.us5.datadoghq.com/api/v2/logs/events/search

const { main } = require('../src/datadog/fetch-datadog');

main().catch((err) => {
  console.error('執行錯誤:', err.message);
  process.exit(1);
});
