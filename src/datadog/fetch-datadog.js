'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { normalizeDate, buildTWRange, buildTWWindows } = require('../lib/time');
const { setDebug, fetchAllLogs, fetchAggregateCount, fetchAggregate404Counts } = require('./client');
const { writePageRowsSync, merge404Logs, logs404ToCsv, counts404ToCsv } = require('./csv-mappers');
const { loadCheckpoint, saveCheckpoint, clearCheckpoint } = require('../lib/checkpoint');
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

// 抓單一 subQuery、寫檔、失敗可續傳。拆成獨立函式方便測試斷點續傳行為，不必透過 main() 的 CLI 參數解析。
async function fetchSubQueryToFile(apiKey, appKey, sq, query, fromISO, toISO, dateDigits) {
  // 逐頁邊抓邊寫進暫存檔，不把整批 log 留在記憶體（日下載量可能上看百萬筆）；
  // 全部抓完才 rename 成正式檔名，中途失敗 tmp 檔會留下但正式檔名不受影響（要嘛完整、要嘛沒有）。
  const outDir = `./to-analyze-daily-data/${sq.outputDirName}`;
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, sq.filePattern(dateDigits));
  const tmpPath = `${outPath}.tmp`;
  const checkpointPath = `${tmpPath}.checkpoint.json`;

  const checkpointKey = { query, fromISO, toISO, variant: sq.variant };
  const checkpoint = loadCheckpoint(checkpointPath, checkpointKey);

  // 已經完整下載完成過（正式檔已存在、checkpoint 也還留著 total 紀錄，見下方成功路徑不再
  // clearCheckpoint）：process 級重跑（例如 daily-pipeline.js 對整支子程序失敗後的重試，會
  // 重新 spawn 一份全新 process 執行 main()）不該把這個 subQuery 從頭重抓一次。
  if (fs.existsSync(outPath) && checkpoint && Number.isInteger(checkpoint.total)) {
    console.log(`  ✓ [${sq.variant}] 先前已完整下載完成（${checkpoint.total} 筆），略過重抓`);
    return { outPath, total: checkpoint.total };
  }

  // 續傳條件：checkpoint 跟本次查詢條件一致，且 tmp 檔至少涵蓋 checkpoint 記錄的長度
  // （用同步寫入保證 bytesWritten 一定是已落地的資料，見 writePageRowsSync 註解）。
  // tmp 檔比 checkpoint 記的還短代表狀態不可信（例如手動改過檔案），放棄續傳、全新開始。
  const tmpCovered = checkpoint && fs.existsSync(tmpPath) && fs.statSync(tmpPath).size >= checkpoint.bytesWritten;

  if (tmpCovered && checkpoint.cursor === null) {
    // 上一輪其實已經抓完最後一頁（fetchAllLogs 在沒有下一頁時會把 cursor 存成 null，見
    // client.js 的 onCheckpoint(null, total)），只是還沒來得及 rename 成正式檔就中斷。
    // cursor:null 代表「已經沒有下一頁」而不是「還沒開始」，不能再把它當 initialCursor 傳給
    // fetchAllLogs——那樣會被當成從頭抓，把整批資料重複 append 在已經完整的 tmp 檔後面。
    fs.renameSync(tmpPath, outPath);
    console.log(`  ✓ [${sq.variant}] 上次已抓完最後一頁但尚未落地，直接完成（${checkpoint.total} 筆）`);
    return { outPath, total: checkpoint.total };
  }

  let fd = null;
  let resumeCursor = null;
  let resumeTotal = 0;
  if (tmpCovered) {
    // 'a'（append）模式：後續每次 writeSync 都固定寫到檔案結尾，不必自己追蹤/設定寫入位置——
    // 若用 'r+' 開檔，fd 的寫入位置預設停在 0，ftruncate 並不會把它移到截斷點，之後寫入會從檔頭
    // 覆蓋掉既有內容而非接續寫在後面。
    fd = fs.openSync(tmpPath, 'a');
    fs.ftruncateSync(fd, checkpoint.bytesWritten);
    resumeCursor = checkpoint.cursor;
    resumeTotal = checkpoint.total;
    console.log(`  ↻ [${sq.variant}] 偵測到中斷的下載進度，從第 ${resumeTotal} 筆之後續傳`);
  } else {
    clearCheckpoint(checkpointPath);
    fd = fs.openSync(tmpPath, 'w');
    fs.writeSync(fd, `${sq.header}\n`);
  }

  const total = await fetchAllLogs(
    apiKey, appKey, query, fromISO, toISO, sq.variant,
    async (page) => { writePageRowsSync(fd, page, sq.mapRow); },
    {
      initialCursor: resumeCursor,
      initialTotal: resumeTotal,
      onCheckpoint: (nextCursor, runningTotal) => {
        saveCheckpoint(checkpointPath, {
          query, fromISO, toISO, variant: sq.variant,
          cursor: nextCursor, total: runningTotal, bytesWritten: fs.fstatSync(fd).size,
        });
      },
    },
  );
  fs.closeSync(fd);
  fs.renameSync(tmpPath, outPath);
  // 不清掉 checkpoint：留著當完成紀錄（此時 checkpoint.cursor 已經是 null），供之後如果又被
  // 重跑，能靠上面的「已完成，略過」判斷直接跳過，不用重抓。

  return { outPath, total };
}

