'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { normalizeDate, buildTWRange } = require('../lib/time');
const { setDebug, fetchAllLogs } = require('./client');
const { logsToCsv, process404Logs, logs404ToCsv } = require('./csv-mappers');
const PAGE_KINDS = require('../config/page-kinds');

const DATADOG_API_KEY = process.env.DATADOG_API_KEY;
const DATADOG_APP_KEY = process.env.DATADOG_APP_KEY;
const WORKER_PRD = 'astro-worker-prd';
const WORKER_STG = 'astro-worker-stg';

function parseArgs(argv) {
  const args = {
    apiKey: DATADOG_API_KEY,
    appKey: DATADOG_APP_KEY,
    date: null,
    env: 'prd',
    type: 'all',
    debug: false,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--api-key' && argv[i + 1]) args.apiKey = argv[++i];
    else if (argv[i] === '--app-key' && argv[i + 1]) args.appKey = argv[++i];
    else if (argv[i] === '--date' && argv[i + 1]) args.date = argv[++i];
    else if (argv[i] === '--env' && argv[i + 1]) args.env = argv[++i];
    else if (argv[i] === '--type' && argv[i + 1]) args.type = argv[++i];
    else if (argv[i] === '--debug') args.debug = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.apiKey || !args.appKey) {
    console.error('錯誤: 請在 .env 設定 DATADOG_API_KEY 與 DATADOG_APP_KEY');
    process.exit(1);
  }

  setDebug(args.debug);

  if (!args.date) {
    console.error('錯誤: 請指定 --date <YYYYMMDD>');
    console.log('用法: node bin/datadog-log-fetcher.js --date <YYYYMMDD>');
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

  const worker = args.env === 'stg' ? WORKER_STG : WORKER_PRD;
  const dateDash = `${dateDigits.slice(0, 4)}-${dateDigits.slice(4, 6)}-${dateDigits.slice(6, 8)}`;
  const { fromISO, toISO } = buildTWRange(dateDigits);

  console.log('Datadog Log Fetcher');
  console.log('='.repeat(48));
  console.log(`環境     : ${args.env} (${worker})`);
  console.log(`下載範圍 : ${args.type}`);
  console.log(`查詢日期 : ${dateDash} 00:00:00 ~ 23:59:59 (台灣時區)`);
  console.log(`時間範圍 : ${fromISO} ~ ${toISO}`);
  console.log('');

  const savedLines = [];

  for (const kindKey of activeKinds) {
    const kind = PAGE_KINDS[kindKey];

    for (const sq of kind.datadog.subQueries) {
      const logs = await fetchAllLogs(args.apiKey, args.appKey, sq.queryTemplate(worker), fromISO, toISO, sq.variant);
      const outDir = `./to-analyze-daily-data/${sq.outputDirName}`;
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, sq.filePattern(dateDigits));
      fs.writeFileSync(outPath, logsToCsv(logs, { header: sq.header, mapRow: sq.mapRow }), 'utf8');
      savedLines.push(`• ${sq.variant} : ${outPath}  (${logs.length} 筆)`);
    }

    if (kind.datadog.error404) {
      const e = kind.datadog.error404;
      const logs = await fetchAllLogs(args.apiKey, args.appKey, e.queryTemplate(worker), fromISO, toISO, `404-${kindKey}`);
      const map = process404Logs(logs, e.extractKey);
      const outDir = `./to-analyze-daily-data/${e.outputDirName}`;
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, e.filePattern(dateDigits));
      fs.writeFileSync(outPath, logs404ToCsv(map, e.keyLabel), 'utf8');
      savedLines.push(`• 404(${kind.label}) : ${outPath}  (共 ${map.size} 個)`);
    }
  }

  console.log('結果已儲存:');
  savedLines.forEach((line) => console.log(line));
}

module.exports = { main };
