'use strict';

const fs = require('fs');
const path = require('path');

const { normalizeDate, toTW } = require('../lib/time');
const { VARIANTS, COMBINED_ORDER } = require('../config/variants');
const {
  readCSV, buildAggregates, calcRenderStats, calcMinuteStats, calcPeakMinuteUA,
  calcSlowHM, calcHighFreq, calcUAStats, calcUrlStats,
} = require('./aggregate');
const { generateVariantReport } = require('./report');
const { buildJsonOutput } = require('./json-output');
const { mergeCombinedAggregates, generateCombinedReport, buildCombinedJsonOutput, labelSep } = require('./combined');

function parseArgs(argv) {
  const args = { type: null, input: null, date: null, output: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--type' && argv[i + 1]) args.type = argv[++i];
    else if (argv[i] === '--input' && argv[i + 1]) args.input = argv[++i];
    else if (argv[i] === '--date' && argv[i + 1]) args.date = argv[++i];
    else if (argv[i] === '--output' && argv[i + 1]) args.output = argv[++i];
  }
  return args;
}

// 依 variantConfig 的 filePattern/inputDirName 組出路徑
// strict=true 時找不到直接 exit，strict=false 時回傳 null
function findInputByDate(variantConfig, dateDigits, strict = true) {
  const fileName = variantConfig.filePattern(dateDigits);
  const filePath = `./to-analyze-daily-data/${variantConfig.inputDirName}/${fileName}`;
  if (!fs.existsSync(filePath)) {
    if (strict) {
      console.error(`錯誤: 找不到檔案 "${filePath}"`);
      process.exit(1);
    }
    return null;
  }
  return filePath;
}

async function runSingleVariant(variantConfig, input, output) {
  console.log(`\n讀取檔案: ${input}`);
  console.log(`分析模式: ${variantConfig.id.toUpperCase()}`);
  if (variantConfig.excludeUserAgents.length) console.log(`排除 UA: ${variantConfig.excludeUserAgents.join(', ')}`);

  const records = await readCSV(input, variantConfig);
  console.log(`共 ${records.length} 筆記錄`);

  const agg = buildAggregates(records, variantConfig);

  const computed = {
    renderStats: calcRenderStats(agg.renderItems),
    minStats: calcMinuteStats(agg.minuteCount),
    peakUA: calcPeakMinuteUA(agg.minuteCount, records, variantConfig),
    slowHM: calcSlowHM(agg.slowItems),
    hf: calcHighFreq(agg.uaMinutely, agg.uaSecondly),
    uaStats: calcUAStats(agg.uaCount, agg.uaHourly, agg.renderItems),
    urlStats: calcUrlStats(agg.urlCount, agg.renderItems, toTW),
  };

  const report = generateVariantReport(variantConfig, input, records, agg, computed);

  const outDir = output || `./daily-analysis-result/datadog-export/${variantConfig.outputDirName}`;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const base = path.basename(input, '.csv');
  const txtPath = path.join(outDir, `${base}_analysis.txt`);
  const jsonPath = path.join(outDir, `${base}_analysis.json`);

  fs.writeFileSync(txtPath, report, 'utf8');

  const jsonOut = buildJsonOutput(variantConfig, input, records, agg, computed);
  fs.writeFileSync(jsonPath, JSON.stringify(jsonOut, null, 2), 'utf8');

  console.log(`\n分析完成！`);
  console.log(`• 文字報告: ${txtPath}`);
  console.log(`• JSON 資料: ${jsonPath}`);
}