// 404 streaming fallback：分時間窗查詢、每個窗口完整跑完才 checkpoint（窗口內部的分頁失敗
// 由 fetchAllLogs 自己的 HTTP 層重試處理，這裡不做頁面級續傳——404 明細窗口資料量遠小於主要
// log 下載，重跑一個窗口的代價可以接受，用窗口級換取實作簡單、狀態單純）。
async function fetchWindowed404ToFile(apiKey, appKey, e, kindKey, query, dateDigits, outPath) {
  const windowHours = e.windowHours || ERROR_404_WINDOW_HOURS;
  const windows = buildTWWindows(dateDigits, windowHours);
  const checkpointPath = `${outPath}.checkpoint.json`;
  const checkpointKey = { query, dateDigits, windowHours, label: `404-${kindKey}` };
  const checkpoint = loadCheckpoint(checkpointPath, checkpointKey);

  // 已經完整下載完成過：process 級重跑不該把所有時間窗重新掃一次（見下方成功路徑不再
  // clearCheckpoint，checkpoint 在全部窗口跑完後會留著 completedWindows === windows.length）。
  if (fs.existsSync(outPath) && checkpoint && checkpoint.completedWindows === windows.length) {
    const doneMap = new Map((checkpoint.map || []).map(([k, arr]) => [k, new Set(arr)]));
    const doneRaw404Total = checkpoint.raw404Total || 0;
    console.log(`  ✓ [404-${kindKey}] 先前已完整下載完成（共 ${doneMap.size} 個 key，掃描 ${doneRaw404Total} 筆），略過重抓`);
    return { map: doneMap, raw404Total: doneRaw404Total };
  }

  let map = new Map();
  let raw404Total = 0;
  let startIndex = 0;
  if (checkpoint && Number.isInteger(checkpoint.completedWindows) && checkpoint.completedWindows > 0 && checkpoint.completedWindows <= windows.length) {
    map = new Map((checkpoint.map || []).map(([k, arr]) => [k, new Set(arr)]));
    raw404Total = checkpoint.raw404Total || 0;
    startIndex = checkpoint.completedWindows;
    console.log(`  ↻ [404-${kindKey}] 偵測到中斷的下載進度，已完成 ${startIndex}/${windows.length} 個時間窗，從第 ${startIndex + 1} 個續傳`);
  } else {
    clearCheckpoint(checkpointPath);
  }

  console.log(`[404-${kindKey}] 分 ${windows.length} 段查詢（每 ${windowHours} 小時）`);

  for (let i = startIndex; i < windows.length; i++) {
    const w = windows[i];
    console.log(`  時間窗 ${i + 1}/${windows.length}: ${w.label}`);
    raw404Total += await fetchAllLogs(
      apiKey,
      appKey,
      query,
      w.fromISO,
      w.toISO,
      `404-${kindKey} ${w.label}`,
      async (page) => {
        merge404Logs(page, e.extractKey, map);
      },
    );
    saveCheckpoint(checkpointPath, {
      ...checkpointKey,
      completedWindows: i + 1,
      raw404Total,
      map: Array.from(map.entries()).map(([k, v]) => [k, Array.from(v)]),
    });
  }

  fs.writeFileSync(outPath, logs404ToCsv(map, e.keyLabel), 'utf8');
  // 不清掉 checkpoint：留著當完成紀錄，供之後如果又被重跑，能靠上面的「已完成，略過」判斷
  // 直接跳過，不用把所有時間窗重新掃一次。

  return { map, raw404Total };
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
      const { outPath, total } = await fetchSubQueryToFile(
        args.apiKey, args.appKey, sq, sq.queryTemplate(worker), fromISO, toISO, dateDigits,
      );
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

      const { map, raw404Total } = await fetchWindowed404ToFile(
        args.apiKey, args.appKey, e, kindKey, e.queryTemplate(worker), dateDigits, outPath,
      );
      savedLines.push(`• 404(${kind.label}) : ${outPath}  (共 ${map.size} 個 key，掃描 ${raw404Total} 筆)`);
    }
  }

  console.log('結果已儲存:');
  savedLines.forEach((line) => console.log(line));
}

module.exports = { main, fetchSubQueryToFile, fetchWindowed404ToFile };
