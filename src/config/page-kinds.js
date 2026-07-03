'use strict';

// 頁面類型 registry：驅動 cloudflare fetcher（cache-hit 統計）與 datadog fetcher（log 下載）。
// 要加新頁面類型（例如文章頁），照這個形狀新增一個區塊即可，不需要改
// src/cloudflare/fetch-cloudflare.js 或 src/datadog/fetch-datadog.js 的邏輯本體。

const { ssrMapRow, ssgMapRow, categoryMapRow, extractProductId, extractCategoryKey } = require('../datadog/csv-mappers');

module.exports = {
  product: {
    label: '商品頁',
    urlPathPrefix: '/product/',
    cloudflare: {
      fileSuffix: '-product',
      combinedCacheHitKey: 'cloudflare_cache_hit',
    },
    datadog: {
      subQueries: [
        {
          variant: 'product-ssr',
          queryTemplate: (w) => `@cloudflare.script_name:${w} @service:ssr-product-page @name:page-render`,
          header: 'Date,User agent,Duration,Content',
          mapRow: ssrMapRow,
          outputDirName: 'product/ssr',
          filePattern: (d) => `ssr-product-log-${d}.csv`,
        },
        {
          variant: 'product-ssg',
          queryTemplate: (w) => `@cloudflare.script_name:${w} message:ssg`,
          header: 'Date,User agent,@product_id,Content',
          mapRow: ssgMapRow,
          outputDirName: 'product/ssg',
          filePattern: (d) => `ssg-product-log-${d}.csv`,
        },
      ],
      error404: {
        queryTemplate: (w) => `@cloud.platform:cloudflare.workers @cloudflare.script_name:${w} status:error @service:ssr-product-page`,
        extractKey: extractProductId,
        keyLabel: 'ProductId',
        outputDirName: 'product/404-errors',
        filePattern: (d) => `404-errors-${d}.csv`,
        entryKeyName: 'product_id',
        affectedCountKey: 'affected_product_count',
        combinedErrorsKey: 'errors_404',
      },
    },
  },

  category: {
    label: '分類頁',
    urlPathPrefix: '/category/',
    cloudflare: {
      fileSuffix: '-category',
      combinedCacheHitKey: 'cloudflare_cache_hit_category',
    },
    datadog: {
      subQueries: [
        {
          variant: 'category-ssr',
          queryTemplate: (w) => `@cloudflare.script_name:${w} @service:ssr-category-page @name:page-render`,
          header: 'Date,User agent,Duration,L1,L2,L3,Content',
          mapRow: categoryMapRow,
          outputDirName: 'category/ssr',
          filePattern: (d) => `category-page-log-${d}.csv`,
        },
      ],
      error404: {
        queryTemplate: (w) => `@cloud.platform:cloudflare.workers @cloudflare.script_name:${w} status:error @service:ssr-category-page`,
        extractKey: extractCategoryKey,
        keyLabel: 'CategoryKey',
        outputDirName: 'category/404-errors',
        filePattern: (d) => `category-404-errors-${d}.csv`,
        entryKeyName: 'category_key',
        affectedCountKey: 'affected_category_count',
        combinedErrorsKey: 'errors_404_category',
      },
    },
  },

  // 未來加文章頁：直接照這個形狀新增一個 article 區塊即可。
  // article: {
  //   label: '文章頁',
  //   urlPathPrefix: '/article/',
  //   cloudflare: { fileSuffix: '-article' },
  //   datadog: {
  //     subQueries: [
  //       { variant: 'article-ssr', queryTemplate: w => `...`, header: '...', mapRow: articleMapRow,
  //         outputDirName: 'article/ssr', filePattern: d => `article-page-log-${d}.csv` },
  //     ],
  //     error404: { queryTemplate: w => `...`, extractKey: extractArticleId, keyLabel: 'ArticleId',
  //       outputDirName: 'article/404-errors', filePattern: d => `article-404-errors-${d}.csv` },
  //   },
  // },
};
