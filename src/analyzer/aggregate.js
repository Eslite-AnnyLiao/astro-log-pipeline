'use strict';

const fs = require('fs');
const { parse } = require('csv-parse');
const { hourLabel, minuteLabel, hmLabel, secondLabel } = require('../lib/time');
const { parseUA, pct } = require('../lib/ua');

function parseDurationMs(str) {
  if (!str) return null;
  const ms = String(str).match(/^([\d.]+)\s*ms$/i);
  if (ms) return Math.round(parseFloat(ms[1]));
  const s = String(str).match(/^([\d.]+)\s*s$/i);
  if (s) return Math.round(parseFloat(s[1]) * 1000);
  return null;
}

function extractReqId(content) {
  const m = String(content || '').match(/page-render\s*\|\s*(.+)/);
  return m ? m[1].trim() : null;
}

// variantConfig: 見 src/config/variants.js（excludeUserAgents / urlBuilder / extraBreakdown）
async function readCSV(filePath, variantConfig) {
  return new Promise((resolve, reject) => {
    const records = [];
    fs.createReadStream(filePath)
      .pipe(parse({ columns: true, trim: true, bom: true }))
      .on('data', (row) => {
        const ua = row['User agent'] || row['User Agent'] || row['user agent'] || '';
        if (variantConfig.excludeUserAgents.includes(ua)) return;

        const reqId = extractReqId(row['Content'] || row['content']);
        const productId = (row['@product_id'] || '').trim() || null;
        const categoryKey = ['L1', 'L2', 'L3']
          .filter((col) => (row[col] || '').trim())
          .map((col) => `${col}=${row[col].trim()}`)
          .join('/') || null;

        const rec = {
          date: row['Date'] || row['date'] || '',
          durationMs: parseDurationMs(row['Duration'] || row['duration']),
          userAgent: ua,
          content: row['Content'] || row['content'] || '',
          reqId,
          productId,
          categoryKey,
        };
        rec.url = variantConfig.urlBuilder(rec);
        records.push(rec);
      })
      .on('end', () => resolve(records))
      .on('error', reject);
  });
}

function buildAggregates(records, variantConfig) {
  const minuteCount = {};
  const hourCount = {};
  const uaCount = {};
  const uaHourly = {};
  const uaMinutely = {};
  const uaSecondly = {};
  const renderItems = [];
  const slowItems = [];
  const urlCount = {};
  const extraCount = {};

  for (const r of records) {
    if (!r.date) continue;
    const ua = r.userAgent || 'Unknown';

    const hr = hourLabel(r.date);
    if (hr) hourCount[hr] = (hourCount[hr] || 0) + 1;

    const min = minuteLabel(r.date);
    const sec = secondLabel(r.date);
    const hm = hmLabel(r.date);

    if (min) minuteCount[min] = (minuteCount[min] || 0) + 1;
    uaCount[ua] = (uaCount[ua] || 0) + 1;

    if (hr) {
      if (!uaHourly[hr]) uaHourly[hr] = {};
      uaHourly[hr][ua] = (uaHourly[hr][ua] || 0) + 1;
    }
    if (min) {
      if (!uaMinutely[min]) uaMinutely[min] = {};
      uaMinutely[min][ua] = (uaMinutely[min][ua] || 0) + 1;
    }
    if (sec) {
      if (!uaSecondly[sec]) uaSecondly[sec] = {};
      uaSecondly[sec][ua] = (uaSecondly[sec][ua] || 0) + 1;
    }

    if (r.url) urlCount[r.url] = (urlCount[r.url] || 0) + 1;

    if (r.durationMs != null) {
      renderItems.push({ ms: r.durationMs, ua, date: r.date, url: r.url });
      if (r.durationMs >= 3000) {
        slowItems.push({ ms: r.durationMs, ua, date: r.date, hm, url: r.url });
      }
    }

    if (variantConfig.extraBreakdown) {
      const key = r[variantConfig.extraBreakdown.idField];
      if (key) extraCount[key] = (extraCount[key] || 0) + 1;
    }
  }

  const agg = { minuteCount, hourCount, uaCount, uaHourly, uaMinutely, uaSecondly, renderItems, slowItems, urlCount };
  if (variantConfig.extraBreakdown) {
    agg[variantConfig.extraBreakdown.aggKey] = extraCount;
  }
  return agg;
}

