'use strict';

const { minuteLabel, hourLabel, secondLabel, nowTW } = require('../lib/time');
const { parseUA } = require('../lib/ua');
const { calcMinuteStats, calcPeakMinuteUA, calcHighFreq } = require('./aggregate');
const { COMBINED_ORDER, VARIANTS } = require('../config/variants');

// Latin 字母開頭的 label（如 SSG/SSR）跟後面的中文字之間習慣加空格，中文 label（如 分類頁）則不加
function labelSep(label) {
  return /^[A-Za-z]/.test(label) ? ' ' : '';
}

// recordsByVariant / filesByVariant 皆以 COMBINED_ORDER 的 variant id（如 'product-ssg'）為 key
function mergeCombinedAggregates(recordsByVariant) {
  const minuteCount = {};
  const hourCount = {};
  const uaCount = {};
  const uaMinutely = {};
  const uaSecondly = {};

  // 依 COMBINED_ORDER 初始化全部 key（即使某個 variant 這次沒資料也要有空 key，跟原本行為一致）
  for (const id of COMBINED_ORDER) {
    hourCount[VARIANTS[id].combinedShortKey] = {};
    uaCount[VARIANTS[id].combinedShortKey] = {};
  }
  hourCount.total = {};
  uaCount.total = {};

  function processRecords(records, shortKey) {
    for (const r of records) {
      if (!r.date) continue;
      const ua = r.userAgent || 'Unknown';
      const min = minuteLabel(r.date);
      const hr = hourLabel(r.date);
      const sec = secondLabel(r.date);

      if (min) minuteCount[min] = (minuteCount[min] || 0) + 1;

      if (hr) {
        hourCount[shortKey][hr] = (hourCount[shortKey][hr] || 0) + 1;
        hourCount.total[hr] = (hourCount.total[hr] || 0) + 1;
      }

      uaCount[shortKey][ua] = (uaCount[shortKey][ua] || 0) + 1;
      uaCount.total[ua] = (uaCount.total[ua] || 0) + 1;

      if (min) {
        if (!uaMinutely[min]) uaMinutely[min] = {};
        uaMinutely[min][ua] = (uaMinutely[min][ua] || 0) + 1;
      }
      if (sec) {
        if (!uaSecondly[sec]) uaSecondly[sec] = {};
        uaSecondly[sec][ua] = (uaSecondly[sec][ua] || 0) + 1;
      }
    }
  }

  for (const id of COMBINED_ORDER) {
    processRecords(recordsByVariant[id] || [], VARIANTS[id].combinedShortKey);
  }

  return { minuteCount, hourCount, uaCount, uaMinutely, uaSecondly };
}

function calcCombinedUAStats(uaCount) {
  const total = Object.values(uaCount.total).reduce((s, v) => s + v, 0);
  const ranking = Object.entries(uaCount.total).map(([ua, count]) => {
    const { browser, os } = parseUA(ua);
    const row = { ua, total: count };
    for (const id of COMBINED_ORDER) {
      row[VARIANTS[id].combinedShortKey] = uaCount[VARIANTS[id].combinedShortKey][ua] || 0;
    }
    row.pct = Math.round((count / total) * 10000) / 100;
    row.browser = browser;
    row.os = os;
    return row;
  }).sort((a, b) => b.total - a.total);
  return { total, unique: ranking.length, ranking: ranking.slice(0, 20) };
}

function activeLabels(filesByVariant) {
  return COMBINED_ORDER.filter((id) => filesByVariant[id]).map((id) => VARIANTS[id].combinedShortLabel);
}

