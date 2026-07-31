'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { normalizeDate, buildTWRange, buildTWWindows } = require('../lib/time');
const { setDebug, fetchAllLogs, fetchAggregateCount, fetchAggregate404Counts } = require('./client');
const { writePageRows, merge404Logs, logs404ToCsv, counts404ToCsv } = require('./csv-mappers');
const PAGE_KINDS = require('../config/page-kinds');

const DATADOG_API_KEY = process.env.DATADOG_API_KEY;
const DATADOG_APP_KEY = process.env.DATADOG_APP_KEY;
const WORKER_PRD = 'astro-worker-prd';
const WORKER_STG = 'astro-worker-stg';
const ERROR_404_WINDOW_HOURS = 4;

function parseArgs(argv) {
  const args = {
    apiKey: DATADOG_API_KEY,
    appKey: DATADOG_APP_KEY,
    date: null,
    env: 'prd',
    type: 'all',
    debug: false,
    only404: false,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--api-key' && argv[i + 1]) args.apiKey = argv[++i];
    else if (argv[i] === '--app-key' && argv[i + 1]) args.appKey = argv[++i];
    else if (argv[i] === '--date' && argv[i + 1]) args.date = argv[++i];
    else if (argv[i] === '--env' && argv[i + 1]) args.env = argv[++i];
    else if (argv[i] === '--type' && argv[i + 1]) args.type = argv[++i];
    else if (argv[i] === '--debug') args.debug = true;
    else if (argv[i] === '--only-404') args.only404 = true;
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
  console.log(`下載範圍 : ${args.type}${args.only404 ? '（只補 404）' : ''}`);
  console.log(`查詢日期 : ${dateDash} 00:00:00 ~ 23:59:59 (台灣時區)`);
  console.log(`時間範圍 : ${fromISO} ~ ${toISO}`);
  console.log('');

  const savedLines = [];

  for (const kindKey of activeKinds) {
    const kind = PAGE_KINDS[kindKey];
    const subQueryCounts = {};

    if (!args.only404) for (const sq of kind.datadog.subQueries) {
      // 逐頁邊抓邊寫進暫存檔，不把整批 log 留在記憶體（日下載量可能上看百萬筆）；
      // 全部抓完才 rename 成正式檔名，中途失敗 tmp 檔會留下但正式檔名不受影響（要嘛完整、要嘛沒有）。
      const outDir = `./to-analyze-daily-data/${sq.outputDirName}`;
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, sq.filePattern(dateDigits));
      const tmpPath = `${outPath}.tmp`;
      const ws = fs.createWriteStream(tmpPath, { flags: 'w' });
      let streamError = null;
      ws.on('error', (err) => { streamError = err; });
      ws.write(`${sq.header}\n`);

      const total = await fetchAllLogs(args.apiKey, args.appKey, sq.queryTemplate(worker), fromISO, toISO, sq.variant, async (page) => {
        if (streamError) throw streamError;
        await writePageRows(ws, page, sq.mapRow);
      });
      if (streamError) throw streamError;
      await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())));
      fs.renameSync(tmpPath, outPath);

      subQueryCounts[sq.variant] = total;
      savedLines.push(`• ${sq.variant} : ${outPath}  (${total} 筆)`);
    }

    if (!args.only404 && kind.datadog.computedCount) {
      const cc = kind.datadog.computedCount;
      const basedOnCount = subQueryCounts[cc.basedOnVariant] || 0;
      const pathTotal = await fetchAggregateCount(args.apiKey, args.appKey, cc.queryTemplate(worker), fromISO, toISO);
      const computedCount = Math.max(0, pathTotal - basedOnCount);
      const outDir = `./to-analyze-daily-data/${cc.outputDirName}`;
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, cc.filePattern(dateDigits));
      fs.writeFileSync(outPath, JSON.stringify({
        date: dateDash,
        variant: cc.variant,
        path_total: pathTotal,
        based_on_variant: cc.basedOnVariant,
        based_on_count: basedOnCount,
        computed_count: computedCount,
      }, null, 2), 'utf8');
      savedLines.push(`• ${cc.variant} (計算值) : ${outPath}  (${computedCount} 筆 = ${pathTotal} - ${basedOnCount})`);
    }

    if (kind.datadog.error404) {
      const e = kind.datadog.error404;
      const outDir = `./to-analyze-daily-data/${e.outputDirName}`;
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, e.filePattern(dateDigits));

      if (e.aggregate) {
        try {
          const aggregateResult = await fetchAggregate404Counts(
            args.apiKey,
            args.appKey,
            { ...e.aggregate, query: e.aggregate.queryTemplate(worker) },
            fromISO,
            toISO,
            `404-${kindKey}`,
          );
          fs.writeFileSync(outPath, counts404ToCsv(aggregateResult.rows, e.keyLabel), 'utf8');
          savedLines.push(
            `• 404(${kind.label}) : ${outPath}  (共 ${aggregateResult.rows.length} 個 key，distinct ${aggregateResult.distinctCountTotal} 次，raw ${aggregateResult.rawCountTotal} 筆)`,
          );
          continue;
        } catch (err) {
          if (err.code !== 'DATADOG_AGGREGATE_PAGING_LIMIT') throw err;
          console.log(`  ⚠️  ${kind.label} 404 Aggregate 超過 Datadog bucket paging 上限，改用 streaming 明細分段查詢`);
        }
      }

      const map = new Map();
      const windows = buildTWWindows(dateDigits, e.windowHours || ERROR_404_WINDOW_HOURS);
      let raw404Total = 0;
      console.log(`[404-${kindKey}] 分 ${windows.length} 段查詢（每 ${e.windowHours || ERROR_404_WINDOW_HOURS} 小時）`);

      for (let i = 0; i < windows.length; i++) {
        const w = windows[i];
        console.log(`  時間窗 ${i + 1}/${windows.length}: ${w.label}`);
        raw404Total += await fetchAllLogs(
          args.apiKey,
          args.appKey,
          e.queryTemplate(worker),
          w.fromISO,
          w.toISO,
          `404-${kindKey} ${w.label}`,
          async (page) => {
            merge404Logs(page, e.extractKey, map);
          },
        );
      }
      fs.writeFileSync(outPath, logs404ToCsv(map, e.keyLabel), 'utf8');
      savedLines.push(`• 404(${kind.label}) : ${outPath}  (共 ${map.size} 個 key，掃描 ${raw404Total} 筆)`);
    }
  }

  console.log('結果已儲存:');
  savedLines.forEach((line) => console.log(line));
}

module.exports = { main };
