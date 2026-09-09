'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { normalizeDate, buildUTCRange, nowTW } = require('../lib/time');
const { setDebug, verifyToken, fetchRoutingTargetLogs, fetchCacheHitLogs } = require('./client');
const { loadCheckpoint, saveCheckpoint, clearCheckpoint } = require('../lib/checkpoint');
const PAGE_KINDS = require('../config/page-kinds');

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_WORKER_NAME = 'www-eslite-com';

const ENV_WORKER_MAP = {
  prod: 'www-eslite-com',
  stg: 'stg-eslite-com',
};

function parseArgs(argv) {
  const args = {
    accountId: CLOUDFLARE_ACCOUNT_ID,
    apiToken: CLOUDFLARE_API_TOKEN,
    worker: null,
    date: null,
    output: null,
    type: 'all',
    debug: false,
  };
  let env = 'prod';
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--account-id' && argv[i + 1]) args.accountId = argv[++i];
    else if (argv[i] === '--api-token' && argv[i + 1]) args.apiToken = argv[++i];
    else if (argv[i] === '--env' && argv[i + 1]) env = argv[++i];
    else if (argv[i] === '--worker' && argv[i + 1]) args.worker = argv[++i];
    else if (argv[i] === '--date' && argv[i + 1]) args.date = argv[++i];
    else if (argv[i] === '--output' && argv[i + 1]) args.output = argv[++i];
    else if (argv[i] === '--type' && argv[i + 1]) args.type = argv[++i];
    else if (argv[i] === '--debug') args.debug = true;
  }
  if (!args.worker) {
    args.worker = ENV_WORKER_MAP[env] ?? CLOUDFLARE_WORKER_NAME;
  }
  return args;
}

// routingTargetSsrTotal/routingTargetSsgTotal 是「Routing target for X: astro-ssr/astro-ssg」
// 總數（不分 cache hit/miss），不是真正的 cache hit 數——真正的 cache hit 數要在合併進
// combined JSON 時，拿這個總數減掉對應的 miss/hit 明細數才能算出來
// （見 daily-pipeline.js 的 mergeCloudflareIntoCombined）。
function buildReport(dateDigits, worker, typeLabel, routingTargetSsrTotal, routingTargetSsgTotal, totalSsgHits, routingHourly, routingSsgHourly, ssgHourly) {
  const dateDash = `${dateDigits.slice(0, 4)}-${dateDigits.slice(4, 6)}-${dateDigits.slice(6, 8)}`;
  const lines = [
    'Cloudflare Workers Observability - Astro Routing/Cache Hit 統計',
    `生成時間: ${nowTW()}`,
    `日期 (台灣時區): ${dateDash} 00:00:00 ~ 23:59:59`,
    `Worker: ${worker || '（不限）'}`,
    `頁面類型: ${typeLabel}`,
    `全天 Routing target astro-ssr 總數（不分 hit/miss）: ${routingTargetSsrTotal} 次`,
  ];

  if (routingTargetSsgTotal !== null) {
    lines.push(`全天 Routing target astro-ssg 總數（不分 hit/miss）: ${routingTargetSsgTotal} 次`);
  }
  lines.push(`全天 Astro cache hit astro-ssg: ${totalSsgHits} 次`);
  lines.push('='.repeat(64), '', '每小時 Routing target astro-ssr 明細 (台灣時區，只顯示有資料的小時):');
  lines.push(`${'時段'.padEnd(14)}${'count'.padStart(8)}`, '-'.repeat(22));

  if (routingHourly.length === 0) {
    lines.push('• 無資料');
  } else {
    routingHourly.forEach(({ hour, routingCount }) => {
      lines.push(`${hour.padEnd(14)}${String(routingCount).padStart(8)}`);
    });
  }

  if (routingSsgHourly.length > 0) {
    lines.push('', '每小時 Routing target astro-ssg 明細 (台灣時區，只顯示有資料的小時):');
    lines.push(`${'時段'.padEnd(14)}${'count'.padStart(8)}`, '-'.repeat(22));
    routingSsgHourly.forEach(({ hour, routingCount }) => {
      lines.push(`${hour.padEnd(14)}${String(routingCount).padStart(8)}`);
    });
  }

  if (ssgHourly.length > 0) {
    lines.push('', '每小時 Astro cache hit astro-ssg 明細 (台灣時區，只顯示有資料的小時):');
    lines.push(`${'時段'.padEnd(14)}${'count'.padStart(8)}`, '-'.repeat(22));
    ssgHourly.forEach(({ hour, hitCount }) => {
      lines.push(`${hour.padEnd(14)}${String(hitCount).padStart(8)}`);
    });
  }

  return lines.join('\n');
}