function calcRenderStats(renderItems) {
  if (!renderItems.length) return null;
  const ms = renderItems.map((r) => r.ms).sort((a, b) => a - b);
  const sum = ms.reduce((s, v) => s + v, 0);
  return {
    count: ms.length,
    avg: Math.round((sum / ms.length) * 100) / 100,
    min: ms[0],
    max: ms[ms.length - 1],
    p50: Math.round(pct(ms, 50)),
    p90: Math.round(pct(ms, 90)),
    p95: Math.round(pct(ms, 95)),
    p98: Math.round(pct(ms, 98)),
    p99: Math.round(pct(ms, 99) * 10) / 10,
    slow3to5: ms.filter((v) => v >= 3000 && v < 5000).length,
    slowOver5: ms.filter((v) => v >= 5000).length,
  };
}

function calcHourlyRenderStats(renderItems) {
  const byHour = {};
  for (const { ms, date } of renderItems) {
    const hr = hourLabel(date);
    if (!hr) continue;
    if (!byHour[hr]) byHour[hr] = [];
    byHour[hr].push(ms);
  }
  const result = {};
  for (const [hr, msArr] of Object.entries(byHour).sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = [...msArr].sort((a, b) => a - b);
    const sum = sorted.reduce((s, v) => s + v, 0);
    result[hr] = {
      count: sorted.length,
      avg_ms: Math.round((sum / sorted.length) * 10) / 10,
      p50_ms: Math.round(pct(sorted, 50)),
      p95_ms: Math.round(pct(sorted, 95)),
      p99_ms: Math.round(pct(sorted, 99) * 10) / 10,
    };
  }
  return result;
}

function calcMinuteStats(minuteCount) {
  const entries = Object.entries(minuteCount).filter(([k]) => k);
  if (!entries.length) return { max: 0, min: 0, avg: 0, total: 0, sorted: [] };
  const counts = entries.map(([, c]) => c);
  return {
    max: Math.max(...counts),
    min: Math.min(...counts),
    avg: Math.round((counts.reduce((s, v) => s + v, 0) / counts.length) * 100) / 100,
    total: counts.length,
    sorted: [...entries].sort((a, b) => b[1] - a[1]),
  };
}

// variantConfig 為 null 時（combined 模式）不做任何 UA 排除
function calcPeakMinuteUA(minuteCount, records, variantConfig) {
  const entries = Object.entries(minuteCount).filter(([k]) => k);
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  const [peakMin, peakCount] = entries[0];
  const tied = entries.filter(([, c]) => c === peakCount).map(([m]) => m);
  const uaInPeak = {};
  records
    .filter((r) => {
      if (minuteLabel(r.date) !== peakMin) return false;
      if (variantConfig?.excludeUserAgents?.includes(r.userAgent)) return false;
      return true;
    })
    .forEach((r) => {
      const ua = r.userAgent || 'Unknown';
      uaInPeak[ua] = (uaInPeak[ua] || 0) + 1;
    });
  const uaRanking = Object.entries(uaInPeak).map(([ua, count]) => {
    const { browser, os } = parseUA(ua);
    return { ua, count, pct: Math.round((count / peakCount) * 10000) / 100, browser, os };
  }).sort((a, b) => b.count - a.count);
  const bd = {}, od = {};
  uaRanking.forEach(({ ua, count }) => {
    const { browser, os } = parseUA(ua);
    bd[browser] = (bd[browser] || 0) + count;
    od[os] = (od[os] || 0) + count;
  });
  return {
    peakMin,
    peakCount,
    tiedCount: tied.length,
    uniqueUA: uaRanking.length,
    uaRanking: uaRanking.slice(0, 20),
    browserDist: Object.entries(bd).sort((a, b) => b[1] - a[1]).map(([browser, count]) => ({ browser, count, pct: Math.round((count / peakCount) * 10000) / 100 })),
    osDist: Object.entries(od).sort((a, b) => b[1] - a[1]).map(([os, count]) => ({ os, count, pct: Math.round((count / peakCount) * 10000) / 100 })),
  };
}