function generateCombinedReport(dateDigits, filesByVariant, recordsByVariant, agg) {
  const { minuteCount, hourCount, uaCount, uaMinutely, uaSecondly } = agg;
  const minStats = calcMinuteStats(minuteCount);
  const allRecords = COMBINED_ORDER.flatMap((id) => recordsByVariant[id] || []);
  const peakUA = calcPeakMinuteUA(minuteCount, allRecords, null);
  const hf = calcHighFreq(uaMinutely, uaSecondly);
  const uaStats = calcCombinedUAStats(uaCount);

  const dateDash = `${dateDigits.slice(0, 4)}-${dateDigits.slice(4, 6)}-${dateDigits.slice(6, 8)}`;

  const lines = [];
  lines.push('Datadog Log 分析報告 (Combined 模式)');
  lines.push(`生成時間: ${nowTW()}`);
  lines.push('時區說明: 所有時間已轉換為台灣時區 (UTC+8)');
  lines.push('='.repeat(64));
  lines.push('');
  lines.push('檔案資訊:');
  lines.push(`• 日期: ${dateDash}`);
  for (const id of COMBINED_ORDER) {
    const label = VARIANTS[id].combinedShortLabel;
    lines.push(`• ${label}${labelSep(label)}檔案: ${filesByVariant[id] || '（無資料）'}`);
  }
  lines.push('');
  lines.push('資料來源統計:');
  const modeLabel = `Combined（${activeLabels(filesByVariant).join(' + ')} 合併）`;
  lines.push(`• 分析模式: ${modeLabel}`);
  for (const id of COMBINED_ORDER) {
    const label = VARIANTS[id].combinedShortLabel;
    const file = filesByVariant[id];
    const count = (recordsByVariant[id] || []).length;
    lines.push(`• ${label}${labelSep(label)}記錄: ${file ? count + ' 筆' : '0 筆（檔案不存在）'}`);
  }
  lines.push(`• 合併分析總筆數: ${uaStats.total} 筆`);
  lines.push('');

  const totalHours = Object.keys(hourCount.total).length;
  const avgPerHour = totalHours
    ? Math.round((Object.values(hourCount.total).reduce((s, v) => s + v, 0) / totalHours) * 100) / 100
    : 0;
  lines.push(`每小時資料筆數平均值 (合計): ${avgPerHour}`);
  lines.push('');

  lines.push('每分鐘 Request 數量統計 (合計):');
  lines.push(`• 最高值: ${minStats.max} requests/分鐘`);
  lines.push(`• 最低值: ${minStats.min} requests/分鐘`);
  lines.push(`• 平均值: ${minStats.avg} requests/分鐘`);
  lines.push(`• 統計分鐘數: ${minStats.total} 分鐘`);
  lines.push('');
  lines.push('每分鐘 Request 數量 TOP 15 (合計):');
  minStats.sorted.slice(0, 15).forEach(([min, count], i) => {
    lines.push(`${i + 1}. ${min} - ${count} requests`);
  });
  lines.push('');

  if (peakUA) {
    lines.push('峰值分鐘 User-Agent 分析 (台灣時區):');
    lines.push('='.repeat(48));
    lines.push(`• 峰值分鐘: ${peakUA.peakMin}`);
    lines.push(`• 峰值請求數: ${peakUA.peakCount} 筆`);
    lines.push(`• 並列峰值分鐘數: ${peakUA.tiedCount} 個`);
    lines.push(`• 該分鐘不同User-Agent數量: ${peakUA.uniqueUA} 種`);
    lines.push('');
    lines.push('峰值分鐘 User-Agent 排行 (前20名):');
    peakUA.uaRanking.forEach((item, i) => {
      lines.push(`${i + 1}. User-Agent: ${item.ua}`);
      lines.push(`   • 請求數: ${item.count} 筆 (${item.pct}%)`);
    });
    lines.push('');
  }

  lines.push('高頻訪問模式分析 (合計):');
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

  lines.push(`User-Agent 進站總數排行 (前20名，含 ${COMBINED_ORDER.map((id) => VARIANTS[id].combinedShortLabel).join('/')}分類):`);
  lines.push('='.repeat(48));
  lines.push(`總計: ${uaStats.total} 筆 / 不同 UA: ${uaStats.unique} 種`);
  lines.push('');
  uaStats.ranking.forEach((item, i) => {
    lines.push(`${i + 1}. User-Agent: ${item.ua}`);
    const perTypeStr = COMBINED_ORDER.map((id) => {
      const label = VARIANTS[id].combinedShortLabel;
      return `${label}: ${item[VARIANTS[id].combinedShortKey]} 筆`;
    }).join('  ');
    lines.push(`   • 總計: ${item.total} 筆 (${item.pct}%)  ${perTypeStr}`);
  });
  lines.push('');

  lines.push('每小時資料筆數詳細 (台灣時區):');
  const allHours = [...new Set(COMBINED_ORDER.flatMap((id) => Object.keys(hourCount[VARIANTS[id].combinedShortKey])))].sort();
  allHours.forEach((hr) => {
    const counts = COMBINED_ORDER.map((id) => hourCount[VARIANTS[id].combinedShortKey][hr] || 0);
    const sum = counts.reduce((s, v) => s + v, 0);
    const detail = COMBINED_ORDER.map((id, i) => `${VARIANTS[id].combinedShortLabel}: ${counts[i]}`).join(', ');
    lines.push(`${hr}: 合計 ${sum} 筆  (${detail})`);
  });
  lines.push('');

  return lines.join('\n');
}

