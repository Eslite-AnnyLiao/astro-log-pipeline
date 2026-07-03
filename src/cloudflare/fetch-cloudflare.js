'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { normalizeDate, buildUTCRange, nowTW } = require('../lib/time');
const { setDebug, verifyToken, fetchAllLogs } = require('./client');
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

function buildReport(dateDigits, worker, typeLabel, totalSsrHits, totalSsgHits, hourly) {
  const dateDash = `${dateDigits.slice(0, 4)}-${dateDigits.slice(4, 6)}-${dateDigits.slice(6, 8)}`;
  const lines = [
    'Cloudflare Workers Observability - Astro Cache Hit 統計',
    `生成時間: ${nowTW()}`,
    `日期 (台灣時區): ${dateDash} 00:00:00 ~ 23:59:59`,
    `Worker: ${worker || '（不限）'}`,
    `頁面類型: ${typeLabel}`,
    `全天 Cache hit  SSR: ${totalSsrHits} 次  SSG: ${totalSsgHits} 次  合計: ${totalSsrHits + totalSsgHits} 次`,
    '='.repeat(64),
    '',
    '每小時明細 (台灣時區，只顯示有資料的小時):',
    `${'時段'.padEnd(14)}${'ssr'.padStart(6)}${'ssg'.padStart(6)}`,
    '-'.repeat(26),
  ];

  if (hourly.length === 0) {
    lines.push('• 無資料');
  } else {
    hourly.forEach(({ hour, ssrHitCount, ssgHitCount }) => {
      lines.push(`${hour.padEnd(14)}${String(ssrHitCount).padStart(6)}${String(ssgHitCount).padStart(6)}`);
    });
  }

  return lines.join('\n');
}

// 查詢並寫出單一頁面類型的結果
async function fetchAndSave(args, dateDigits, dateDash, outDir, pageKindKey) {
  const pageKind = PAGE_KINDS[pageKindKey];
  const pathPrefix = pageKind.urlPathPrefix;
  const typeLabel = pageKind.label;

  const { totalSsrHits, totalSsgHits, hourly } = await fetchAllLogs(
    args.accountId, args.apiToken, dateDigits, args.worker, pathPrefix, typeLabel, buildUTCRange,
  );

  const base = `cloudflare-cache-hit${pageKind.cloudflare.fileSuffix}-${dateDigits}`;
  const jsonPath = path.join(outDir, `${base}.json`);
  const txtPath = path.join(outDir, `${base}.txt`);

  const jsonOutput = {
    fetched_at: new Date().toISOString(),
    account_id: args.accountId,
    date_tw: dateDash,
    worker: args.worker || null,
    type: pageKindKey,
    total_ssr_hits: totalSsrHits,
    total_ssg_hits: totalSsgHits,
    total_hits: totalSsrHits + totalSsgHits,
    hourly,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(jsonOutput, null, 2), 'utf8');
  fs.writeFileSync(txtPath, buildReport(dateDigits, args.worker, typeLabel, totalSsrHits, totalSsgHits, hourly), 'utf8');

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

  const outDir = args.output || path.join('./daily-analysis-result/cloudflare', dateDigits);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const savedLines = [];

  for (const kindKey of activeKinds) {
    const r = await fetchAndSave(args, dateDigits, dateDash, outDir, kindKey);
    savedLines.push(`• ${PAGE_KINDS[kindKey].label} JSON : ${r.jsonPath}`);
    savedLines.push(`• ${PAGE_KINDS[kindKey].label} 文字 : ${r.txtPath}`);
  }

  console.log('\n結果已儲存:');
  savedLines.forEach((line) => console.log(line));
}

module.exports = { main };