function calcHighFreq(uaMinutely, uaSecondly) {
  const minVio = [], secVio = [];
  const violatingUA = new Set();

  Object.entries(uaMinutely).forEach(([min, uas]) => {
    Object.entries(uas).forEach(([ua, count]) => {
      if (count > 20) { minVio.push({ min, ua, count }); violatingUA.add(ua); }
    });
  });
  Object.entries(uaSecondly).forEach(([sec, uas]) => {
    Object.entries(uas).forEach(([ua, count]) => {
      if (count > 5) { secVio.push({ sec, ua, count }); violatingUA.add(ua); }
    });
  });

  const aggMin = {}, aggSec = {};
  minVio.forEach(({ ua, count }) => {
    if (!aggMin[ua]) aggMin[ua] = { ua, total: 0, maxCount: 0 };
    aggMin[ua].total += count;
    aggMin[ua].maxCount = Math.max(aggMin[ua].maxCount, count);
  });
  secVio.forEach(({ ua, count }) => {
    if (!aggSec[ua]) aggSec[ua] = { ua, total: 0, maxCount: 0 };
    aggSec[ua].total += count;
    aggSec[ua].maxCount = Math.max(aggSec[ua].maxCount, count);
  });

  return {
    minuteTop10: Object.values(aggMin).sort((a, b) => b.total - a.total).slice(0, 10),
    secondTop10: Object.values(aggSec).sort((a, b) => b.total - a.total).slice(0, 10),
    totalMinVio: minVio.length,
    totalSecVio: secVio.length,
    uniqueViolatingUA: violatingUA.size,
  };
}

function calcUAStats(uaCount, uaHourly, renderItems) {
  const rtByUA = {};
  renderItems.forEach(({ ua, ms }) => {
    if (!rtByUA[ua]) rtByUA[ua] = [];
    rtByUA[ua].push(ms);
  });
  const total = Object.values(uaCount).reduce((s, v) => s + v, 0);
  const ranking = Object.entries(uaCount).map(([ua, count]) => {
    const { browser, os } = parseUA(ua);
    const rts = rtByUA[ua] || [];
    const avgMs = rts.length ? Math.round((rts.reduce((s, v) => s + v, 0) / rts.length) * 100) / 100 : null;
    return { ua, count, pct: Math.round((count / total) * 10000) / 100, browser, os, avgMs };
  }).sort((a, b) => b.count - a.count);
  const bd = {}, od = {};
  ranking.forEach(({ browser, os, count }) => {
    bd[browser] = (bd[browser] || 0) + count;
    od[os] = (od[os] || 0) + count;
  });
  const hourlyTop = {};
  Object.entries(uaHourly).forEach(([hr, uas]) => {
    const sorted = Object.entries(uas).sort((a, b) => b[1] - a[1]);
    hourlyTop[hr] = {
      top: sorted[0] ? { ua: sorted[0][0], count: sorted[0][1] } : null,
      total: sorted.reduce((s, [, c]) => s + c, 0),
      unique: sorted.length,
    };
  });
  return {
    total,
    unique: ranking.length,
    ranking: ranking.slice(0, 10),
    browsers: Object.entries(bd).sort((a, b) => b[1] - a[1]).map(([browser, count]) => ({ browser, count, pct: Math.round((count / total) * 10000) / 100 })),
    oses: Object.entries(od).sort((a, b) => b[1] - a[1]).map(([os, count]) => ({ os, count, pct: Math.round((count / total) * 10000) / 100 })),
    hourlyTop,
  };
}

function calcUrlStats(urlCount, renderItems, toTW) {
  const total = Object.values(urlCount).reduce((s, v) => s + v, 0);
  const unique = Object.keys(urlCount).length;
  const top10 = Object.entries(urlCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([url, count]) => ({ url, count, pct: Math.round((count / total) * 10000) / 100 }));
  const top15slow = [...renderItems]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 15)
    .map((r) => ({ ms: r.ms, url: r.url || '(無URL)', ua: r.ua, tw: toTW(r.date) }));
  return { total, unique, top10, top15slow };
}

function calcSlowHM(slowItems) {
  const hmCount = {};
  slowItems.forEach(({ hm }) => { if (hm) hmCount[hm] = (hmCount[hm] || 0) + 1; });
  const all = Object.entries(hmCount).sort((a, b) => a[0].localeCompare(b[0])).map(([time, count]) => ({ time, count }));
  const maxC = all.length ? Math.max(...all.map((i) => i.count)) : 0;
  return {
    all,
    duplicates: [...all].filter((i) => i.count > 1).sort((a, b) => b.count - a.count),
    mostFrequent: all.filter((i) => i.count === maxC),
    total: slowItems.length,
  };
}

module.exports = {
  parseDurationMs,
  extractReqId,
  readCSV,
  buildAggregates,
  calcRenderStats,
  calcHourlyRenderStats,
  calcMinuteStats,
  calcPeakMinuteUA,
  calcHighFreq,
  calcUAStats,
  calcUrlStats,
  calcSlowHM,
};