// 查詢並寫出單一頁面類型的結果。buildRangeFn 預設用真正的當日台灣時區範圍，測試時可以換成
// 涵蓋範圍縮小的版本，避免一整天 6 個 slot（12 次請求）真的撞到 CF 6 req/60s 的 rate limit。
async function fetchAndSave(args, dateDigits, dateDash, outputOverride, pageKindKey, buildRangeFn = buildUTCRange) {
  const pageKind = PAGE_KINDS[pageKindKey];
  const pathPrefix = pageKind.urlPathPrefix;
  const typeLabel = pageKind.label;

  // 預設依頁面類型分資料夾（跟 datadog-export 的結構一致），--output 明確指定時直接沿用（不分頁面類型子資料夾）
  const outDir = outputOverride || path.join('./daily-analysis-result/cloudflare', pageKindKey);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const base = `cloudflare-cache-hit${pageKind.cloudflare.fileSuffix}-${dateDigits}`;
  const jsonPath = path.join(outDir, `${base}.json`);
  const txtPath = path.join(outDir, `${base}.txt`);
  const checkpointPath = path.join(outDir, `${base}.checkpoint.json`);

  const checkpointKey = { worker: args.worker || null, pathPrefix, typeLabel, dateDigits };
  const checkpoint = loadCheckpoint(checkpointPath, checkpointKey);
  if (!checkpoint) clearCheckpoint(checkpointPath);

  // Routing target 跟 SSG cache-hit 是兩條獨立的查詢/續傳進度，各自的 slot 進度分開存在
  // checkpoint 檔的 routingSsr / ssg 底下，互不影響——其中一條中斷重跑，不會連累另一條重查。
  function saveProgress(partial) {
    const current = loadCheckpoint(checkpointPath, checkpointKey) || { ...checkpointKey };
    saveCheckpoint(checkpointPath, { ...current, ...partial });
  }

  const { totalRoutingCount, hourly: routingHourly } = await fetchRoutingTargetLogs(
    args.accountId, args.apiToken, dateDigits, args.worker, pathPrefix, typeLabel, 'astro-ssr', buildRangeFn,
    {
      initialHourly: checkpoint?.routingSsr?.hourly || [],
      initialSlotStart: checkpoint?.routingSsr?.nextSlotStart ?? null,
      onCheckpoint: (hourlyResults, nextSlotStart) => saveProgress({ routingSsr: { hourly: hourlyResults, nextSlotStart } }),
    },
  );

  let totalSsgHits = 0;
  let ssgHourly = [];
  let totalRoutingSsgCount = null;
  let routingSsgHourly = [];
  if (pageKind.cloudflare.hasSsg) {
    const ssgResult = await fetchCacheHitLogs(
      args.accountId, args.apiToken, dateDigits, args.worker, pathPrefix, typeLabel, 'astro-ssg', buildRangeFn,
      {
        initialHourly: checkpoint?.ssg?.hourly || [],
        initialSlotStart: checkpoint?.ssg?.nextSlotStart ?? null,
        onCheckpoint: (hourlyResults, nextSlotStart) => saveProgress({ ssg: { hourly: hourlyResults, nextSlotStart } }),
      },
    );
    totalSsgHits = ssgResult.totalHits;
    ssgHourly = ssgResult.hourly;

    // 商品 SSG 總請求數直接查 Routing target，取代原本用 handler_type:fetch 減法反推、
    // 容易被 SSR cache hit 混進去污染的估計值（見 daily-pipeline.js 的 mergeCloudflareIntoCombined）。
    const routingSsgResult = await fetchRoutingTargetLogs(
      args.accountId, args.apiToken, dateDigits, args.worker, pathPrefix, typeLabel, 'astro-ssg', buildRangeFn,
      {
        initialHourly: checkpoint?.routingSsg?.hourly || [],
        initialSlotStart: checkpoint?.routingSsg?.nextSlotStart ?? null,
        onCheckpoint: (hourlyResults, nextSlotStart) => saveProgress({ routingSsg: { hourly: hourlyResults, nextSlotStart } }),
      },
    );
    totalRoutingSsgCount = routingSsgResult.totalRoutingCount;
    routingSsgHourly = routingSsgResult.hourly;
  }

  clearCheckpoint(checkpointPath);

  const jsonOutput = {
    fetched_at: new Date().toISOString(),
    account_id: args.accountId,
    date_tw: dateDash,
    worker: args.worker || null,
    type: pageKindKey,
    // 不是 cache hit 數，是路由決策當下的總流量（含 hit+miss）。真正的 cache hit 數
    // 要等合併進 combined JSON、拿這個總數減掉對應的明細/hit 數才算得出來。
    routing_target_ssr_total: totalRoutingCount,
    routing_target_ssg_total: totalRoutingSsgCount,
    total_ssg_hits: totalSsgHits,
    hourly_routing_target_ssr: routingHourly,
    hourly_routing_target_ssg: routingSsgHourly,
    hourly_ssg_hits: ssgHourly,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(jsonOutput, null, 2), 'utf8');
  fs.writeFileSync(
    txtPath,
    buildReport(dateDigits, args.worker, typeLabel, totalRoutingCount, totalRoutingSsgCount, totalSsgHits, routingHourly, routingSsgHourly, ssgHourly),
    'utf8',
  );

  return { jsonPath, txtPath };
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.accountId || !args.apiToken) {
    console.error('錯誤: 請在 .env 設定 CLOUDFLARE_ACCOUNT_ID 與 CLOUDFLARE_API_TOKEN');
    process.exit(1);
  }

  setDebug(args.debug);

  process.stdout.write('驗證 API Token... ');
  try {
    const tokenInfo = await verifyToken(args.accountId, args.apiToken);
    console.log(`OK（status: ${tokenInfo?.status ?? 'active'}）`);
  } catch (err) {
    console.error(`失敗\n${err.message}`);
    process.exit(1);
  }
  console.log('');

  if (!args.date) {
    console.error('錯誤: 請指定 --date <YYYYMMDD>');
    console.log('用法: node bin/cloudflare-log-fetcher.js --date <YYYYMMDD>');
    process.exit(1);
  }

  const dateDigits = normalizeDate(args.date);
  if (!dateDigits) {
    console.error(`錯誤: 無效的日期格式 "${args.date}"，請使用 YYYYMMDD 或 YYYY-MM-DD`);
    process.exit(1);
  }

  const validTypes = ['all', ...Object.keys(PAGE_KINDS)];
  if (!validTypes.includes(args.type)) {
    console.error(`錯誤: 無效的 --type "${args.type}"，請使用 ${validTypes.join(' / ')}`);
    process.exit(1);
  }
  const activeKinds = args.type === 'all' ? Object.keys(PAGE_KINDS) : [args.type];

  const dateDash = `${dateDigits.slice(0, 4)}-${dateDigits.slice(4, 6)}-${dateDigits.slice(6, 8)}`;

  console.log('Cloudflare Log Fetcher');
  console.log('='.repeat(48));
  console.log(`帳號 ID  : ${args.accountId}`);
  console.log(`查詢日期 : ${dateDash} 00:00:00 ~ 23:59:59 (台灣時區)`);
  console.log(`Worker   : ${args.worker || '（不限）'}`);
  console.log(`下載範圍 : ${args.type}`);
  console.log('');

  const savedLines = [];

  for (const kindKey of activeKinds) {
    const r = await fetchAndSave(args, dateDigits, dateDash, args.output, kindKey);
    savedLines.push(`• ${PAGE_KINDS[kindKey].label} JSON : ${r.jsonPath}`);
    savedLines.push(`• ${PAGE_KINDS[kindKey].label} 文字 : ${r.txtPath}`);
  }

  console.log('\n結果已儲存:');
  savedLines.forEach((line) => console.log(line));
}

module.exports = { main, fetchAndSave };
