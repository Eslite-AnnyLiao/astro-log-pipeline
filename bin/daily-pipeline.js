#!/usr/bin/env node
'use strict';

// 每日 Log 分析整合工具
//
// 用法:
//   node bin/daily-pipeline.js --date <YYYYMMDD>
//   node bin/daily-pipeline.js --date <YYYY-MM-DD> [--debug]
//   node bin/daily-pipeline.js --date <YYYYMMDD> --merge-cf-only
//
// 流程:
//   Step 1  CF fetcher + DD fetcher 同時執行（顯示進度條）
//   Step 2  兩者完成後執行 datadog-export-analyzer（--type all）
//   Step 3  將 CF cache hit 數據 merge 進 combined JSON
//   Step 4  將 404 統計 merge 進 combined JSON
//
// --merge-cf-only: 跳過 Step 1、Step 2，直接將既有的 CF JSON / 404 CSV merge 進既有的 combined JSON

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PAGE_KINDS = require('../src/config/page-kinds');
const { VARIANTS, COMBINED_ORDER } = require('../src/config/variants');

const PROJECT_ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const args = { date: null, env: 'prod', debug: false, analyzeOnly: false, mergeCfOnly: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--date' && argv[i + 1]) args.date = argv[++i];
    else if (argv[i] === '--env' && argv[i + 1]) args.env = argv[++i];
    else if (argv[i] === '--debug') args.debug = true;
    else if (argv[i] === '--analyze-only') args.analyzeOnly = true;
    else if (argv[i] === '--merge-cf-only') args.mergeCfOnly = true;
  }
  return args;
}

function normalizeDate(dateStr) {
  const clean = dateStr.replace(/\D/g, '');
  return clean.length === 8 ? clean : null;
}

function nowTW() {
  return new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
}

// ============================
// 進度顯示
// ============================

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const BAR_W = 24;
// cloudflare-log-fetcher.js 預設 --type all 會依序查每個頁面類型，各 24hr 進度
const CF_TOTAL_HOURS = Object.keys(PAGE_KINDS).length * 24;

class ProgressDisplay {
  constructor() {
    this.cf = { hours: 0, hits: 0, done: false, error: null };
    this.dd = { pages: 0, done: false, error: null, startTime: null };
    this.analyzer = { state: 'waiting', done: false, error: null };

    this._spinIdx = 0;
    this._timer = null;
    this._inited = false;
    this._lineCount = 3;
  }

  start() {
    process.stdout.write('\n'.repeat(this._lineCount));
    this._inited = true;
    this._render();
    this._timer = setInterval(() => {
      this._spinIdx = (this._spinIdx + 1) % SPINNER.length;
      this._render();
    }, 120);
  }

  _bar(n, total) {
    const filled = Math.min(BAR_W, Math.round((n / total) * BAR_W));
    return `[\x1b[33m${'█'.repeat(filled)}${'░'.repeat(BAR_W - filled)}\x1b[0m]`;
  }

  _render() {
    if (!this._inited) return;
    process.stdout.write(`\x1b[${this._lineCount}A`);
    const sp = SPINNER[this._spinIdx];

    let cfInfo;
    if (this.cf.error) {
      cfInfo = `\x1b[31m✗ 失敗\x1b[0m`;
    } else if (this.cf.done) {
      cfInfo = `${this._bar(CF_TOTAL_HOURS, CF_TOTAL_HOURS)}  \x1b[32m✓ 完成  cache hit: ${this.cf.hits} 次\x1b[0m`;
    } else {
      cfInfo = `${this._bar(this.cf.hours, CF_TOTAL_HOURS)}  ${this.cf.hours}/${CF_TOTAL_HOURS} hr`;
    }
    process.stdout.write(`\r\x1b[K  \x1b[33mCloudflare\x1b[0m  ${cfInfo}\n`);

    let ddInfo;
    if (this.dd.error) {
      ddInfo = `\x1b[31m✗ 失敗\x1b[0m`;
    } else if (this.dd.done) {
      ddInfo = `\x1b[32m✓ 完成  共 ${this.dd.pages} 頁\x1b[0m`;
    } else {
      let detail = `已處理 ${this.dd.pages} 頁`;
      if (this.dd.startTime && this.dd.pages >= 2) {
        const elapsedS = (Date.now() - this.dd.startTime) / 1000;
        const avgS = (elapsedS / this.dd.pages).toFixed(1);
        detail += `  ${avgS}s/頁  已耗時 ${Math.round(elapsedS)}s`;
      }
      ddInfo = `${sp}  下載中  ${detail}`;
    }
    process.stdout.write(`\r\x1b[K  \x1b[36mDatadog   \x1b[0m  ${ddInfo}\n`);

    let anaInfo;
    if (this.analyzer.error) {
      anaInfo = `\x1b[31m✗ 失敗\x1b[0m`;
    } else if (this.analyzer.done) {
      anaInfo = `\x1b[32m✓ 完成\x1b[0m`;
    } else if (this.analyzer.state === 'running') {
      anaInfo = `${sp}  分析中...`;
    } else {
      anaInfo = `⏳ 等待下載完成...`;
    }
    process.stdout.write(`\r\x1b[K  \x1b[32mAnalyzer  \x1b[0m  ${anaInfo}\n`);
  }

