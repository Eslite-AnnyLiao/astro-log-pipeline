'use strict';

const { toTW } = require('../lib/time');
const { calcHourlyRenderStats } = require('./aggregate');

function buildJsonOutput(variantConfig, inputFile, records, agg, computed) {
  const { renderStats, minStats, peakUA, slowHM, hf, uaStats, urlStats } = computed;
  const { minuteCount, hourCount, slowItems } = agg;
  const hasRenderTimeline = variantConfig.hasRenderTimeline;

  const avgPerHour = Object.keys(hourCount).length
    ? Math.round((Object.values(hourCount).reduce((s, v) => s + v, 0) / Object.keys(hourCount).length) * 100) / 100
    : 0;

  return {
    analysis_time: new Date().toISOString(),
    timezone_info: '所有時間已轉換為台灣時區 (UTC+8)',
    analysis_mode: variantConfig.analysisModeLabel,

    file_info: { input_file: inputFile },

    data_source_stats: {
      total_records: records.length,
      valid_duration_records: agg.renderItems.length,
    },

    render_time_stats: renderStats ? {
      average_ms: renderStats.avg,
      min_ms: renderStats.min,
      max_ms: renderStats.max,
      median_p50_ms: renderStats.p50,
      p90_ms: renderStats.p90,
      p95_ms: renderStats.p95,
      p98_ms: renderStats.p98,
      p99_ms: renderStats.p99,
      count_above_3000to5000ms: renderStats.slow3to5,
      count_above_5000ms: renderStats.slowOver5,
      total_records: renderStats.count,
    } : null,

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
      browser_distribution: peakUA.browserDist.map((r) => ({
        browser: r.browser, count: r.count, percentage: r.pct,
      })),
      os_distribution: peakUA.osDist.map((r) => ({
        os: r.os, count: r.count, percentage: r.pct,
      })),
    } : null,

    high_frequency_analysis: {
      minute_top10: hf.minuteTop10.map((r) => ({ user_agent: r.ua, total: r.total, max_per_minute: r.maxCount })),
      second_top10: hf.secondTop10.map((r) => ({ user_agent: r.ua, total: r.total, max_per_second: r.maxCount })),
      total_minute_violations: hf.totalMinVio,
      total_second_violations: hf.totalSecVio,
      unique_violating_user_agents: hf.uniqueViolatingUA,
    },

    slow_render_hour_minute_stats: hasRenderTimeline ? {
      summary: {
        total_unique_hour_minutes: slowHM.all.length,
        total_records: slowHM.total,
        most_frequent_times: slowHM.mostFrequent,
        max_frequency: slowHM.mostFrequent.length ? slowHM.mostFrequent[0].count : 0,
        duplicate_count: slowHM.duplicates.length,
      },
      all_hour_minute_stats: slowHM.all,
      duplicate_hour_minute_stats: slowHM.duplicates,
    } : undefined,

    url_analysis: {
      overall_stats: { total_visits: urlStats.total, unique_urls: urlStats.unique },
      duplicate_url_details_top_10: urlStats.top10.map((r) => ({
        url: r.url, count: r.count, percentage: r.pct,
      })),
      top_15_render_times: urlStats.top15slow.map((r) => ({
        renderTime: r.ms, url: r.url, timestamp: r.tw, userAgent: r.ua,
      })),
    },

    user_agent_analysis: {
      overall_stats: {
        total_requests: uaStats.total,
        unique_user_agents: uaStats.unique,
      },
      user_agent_ranking: uaStats.ranking.map((r) => ({
        userAgent: r.ua, count: r.count, browser: r.browser, os: r.os,
        percentage: r.pct, avgRenderTime: r.avgMs,
      })),
      browser_stats: uaStats.browsers.map((r) => ({
        browser: r.browser, count: r.count, percentage: r.pct,
      })),
      os_stats: uaStats.oses.map((r) => ({
        os: r.os, count: r.count, percentage: r.pct,
      })),
      hourly_top_user_agents: uaStats.hourlyTop,
    },

    hourly_request_data: hourCount,

    minutely_request_data: minuteCount,

    hourly_render_time_stats: hasRenderTimeline ? calcHourlyRenderStats(agg.renderItems) : undefined,

    slow_render_periods: hasRenderTimeline
      ? slowItems.map((r) => ({
        timestamp_taiwan: toTW(r.date),
        render_time_ms: r.ms,
        url: r.url || null,
        user_agent: r.ua,
      }))
      : undefined,

    chart_data: Object.entries(hourCount)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([hour, count]) => ({ hour, count })),

    ...(variantConfig.extraBreakdown ? {
      [variantConfig.extraBreakdown.jsonKey]: Object.entries(agg[variantConfig.extraBreakdown.aggKey] || {})
        .sort((a, b) => b[1] - a[1]).slice(0, 50)
        .map(([key, count]) => ({ [variantConfig.extraBreakdown.entryKeyName]: key, count })),
    } : {}),
  };
}

module.exports = { buildJsonOutput };