function buildCombinedJsonOutput(dateDigits, filesByVariant, recordsByVariant, combinedAgg) {
  const minStats = calcMinuteStats(combinedAgg.minuteCount);
  const allRecords = COMBINED_ORDER.flatMap((id) => recordsByVariant[id] || []);
  const peakUA = calcPeakMinuteUA(combinedAgg.minuteCount, allRecords, null);
  const hf = calcHighFreq(combinedAgg.uaMinutely, combinedAgg.uaSecondly);
  const uaStats = calcCombinedUAStats(combinedAgg.uaCount);
  const combinedTotal = Object.values(combinedAgg.uaCount.total).reduce((s, v) => s + v, 0);
  const totalHours = Object.keys(combinedAgg.hourCount.total).length;
  const avgPerHour = totalHours
    ? Math.round((Object.values(combinedAgg.hourCount.total).reduce((s, v) => s + v, 0) / totalHours) * 100) / 100
    : 0;

  const file_info = {};
  const data_source_stats = {};
  const hourly_request_data_by_type = {};
  for (const id of COMBINED_ORDER) {
    const key = VARIANTS[id].combinedShortKey;
    file_info[`${key}_file`] = filesByVariant[id] || null;
    data_source_stats[`${key}_records`] = (recordsByVariant[id] || []).length;
    hourly_request_data_by_type[key] = combinedAgg.hourCount[key];
  }
  data_source_stats.total_records = combinedTotal;

  return {
    analysis_time: new Date().toISOString(),
    timezone_info: '所有時間已轉換為台灣時區 (UTC+8)',
    analysis_mode: `Combined（${activeLabels(filesByVariant).join(' + ')} 合併）`,

    file_info,
    data_source_stats,

    avg_requests_per_hour: avgPerHour,

    per_minute_stats: {
      max_value: minStats.max,
      min_value: minStats.min,
      average_value: minStats.avg,
      total_minutes: minStats.total,
      top_15: minStats.sorted.slice(0, 15).map(([minute, count]) => ({ minute, count })),
    },

    peak_minute_user_agent_analysis: peakUA ? {
      peak_minute: peakUA.peakMin,
      peak_request_count: peakUA.peakCount,
      total_peak_minutes: peakUA.tiedCount,
      total_user_agents: peakUA.uniqueUA,
      user_agent_distribution: peakUA.uaRanking.map((r) => ({
        userAgent: r.ua, count: r.count, percentage: r.pct, browser: r.browser, os: r.os,
      })),
    } : null,

    high_frequency_analysis: {
      minute_top10: hf.minuteTop10.map((r) => ({ user_agent: r.ua, total: r.total, max_per_minute: r.maxCount })),
      second_top10: hf.secondTop10.map((r) => ({ user_agent: r.ua, total: r.total, max_per_second: r.maxCount })),
      total_minute_violations: hf.totalMinVio,
      total_second_violations: hf.totalSecVio,
      unique_violating_user_agents: hf.uniqueViolatingUA,
    },

    user_agent_analysis: {
      overall_stats: { total_requests: uaStats.total, unique_user_agents: uaStats.unique },
      user_agent_ranking: uaStats.ranking.map((r) => {
        const row = { userAgent: r.ua, total: r.total };
        for (const id of COMBINED_ORDER) {
          const key = VARIANTS[id].combinedShortKey;
          row[key] = r[key];
        }
        row.percentage = r.pct;
        row.browser = r.browser;
        row.os = r.os;
        return row;
      }),
    },

    hourly_request_data: combinedAgg.hourCount.total,
    hourly_request_data_by_type,

    minutely_request_data: combinedAgg.minuteCount,

    chart_data: Object.entries(combinedAgg.hourCount.total)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([hour, count]) => ({ hour, count })),
  };
}

module.exports = { mergeCombinedAggregates, calcCombinedUAStats, generateCombinedReport, buildCombinedJsonOutput, labelSep };
