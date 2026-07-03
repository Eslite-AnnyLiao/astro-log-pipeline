'use strict';

const { nowTW, toTW } = require('../lib/time');

function appendCommonSections(lines, records, agg, computed, hasRenderTimeline) {
  const { hourCount } = agg;
  const { minStats, peakUA, hf, uaStats } = computed;
  const avgPerHour = Object.keys(hourCount).length
    ? Math.round((Object.values(hourCount).reduce((s, v) => s + v, 0) / Object.keys(hourCount).length) * 100) / 100
    : 0;

  lines.push(`每小時資料筆數平均值: ${avgPerHour}`);
  lines.push('');
  lines.push('每分鐘 Request 數量統計:');
  lines.push(`• 最高值: ${minStats.max} requests/分鐘`);
  lines.push(`• 最低值: ${minStats.min} requests/分鐘`);
  lines.push(`• 平均值: ${minStats.avg} requests/分鐘`);
  lines.push(`• 統計分鐘數: ${minStats.total} 分鐘`);
  lines.push('');
  lines.push('每分鐘 Request 數量 TOP 15:');
  minStats.sorted.slice(0, 15).forEach(([min, count], i) => {
    lines.push(`${i + 1}. ${min} - ${count} requests`);
  });
  lines.push('');

  if (peakUA) {
    lines.push('每分鐘Request數量最高值的分鐘中User-Agent分析 (台灣時區):');
    lines.push('='.repeat(48));
    lines.push('峰值分鐘總體資訊:');
    lines.push(`• 峰值分鐘: ${peakUA.peakMin}`);
    lines.push(`• 峰值請求數: ${peakUA.peakCount} 筆`);
    lines.push(`• 並列峰值分鐘數: ${peakUA.tiedCount} 個`);
    lines.push(`• 該分鐘不同User-Agent數量: ${peakUA.uniqueUA} 種`);
    lines.push('');
    lines.push('峰值分鐘User-Agent排行榜 (前20名):');
    peakUA.uaRanking.forEach((item, i) => {
      lines.push(`${i + 1}. User-Agent: ${item.ua}`);
      lines.push(`   • 請求數: ${item.count} 筆`);
      lines.push(`   • 佔比: ${item.pct}%`);
      lines.push(`   • 瀏覽器: ${item.browser}`);
    });
    lines.push('');
  }

  lines.push('高頻訪問模式分析:');
  lines.push('='.repeat(48));
  lines.push('📊 高頻訪問整體統計:');
  lines.push(`• 一分鐘內 >20次 筆數: ${hf.totalMinVio}`);
  lines.push(`• 一秒內 >5次 筆數: ${hf.totalSecVio}`);
  lines.push(`• 涉及 UserAgent 種數: ${hf.uniqueViolatingUA}`);
  lines.push('');
  lines.push('🚨 一分鐘內訪問大於2次的 UserAgent (前10名):');
  if (hf.minuteTop10.length) {
    hf.minuteTop10.forEach((item, i) => {
      lines.push(`${i + 1}. ${item.ua}`);
      lines.push(`   • 觸發次數: ${item.total}, 最高單分鐘: ${item.maxCount}`);
    });
  } else {
    lines.push('• 無紀錄');
  }
  lines.push('');
  lines.push('⚡ 一秒內訪問大於2次的 UserAgent (前10名):');
  if (hf.secondTop10.length) {
    hf.secondTop10.forEach((item, i) => {
      lines.push(`${i + 1}. ${item.ua}`);
      lines.push(`   • 觸發次數: ${item.total}, 最高單秒: ${item.maxCount}`);
    });
  } else {
    lines.push('• 無紀錄');
  }
  lines.push('');

  lines.push('User-Agent 分析結果:');
  lines.push('='.repeat(48));
  lines.push('User-Agent 總體統計:');
  lines.push(`• 總請求數: ${uaStats.total}`);
  lines.push(`• 不同 User-Agent 數量: ${uaStats.unique}`);
  lines.push('');
  const rankTitle = hasRenderTimeline
    ? 'User-Agent 排行榜 (前10名，包含平均 Render 時間):'
    : 'User-Agent 排行榜 (前10名):';
  lines.push(rankTitle);
  uaStats.ranking.forEach((item, i) => {
    lines.push(`${i + 1}. User-Agent: ${item.ua}`);
    lines.push(`   • 請求數: ${item.count} 筆 (${item.pct}%)`);
    lines.push(`   • 瀏覽器: ${item.browser} / OS: ${item.os}`);
    if (item.avgMs != null) lines.push(`   • 平均Duration: ${item.avgMs} ms`);
  });
  lines.push('');
  lines.push('每小時最常訪問的 User-Agent (前24小時):');
  Object.entries(uaStats.hourlyTop)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([hr, info]) => {
      if (info.top) lines.push(`${hr}: ${info.top.ua} (${info.top.count} 筆, 共 ${info.total} 筆, ${info.unique} 種UA)`);
    });
  lines.push('');
  lines.push('每小時資料筆數詳細 (台灣時區):');
  Object.entries(hourCount)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([hr, count]) => lines.push(`${hr}: ${count} 筆`));
  lines.push('');
}

