'use strict';

// 分析 variant registry：驅動 datadog-export-analyzer 的 CSV 讀取、report 產生、JSON 輸出、combined 合併。
//
// 命名採 `<頁面>-<渲染模式>`（product-ssg / product-ssr / category-ssr）而不是單純 ssg/ssr/category，
// 因為 category 頁本身也是 SSR 渲染，未來也可能有 category-ssg 或 article-ssr/article-ssg，
// 用「頁面+渲染模式」才不會混淆或衝突。
//
// 這個命名只影響 registry 內部的 id 與 CLI `--type` 參數值：
// - inputDirName / outputDirName 採「page kind 在外層、資料類型在內層」（product/ssr、category/ssr...），
//   跟 cloudflare/、to-analyze-daily-data/ 的資料夾慣例一致；filePattern（實際檔名）逐字不變，
//   確保 ssr、combined 的輸出檔名不變（seo-agent 的 jsonPaths 只需要調整資料夾路徑）。
// - combinedShortKey（combined JSON 內部欄位名，如 data_source_stats.ssr_records、
//   hourly_request_data_by_type.ssr）維持 ssg/ssr/category，讓 combined JSON schema 完全不變
//   （seo-agent 直接讀這些欄位）。
//
// 要加新頁面類型，只需要在這裡新增一筆設定，不需要碰 src/analyzer/*.js 的邏輯本體。

const VARIANTS = {
  'product-ssg': {
    id: 'product-ssg',
    pageKind: 'product',
    label: 'SSG',
    reportTitle: 'SSG 模式',
    analysisModeLabel: 'Datadog Export SSG 單檔案模式',
    inputDirName: 'product/ssg',
    filePattern: (d) => `ssg-product-log-${d}.csv`,
    outputDirName: 'product/ssg',
    excludeUserAgents: ['EsliteDeployValidator/1.0'],
    hasRenderTimeline: false,
    urlBuilder: (rec) => (rec.productId ? `/product/${rec.productId}` : null),
    extraBreakdown: null,
    combinedShortKey: 'ssg',
    combinedShortLabel: 'SSG',
  },

  'product-ssr': {
    id: 'product-ssr',
    pageKind: 'product',
    label: 'SSR',
    reportTitle: 'SSR 模式',
    analysisModeLabel: 'Datadog Export SSR 單檔案模式',
    inputDirName: 'product/ssr',
    filePattern: (d) => `ssr-product-log-${d}.csv`,
    outputDirName: 'product/ssr',
    excludeUserAgents: [],
    hasRenderTimeline: true,
    urlBuilder: (rec) => (rec.reqId ? `/product/${rec.reqId}` : null),
    extraBreakdown: {
      idField: 'productId',
      aggKey: 'productIdCount',
      reportHeading: '@product_id 統計 (前10名):',
      jsonKey: 'product_id_stats',
      entryKeyName: 'id',
    },
    combinedShortKey: 'ssr',
    combinedShortLabel: 'SSR',
  },

  'category-ssr': {
    id: 'category-ssr',
    pageKind: 'category',
    label: '分類頁',
    reportTitle: '分類頁模式',
    analysisModeLabel: 'Datadog Export 分類頁單檔案模式',
    inputDirName: 'category/ssr',
    filePattern: (d) => `category-page-log-${d}.csv`,
    outputDirName: 'category/ssr',
    excludeUserAgents: [],
    hasRenderTimeline: true,
    urlBuilder: (rec) => (rec.categoryKey ? `/category/${rec.categoryKey}` : null),
    extraBreakdown: {
      idField: 'categoryKey',
      aggKey: 'categoryKeyCount',
      reportHeading: '分類分布統計 (L1/L2/L3，前10名):',
      jsonKey: 'category_key_stats',
      entryKeyName: 'key',
    },
    combinedShortKey: 'category',
    combinedShortLabel: '分類頁',
  },

  // 未來例如文章頁若也有 SSR/SSG 兩種，就照這個命名加 'article-ssr'、'article-ssg'。
};

// 保持順序 = 今天輸出的順序（ssg, ssr, category）；新 variant 加在最後面。
const COMBINED_ORDER = ['product-ssg', 'product-ssr', 'category-ssr'];

module.exports = { VARIANTS, COMBINED_ORDER };