  finalize() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._render();
  }
}

// ============================
// 子程序啟動（解析進度，抑制原始輸出）
// ============================

function runWithProgress(scriptName, scriptArgs, onLine, label) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(__dirname, scriptName), ...scriptArgs], { cwd: PROJECT_ROOT });
    let buf = '';
    const errLines = [];

    child.stdout.on('data', (data) => {
      buf += data.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (onLine) onLine(line);
      }
    });

    child.stderr.on('data', (d) => errLines.push(d.toString()));

    child.on('close', (code) => {
      if (buf && onLine) onLine(buf);
      if (errLines.length) {
        process.stderr.write(`\n[${label} stderr]\n${errLines.join('')}\n`);
      }
      if (code === 0) resolve();
      else reject(new Error(`${scriptName} exit ${code}`));
    });

    child.on('error', reject);
  });
}

// ============================
// Output 解析
// ============================

function parseCFLine(line, display) {
  // slot 進度：  HH:MM~HH:MM (TW) ssr=N ssg=N
  // --type all 會依序查每個頁面類型，共 CF_TOTAL_HOURS 個 slot-hour
  const mSlot = line.match(/(\d\d):(\d\d)~(\d\d):(\d\d) \(TW\)/);
  if (mSlot) {
    let startMins = parseInt(mSlot[1]) * 60 + parseInt(mSlot[2]);
    let endMins = parseInt(mSlot[3]) * 60 + parseInt(mSlot[4]);
    if (endMins <= startMins) endMins += 24 * 60; // 跨午夜
    display.cf.hours = Math.min(display.cf.hours + (endMins - startMins) / 60, CF_TOTAL_HOURS);
  }
  // 每輪查詢結束會各印一次：Astro cache hit  SSR: N 次  SSG: N 次，各輪加總為最終 hit 數
  const mSsr = line.match(/SSR:\s*(\d+)\s*次/);
  const mSsg = line.match(/SSG:\s*(\d+)\s*次/);
  if (mSsr && mSsg) {
    display.cf.hits += parseInt(mSsr[1]) + parseInt(mSsg[1]);
  }
}

function parseDDLine(line, display) {
  // 每頁請求：  第 N 頁...
  if (/第\s*\d+\s*頁/.test(line)) {
    if (!display.dd.startTime) display.dd.startTime = Date.now();
    display.dd.pages++;
  }
}

// ============================
// CF cache-hit 數據 merge 進 combined JSON
// ============================

function mergeCloudflareIntoCombined(dateDigits, pageKindKey) {
  const kind = PAGE_KINDS[pageKindKey];
  const cfPath = path.join(
    PROJECT_ROOT,
    `./daily-analysis-result/cloudflare/${dateDigits}/cloudflare-cache-hit${kind.cloudflare.fileSuffix}-${dateDigits}.json`,
  );
  const combinedPath = path.join(
    PROJECT_ROOT,
    `./daily-analysis-result/datadog-export/combined/combined-${dateDigits}_analysis.json`,
  );

  if (!fs.existsSync(cfPath)) { console.log(`  ⚠️  ${kind.label} CF JSON 不存在，略過 merge`); return false; }
  if (!fs.existsSync(combinedPath)) { console.log('  ⚠️  combined JSON 不存在，略過 merge'); return false; }

  const cf = JSON.parse(fs.readFileSync(cfPath, 'utf8'));
  const combined = JSON.parse(fs.readFileSync(combinedPath, 'utf8'));

  combined[kind.cloudflare.combinedCacheHitKey] = {
    total_ssr_hits: cf.total_ssr_hits,
    total_ssg_hits: cf.total_ssg_hits,
    total_hits: cf.total_hits,
    hourly: cf.hourly,
  };
  fs.writeFileSync(combinedPath, JSON.stringify(combined, null, 2), 'utf8');
  return true;
}

// ============================
// 404 統計 merge 進 combined JSON
// ============================