function appendUrlSection(lines, urlStats) {
  lines.push('URL 分析結果:');
  lines.push('='.repeat(48));
  lines.push('URL 總體統計:');
  lines.push(`• 總訪問次數: ${urlStats.total}`);
  lines.push(`• 不同 URL 數量: ${urlStats.unique}`);
  lines.push('');
  lines.push('重複次數最多的 URL (前10名):');
  if (urlStats.top10.length) {
    urlStats.top10.forEach((item, i) => {
      lines.push(`${i + 1}. ${item.url}`);
      lines.push(`   • 訪問次數: ${item.count} 次 (${item.pct}%)`);
    });
  } else {
    lines.push('• 無 URL 資料');
  }
  lines.push('');
}

// 取代原本的 generateSSGReport / generateSSRReport / generateCategoryReport 三個近乎複製貼上的函式：
// hasRenderTimeline 決定要不要印 Render Time / 慢渲染時段 / Render 前15名 / 大於3000ms 等區塊；
// extraBreakdown 決定要不要印結尾的細項表格（product_id 或 category_key）。
function generateVariantReport(variantConfig, filePath, records, agg, computed) {
  const { slowItems } = agg;
  const { renderStats, slowHM, urlStats } = computed;
  const lines = [];
  lines.push(`Datadog Log 分析報告 (${variantConfig.reportTitle})`);
  lines.push(`生成時間: ${nowTW()}`);
  lines.push('時區說明: 所有時間已轉換為台灣時區 (UTC+8)');
  lines.push('='.repeat(64));
  lines.push('');
  lines.push('檔案資訊:');
  lines.push(`• 輸入檔案: ${filePath}`);
  lines.push('');
  lines.push('資料來源統計:');
  lines.push(`• 分析模式: ${variantConfig.analysisModeLabel}`);
  lines.push(`• 總記錄筆數: ${records.length} 筆`);
  if (variantConfig.hasRenderTimeline) {
    lines.push(`• 有效 Duration 記錄: ${agg.renderItems.length} 筆`);
  }
  lines.push('');

  if (variantConfig.hasRenderTimeline && renderStats) {
    lines.push('Render Time 統計:');
    lines.push(`• 平均值: ${renderStats.avg} ms`);
    lines.push(`• 最小值: ${renderStats.min} ms`);
    lines.push(`• 最大值: ${renderStats.max} ms`);
    lines.push(`• 中位數 (P50): ${renderStats.p50} ms`);
    lines.push(`• 第90百分位數 (P90): ${renderStats.p90} ms`);
    lines.push(`• 第95百分位數 (P95): ${renderStats.p95} ms`);
    lines.push(`• 第98百分位數 (P98): ${renderStats.p98} ms`);
    lines.push(`• 第99百分位數 (P99): ${renderStats.p99} ms`);
    lines.push(`• 慢渲染 (3-5秒)的總數: ${renderStats.slow3to5}`);
    lines.push(`• 異常渲染 (5秒以上)的總數: ${renderStats.slowOver5}`);
    lines.push(`• 總資料筆數: ${renderStats.count}`);
    lines.push('');
  }

  appendCommonSections(lines, records, agg, computed, variantConfig.hasRenderTimeline);

  if (variantConfig.hasRenderTimeline) {
    lines.push('慢渲染時段同時同分統計 (>3000ms, 台灣時區):');
    lines.push('='.repeat(48));
    lines.push('慢渲染時段同時同分總體統計:');
    lines.push(`• 慢渲染總筆數: ${slowHM.total}`);
    lines.push(`• 出現慢渲染的不同時分點數: ${slowHM.all.length}`);
    lines.push('');
    lines.push('慢渲染出現次數最多的時分:');
    if (slowHM.mostFrequent.length) {
      slowHM.mostFrequent.forEach((item, i) => lines.push(`${i + 1}. ${item.time} - ${item.count} 次`));
    } else {
      lines.push('• 無慢渲染記錄');
    }
    lines.push('');
    lines.push('慢渲染重複出現的時分點 (出現次數 > 1):');
    if (slowHM.duplicates.length) {
      slowHM.duplicates.forEach((item, i) => lines.push(`${i + 1}. ${item.time} - ${item.count} 次`));
    } else {
      lines.push('• 無重複時分點');
    }
    lines.push('');
    lines.push('所有慢渲染時分點統計 (按時間排序):');
    slowHM.all.forEach((item) => lines.push(`${item.time}: ${item.count} 次`));
    lines.push('');

    lines.push('Render 時間前 15 名 (最慢的請求，包含 URL):');
    urlStats.top15slow.forEach((item, i) => {
      lines.push(`${i + 1}. ${item.ms} ms | ${item.url}`);
      lines.push(`   • User-Agent: ${item.ua}`);
      lines.push(`   • 時間: ${item.tw || '(無時間)'}`);
    });
    lines.push('');

    lines.push('大於 3000ms 的時段 (台灣時區，按時間排序，前10筆):');
    [...slowItems].sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, 10).forEach((item, i) => {
      const tw = toTW(item.date);
      lines.push(`${i + 1}. ${tw || item.date} | ${item.ms} ms | ${item.url || '(無URL)'} | ${item.ua}`);
    });
    lines.push('');
  }

  appendUrlSection(lines, urlStats);

  if (variantConfig.extraBreakdown) {
    const { aggKey, reportHeading } = variantConfig.extraBreakdown;
    const entries = Object.entries(agg[aggKey] || {}).sort((a, b) => b[1] - a[1]);
    if (entries.length) {
      lines.push(reportHeading);
      entries.slice(0, 10).forEach(([key, count], i) => {
        lines.push(`${i + 1}. ${key}: ${count} 次`);
      });
      lines.push('');
    }
  }

  return lines.join('\n');
}

module.exports = { appendCommonSections, appendUrlSection, generateVariantReport };
