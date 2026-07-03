#!/usr/bin/env node
'use strict';

// 從 Cloudflare Logs Explorer SQL API 取得指定日期含有 "Astro cache hit for" 的 log
//
// 用法:
//   node bin/cloudflare-log-fetcher.js --date <YYYYMMDD>
//   node bin/cloudflare-log-fetcher.js --date <YYYY-MM-DD> --env <prod|stg> --output <dir>
//   node bin/cloudflare-log-fetcher.js --date <YYYYMMDD> --type category
//
// 說明:
//   accountId / apiToken 讀自 .env
//   --date    查詢日期（台灣時區），格式 YYYYMMDD 或 YYYY-MM-DD（必填）
//   --env     環境（prod|stg），決定 worker 名稱（預設: prod）
//   --worker  直接指定 Worker script 名稱，傳入時覆蓋 --env
//   --type    下載範圍，預設 all，可傳 product / category 只查詢其中一種頁面（見 src/config/page-kinds.js）
//   --output  輸出目錄（預設: ./daily-analysis-result/cloudflare/YYYYMMDD）
//   --account-id / --api-token  選填，傳入時覆蓋 .env
//
// API: POST /accounts/{id}/workers/observability/telemetry/query

const { main } = require('../src/cloudflare/fetch-cloudflare');

main().catch((err) => {
  console.error('執行錯誤:', err.message);
  process.exit(1);
});