function mergeErrors404IntoCombined(dateDigits, pageKindKey) {
  const kind = PAGE_KINDS[pageKindKey];
  const e = kind.datadog.error404;
  const csvPath = path.join(PROJECT_ROOT, `./to-analyze-daily-data/${e.outputDirName}/${e.filePattern(dateDigits)}`);
  const combinedPath = path.join(
    PROJECT_ROOT,
    `./daily-analysis-result/datadog-export/combined/combined-${dateDigits}_analysis.json`,
  );

  if (!fs.existsSync(csvPath)) { console.log(`  ⚠️  ${kind.label} 404 CSV 不存在，略過 merge`); return false; }
  if (!fs.existsSync(combinedPath)) { console.log('  ⚠️  combined JSON 不存在，略過 merge'); return false; }

  const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n').slice(1); // 跳過 header

  let totalCount = 0;
  const distribution = {};
  const items = [];

  for (const line of lines) {
    const [key, countStr] = line.split(',');
    if (!key || !countStr) continue;
    const count = parseInt(countStr, 10);
    if (isNaN(count)) continue;
    totalCount += count;
    distribution[count] = (distribution[count] || 0) + 1;
    items.push({ [e.entryKeyName]: key.trim(), count });
  }

  items.sort((a, b) => b.count - a.count);

  const combined = JSON.parse(fs.readFileSync(combinedPath, 'utf8'));
  combined[e.combinedErrorsKey] = {
    total_404_count: totalCount,
    [e.affectedCountKey]: items.length,
    distribution: Object.fromEntries(
      Object.entries(distribution).sort((a, b) => Number(a[0]) - Number(b[0])),
    ),
    top10: items.slice(0, 10),
  };
  fs.writeFileSync(combinedPath, JSON.stringify(combined, null, 2), 'utf8');
  return true;
}

function mergeAllIntoCombined(dateDigits) {
  for (const kindKey of Object.keys(PAGE_KINDS)) {
    const merged = mergeCloudflareIntoCombined(dateDigits, kindKey);
    if (merged) console.log(`  \x1b[32m✓\x1b[0m  ${PAGE_KINDS[kindKey].label} CF cache hit 數據已寫入`);
  }
  for (const kindKey of Object.keys(PAGE_KINDS)) {
    const merged = mergeErrors404IntoCombined(dateDigits, kindKey);
    if (merged) console.log(`  \x1b[32m✓\x1b[0m  ${PAGE_KINDS[kindKey].label} 404 統計已寫入`);
  }
}

// ============================
// 輸出摘要
// ============================

function printSummary(dateDigits, cfOk, ddOk, analyzerOk) {
  const check = (p) => {
    const exists = fs.existsSync(path.join(PROJECT_ROOT, p));
    return `  ${exists ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${p}`;
  };

  const cfFiles = [];
  for (const kindKey of Object.keys(PAGE_KINDS)) {
    const kind = PAGE_KINDS[kindKey];
    const base = `cloudflare-cache-hit${kind.cloudflare.fileSuffix}-${dateDigits}`;
    cfFiles.push(`./daily-analysis-result/cloudflare/${dateDigits}/${base}.json`);
    cfFiles.push(`./daily-analysis-result/cloudflare/${dateDigits}/${base}.txt`);
  }

  const rawGroups = Object.keys(PAGE_KINDS).map((kindKey) => {
    const kind = PAGE_KINDS[kindKey];
    const files = kind.datadog.subQueries.map((sq) => `./to-analyze-daily-data/${sq.outputDirName}/${sq.filePattern(dateDigits)}`);
    if (kind.datadog.error404) {
      files.push(`./to-analyze-daily-data/${kind.datadog.error404.outputDirName}/${kind.datadog.error404.filePattern(dateDigits)}`);
    }
    return { label: `${kind.label} Datadog 原始 CSV`, ok: ddOk, files };
  });

  const analyzerFiles = [];
  for (const id of COMBINED_ORDER) {
    const v = VARIANTS[id];
    const base = v.filePattern(dateDigits).replace(/\.csv$/, '');
    analyzerFiles.push(`./daily-analysis-result/datadog-export/${v.outputDirName}/${base}_analysis.txt`);
    analyzerFiles.push(`./daily-analysis-result/datadog-export/${v.outputDirName}/${base}_analysis.json`);
  }
  analyzerFiles.push(`./daily-analysis-result/datadog-export/combined/combined-${dateDigits}_analysis.txt`);
  analyzerFiles.push(`./daily-analysis-result/datadog-export/combined/combined-${dateDigits}_analysis.json`);

  const groups = [
    { label: 'Cloudflare Cache Hit Log', ok: cfOk, files: cfFiles },
    ...rawGroups,
    { label: 'Datadog 分析報告', ok: analyzerOk, files: analyzerFiles },
  ];

  console.log('');
  console.log('='.repeat(64));
  console.log('  輸出檔案摘要');
  console.log('='.repeat(64));
  for (const g of groups) {
    console.log(`\n【${g.label}】`);
    if (!g.ok) console.log('  \x1b[31m⚠️  此步驟執行失敗，檔案可能不完整\x1b[0m');
    g.files.forEach((p) => console.log(check(p)));
  }
  console.log('');
}