async function runCombined(date, output) {
  if (!date) {
    console.error('錯誤: combined 模式需要指定 --date <YYYYMMDD>');
    process.exit(1);
  }
  const dateDigits = normalizeDate(date);
  if (!dateDigits) {
    console.error(`錯誤: 無效的日期格式 "${date}"`);
    process.exit(1);
  }

  const filesByVariant = {};
  for (const id of COMBINED_ORDER) {
    filesByVariant[id] = findInputByDate(VARIANTS[id], dateDigits, false);
  }

  // product-ssg 改用計算值取得（不再下載明細 CSV），改讀 fetch 階段寫出的計算結果 JSON
  const recordCountOverrides = {};
  const ssgCountPath = `./to-analyze-daily-data/product/ssg/ssg-count-${dateDigits}.json`;
  if (!filesByVariant['product-ssg'] && fs.existsSync(ssgCountPath)) {
    const ssgCountData = JSON.parse(fs.readFileSync(ssgCountPath, 'utf8'));
    recordCountOverrides['product-ssg'] = ssgCountData.computed_count;
    filesByVariant['product-ssg'] = ssgCountPath;
  }

  if (COMBINED_ORDER.every((id) => !filesByVariant[id])) {
    console.error('錯誤: 所有來源檔案均不存在，無法執行 combined 分析');
    process.exit(1);
  }

  console.log('\n分析模式: COMBINED');
  for (const id of COMBINED_ORDER) {
    const label = VARIANTS[id].combinedShortLabel;
    if (filesByVariant[id]) console.log(`${label}${labelSep(label)}檔案: ${filesByVariant[id]}`);
    else console.log(`⚠️  ${label}${labelSep(label)}檔案不存在`);
  }

  const recordsByVariant = {};
  await Promise.all(COMBINED_ORDER.map(async (id) => {
    // 有 override 的 variant（例如 product-ssg）是計算值，不是 CSV，沒有逐筆記錄可讀
    recordsByVariant[id] = (filesByVariant[id] && recordCountOverrides[id] == null)
      ? await readCSV(filesByVariant[id], VARIANTS[id])
      : [];
  }));

  for (const id of COMBINED_ORDER) {
    if (recordCountOverrides[id] != null) console.log(`${VARIANTS[id].combinedShortLabel}: ${recordCountOverrides[id]} 筆（計算值）`);
    else if (filesByVariant[id]) console.log(`${VARIANTS[id].combinedShortLabel}: ${recordsByVariant[id].length} 筆`);
  }

  const combinedAgg = mergeCombinedAggregates(recordsByVariant);
  const report = generateCombinedReport(dateDigits, filesByVariant, recordsByVariant, combinedAgg, recordCountOverrides);

  const outDir = output || './daily-analysis-result/datadog-export/combined';
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const txtPath = path.join(outDir, `combined-${dateDigits}_analysis.txt`);
  const jsonPath = path.join(outDir, `combined-${dateDigits}_analysis.json`);

  fs.writeFileSync(txtPath, report, 'utf8');

  const jsonOut = buildCombinedJsonOutput(dateDigits, filesByVariant, recordsByVariant, combinedAgg, recordCountOverrides);
  fs.writeFileSync(jsonPath, JSON.stringify(jsonOut, null, 2), 'utf8');

  console.log(`\n分析完成！`);
  console.log(`• 文字報告: ${txtPath}`);
  console.log(`• JSON 資料: ${jsonPath}`);
}

async function runAll(date, output) {
  if (!date) {
    console.error('錯誤: all 模式需要指定 --date <YYYYMMDD>');
    process.exit(1);
  }
  const { execSync } = require('child_process');
  const script = path.join(__dirname, '..', '..', 'bin', 'datadog-export-analyzer.js');
  const dateDigitsAll = normalizeDate(date);
  const outArg = output ? `--output ${output}` : '';

  const presence = COMBINED_ORDER.map((id) => ({ id, has: dateDigitsAll && !!findInputByDate(VARIANTS[id], dateDigitsAll, false) }));
  const types = presence.filter((p) => p.has).map((p) => p.id);
  if (types.length) types.push('combined');

  presence.filter((p) => !p.has).forEach((p) => console.log(`⚠️  ${VARIANTS[p.id].label} 檔案不存在，跳過 ${p.id}`));
  if (!types.length) {
    console.error('錯誤: 所有來源檔案均不存在，無法執行分析');
    process.exit(1);
  }

  for (const t of types) {
    console.log(`\n${'='.repeat(48)}\n▶ 執行 --type ${t}\n${'='.repeat(48)}`);
    execSync(`node "${script}" --type ${t} --date ${date} ${outArg}`, { stdio: 'inherit' });
  }
}

async function main() {
  const { type, input: inputArg, date, output } = parseArgs(process.argv);

  const validTypes = [...Object.keys(VARIANTS), 'combined', 'all'];
  if (!type || !validTypes.includes(type)) {
    console.error(`錯誤: 請指定 --type ${validTypes.join(' / ')}`);
    console.log('用法: node bin/datadog-export-analyzer.js --type all --date <YYYYMMDD>');
    console.log(`      node bin/datadog-export-analyzer.js --type <${Object.keys(VARIANTS).join('|')}|combined> --date <YYYYMMDD>`);
    console.log(`      node bin/datadog-export-analyzer.js --type <${Object.keys(VARIANTS).join('|')}> --input <csv_file>`);
    process.exit(1);
  }

  if (type === 'all') return runAll(date, output);
  if (type === 'combined') return runCombined(date, output);

  const variantConfig = VARIANTS[type];

  let input = inputArg;
  if (!input && date) {
    const dateDigits = normalizeDate(date);
    if (!dateDigits) {
      console.error(`錯誤: 無效的日期格式 "${date}"，請使用 YYYYMMDD 或 YYYY-MM-DD`);
      process.exit(1);
    }
    input = findInputByDate(variantConfig, dateDigits);
  }

  if (!input) {
    console.error('錯誤: 請指定 --date <YYYYMMDD> 或 --input <csv_file>');
    process.exit(1);
  }
  if (!fs.existsSync(input)) {
    console.error(`錯誤: 找不到檔案 "${input}"`);
    process.exit(1);
  }

  await runSingleVariant(variantConfig, input, output);
}

module.exports = { main };
