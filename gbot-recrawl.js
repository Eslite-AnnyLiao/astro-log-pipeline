'use strict';

// 統計 Googlebot 對「同一頁面 (GUID)」的重爬間隔
// 資料源：product SSR log；時間範圍由 argv 指定 (YYYYMMDD ~ YYYYMMDD)

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');

const DIR = '/Users/liaoliting/Webserver/astro-log-pipeline/to-analyze-daily-data/product/ssr';
const START = process.argv[2] || '20260802';
const END = process.argv[3] || '20260831';
const MIN_GAP_MS = Number(process.argv[4] || 0); // 剔除 < N ms 的 gap（去掉同一次爬取的併發/retry）

// Googlebot/2.1 = smartphone/desktop Googlebot（不含 AdsBot、Googlebot-Image 等其他 Google bot）
const GBOT = /Googlebot\/2\.1/;

// guid -> Array<epoch_ms>
const timestamps = new Map();
let sampleGbotUA = null;
let sampleContent = null;

async function processFile(fp) {
  return new Promise((resolve, reject) => {
    const parser = parse({ columns: true, trim: true, bom: true, relax_quotes: true, relax_column_count: true });
    let total = 0, gbot = 0;
    fs.createReadStream(fp)
      .pipe(parser)
      .on('data', (row) => {
        total++;
        const ua = row['User agent'] || row['User Agent'] || '';
        if (!GBOT.test(ua)) return;
        gbot++;
        if (!sampleGbotUA) sampleGbotUA = ua;
        const content = row['Content'] || '';
        const m = content.match(/page-render\s*\|\s*(.+)/);
        if (!m) return;
        if (!sampleContent) sampleContent = content;
        const guid = m[1].trim();
        if (!guid) return;
        const date = row['Date'];
        if (!date) return;
        const t = Date.parse(date);
        if (Number.isNaN(t)) return;
        let arr = timestamps.get(guid);
        if (!arr) { arr = []; timestamps.set(guid, arr); }
        arr.push(t);
      })
      .on('end', () => {
        process.stderr.write(`${path.basename(fp)}: total=${total} gbot=${gbot}\n`);
        resolve();
      })
      .on('error', reject);
  });
}

function pctFn(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] * (1 - (idx - lo)) + sorted[hi] * (idx - lo);
}

function fmt(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}min`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(2)}h`;
  return `${(ms / 86_400_000).toFixed(2)}d`;
}

(async () => {
  const files = fs.readdirSync(DIR)
    .filter((f) => /^ssr-product-log-\d{8}\.csv$/.test(f))
    .filter((f) => {
      const d = f.match(/(\d{8})/)[1];
      return d >= START && d <= END;
    })
    .sort();

  process.stderr.write(`Files to process: ${files.length} (${START}~${END})\n`);

  const t0 = Date.now();
  for (const f of files) {
    await processFile(path.join(DIR, f));
  }
  process.stderr.write(`Parse done in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);
  process.stderr.write(`Sample gbot UA: ${sampleGbotUA}\n`);
  process.stderr.write(`Sample content: ${sampleContent}\n`);

  // 計算 gap
  const gaps = [];
  let pagesWith1 = 0;
  let pagesWithGaps = 0;
  let totalHits = 0;
  const hitsPerPage = [];
  for (const [, arr] of timestamps) {
    totalHits += arr.length;
    hitsPerPage.push(arr.length);
    if (arr.length < 2) { pagesWith1++; continue; }
    arr.sort((a, b) => a - b);
    pagesWithGaps++;
    for (let i = 1; i < arr.length; i++) {
      const d = arr[i] - arr[i - 1];
      if (d < MIN_GAP_MS) continue;
      gaps.push(d);
    }
  }
  gaps.sort((a, b) => a - b);
  hitsPerPage.sort((a, b) => a - b);

  const bkts = [
    ['<1min', 60_000],
    ['1-5min', 5 * 60_000],
    ['5-15min', 15 * 60_000],
    ['15-30min', 30 * 60_000],
    ['30-60min', 60 * 60_000],
    ['1-3h', 3 * 3_600_000],
    ['3-6h', 6 * 3_600_000],
    ['6-12h', 12 * 3_600_000],
    ['12-24h', 86_400_000],
    ['1-3d', 3 * 86_400_000],
    ['3-7d', 7 * 86_400_000],
    ['7-14d', 14 * 86_400_000],
    ['14-30d', 30 * 86_400_000],
    ['>30d', Infinity],
  ];
  const distr = bkts.map(([label]) => ({ label, count: 0 }));
  for (const g of gaps) {
    for (let i = 0; i < bkts.length; i++) {
      if (g <= bkts[i][1]) { distr[i].count++; break; }
    }
  }

  const total = gaps.length;
  const sum = gaps.reduce((s, v) => s + v, 0);

  const summary = {
    period: `${START}~${END}`,
    days: files.length,
    filter: `UA 含 Googlebot/2.1（只計 Googlebot 桌機/手機爬蟲，不含 AdsBot、Googlebot-Image 等）; MIN_GAP_MS=${MIN_GAP_MS}`,
    dataset: 'product SSR render log（Datadog）',
    totalGooglebotHits: totalHits,
    uniquePagesHit: timestamps.size,
    pagesHitOnce: pagesWith1,
    pagesHitOncePct: (pagesWith1 / timestamps.size * 100).toFixed(2) + '%',
    pagesWithGaps,
    totalGapSamples: total,
    hitsPerPage: total ? {
      mean: (totalHits / timestamps.size).toFixed(2),
      p50: pctFn(hitsPerPage, 50),
      p75: pctFn(hitsPerPage, 75),
      p90: pctFn(hitsPerPage, 90),
      p99: pctFn(hitsPerPage, 99),
      max: hitsPerPage[hitsPerPage.length - 1],
    } : null,
    gapStats: total ? {
      mean: fmt(sum / total),
      min: fmt(gaps[0]),
      p10: fmt(pctFn(gaps, 10)),
      p25: fmt(pctFn(gaps, 25)),
      p50: fmt(pctFn(gaps, 50)),
      p75: fmt(pctFn(gaps, 75)),
      p90: fmt(pctFn(gaps, 90)),
      p95: fmt(pctFn(gaps, 95)),
      p99: fmt(pctFn(gaps, 99)),
      max: fmt(gaps[gaps.length - 1]),
    } : null,
    distribution: distr.map(({ label, count }) => ({
      label,
      count,
      pct: total ? (count / total * 100).toFixed(2) + '%' : '0%',
    })),
  };

  console.log(JSON.stringify(summary, null, 2));
})();