// ============================
// Main
// ============================

async function main() {
  const args = parseArgs(process.argv);

  if (!args.date) {
    console.error('錯誤: 請指定 --date <YYYYMMDD>');
    console.log('用法: node bin/daily-pipeline.js --date <YYYYMMDD>');
    process.exit(1);
  }

  const dateDigits = normalizeDate(args.date);
  if (!dateDigits) {
    console.error(`錯誤: 無效的日期格式 "${args.date}"，請使用 YYYYMMDD 或 YYYY-MM-DD`);
    process.exit(1);
  }

  const dateDash = `${dateDigits.slice(0, 4)}-${dateDigits.slice(4, 6)}-${dateDigits.slice(6, 8)}`;
  const debugFlag = args.debug ? ['--debug'] : [];
  const envFlag = ['--env', args.env];

  if (args.mergeCfOnly) {
    console.log(`▶ --merge-cf-only：將既有 CF JSON / 404 CSV merge 進 combined JSON（日期 ${dateDash}）`);
    mergeAllIntoCombined(dateDigits);
    return;
  }

  console.log('');
  console.log('='.repeat(64));
  console.log('  每日 Log 分析整合工具');
  console.log(`  日期: ${dateDash} (台灣時區)`);
  console.log(`  環境: ${args.env}`);
  console.log(`  開始: ${nowTW()}`);
  console.log('='.repeat(64));
  console.log('');
  const display = new ProgressDisplay();
  const startTime = Date.now();

  if (args.analyzeOnly) {
    console.log('▶ 跳過 Step 1（--analyze-only 模式）');
    display.cf.done = true;
    display.dd.done = true;
  } else {
    console.log('▶ Step 1：下載 Cloudflare + Datadog log');
    console.log('');

    display.start();

    const cfPromise = runWithProgress(
      'cloudflare-log-fetcher.js',
      ['--date', dateDigits, ...envFlag, ...debugFlag],
      (line) => parseCFLine(line, display),
      'CF',
    )
      .then(() => { display.cf.done = true; })
      .catch((err) => { display.cf.error = err.message.slice(0, 40); });

    const ddPromise = runWithProgress(
      'datadog-log-fetcher.js',
      ['--date', dateDigits, ...envFlag, ...debugFlag],
      (line) => parseDDLine(line, display),
      'DD',
    )
      .then(() => { display.dd.done = true; })
      .catch((err) => { display.dd.error = err.message.slice(0, 40); });

    await Promise.all([cfPromise, ddPromise]);

    if (display.dd.error) {
      display.finalize();
      console.log('\nDatadog log 下載失敗，無法執行分析。');
      printSummary(dateDigits, !display.cf.error, false, false);
      process.exit(1);
    }
  }

  console.log('');
  console.log('▶ Step 2：執行 Datadog log 分析...');
  console.log('');

  display.analyzer.state = 'running';

  await runWithProgress(
    'datadog-export-analyzer.js',
    ['--type', 'all', '--date', dateDigits],
    null,
    'ANALYZER',
  )
    .then(() => { display.analyzer.done = true; })
    .catch((err) => { display.analyzer.error = err.message.slice(0, 40); });

  display.finalize();

  if (!display.cf.error && !display.analyzer.error) {
    console.log('');
    console.log('▶ Step 3：將 CF cache hit 數據寫入 combined JSON...');
    for (const kindKey of Object.keys(PAGE_KINDS)) {
      const merged = mergeCloudflareIntoCombined(dateDigits, kindKey);
      if (merged) console.log(`  \x1b[32m✓\x1b[0m  ${PAGE_KINDS[kindKey].label} CF cache hit 數據已寫入`);
    }
  }

  if (!display.analyzer.error) {
    console.log('');
    console.log('▶ Step 4：將 404 統計寫入 combined JSON...');
    for (const kindKey of Object.keys(PAGE_KINDS)) {
      const merged = mergeErrors404IntoCombined(dateDigits, kindKey);
      if (merged) console.log(`  \x1b[32m✓\x1b[0m  ${PAGE_KINDS[kindKey].label} 404 統計已寫入`);
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('');
  console.log('='.repeat(64));
  console.log(`  完成: ${nowTW()}  (耗時 ${elapsed}s)`);
  console.log('='.repeat(64));

  printSummary(dateDigits, !display.cf.error, !display.dd.error, !display.analyzer.error);

  if (display.cf.error || display.dd.error || display.analyzer.error) process.exit(1);
}

main().catch((err) => {
  console.error('執行錯誤:', err.message);
  process.exit(1);
});
