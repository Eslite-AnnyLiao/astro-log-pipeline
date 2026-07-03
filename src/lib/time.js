'use strict';

// 將 20260508 或 2026-05-08 統一轉為 8 碼純數字 YYYYMMDD
function normalizeDate(dateStr) {
  const clean = dateStr.replace(/\D/g, '');
  return clean.length === 8 ? clean : null;
}

function toTW(utcStr) {
  const d = new Date(String(utcStr).replace(/'/g, ''));
  if (isNaN(d.getTime())) return null;
  const tw = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${tw.getUTCFullYear()}-${p(tw.getUTCMonth() + 1)}-${p(tw.getUTCDate())} ${p(tw.getUTCHours())}:${p(tw.getUTCMinutes())}:${p(tw.getUTCSeconds())}.${p(tw.getUTCMilliseconds(), 3)}`;
}

function hourLabel(utcStr) {
  const d = new Date(String(utcStr).replace(/'/g, ''));
  if (isNaN(d.getTime())) return null;
  const tw = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${tw.getUTCFullYear()}-${p(tw.getUTCMonth() + 1)}-${p(tw.getUTCDate())} ${p(tw.getUTCHours())}:00`;
}

function minuteLabel(utcStr) {
  const d = new Date(String(utcStr).replace(/'/g, ''));
  if (isNaN(d.getTime())) return null;
  const tw = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${tw.getUTCFullYear()}-${p(tw.getUTCMonth() + 1)}-${p(tw.getUTCDate())} ${p(tw.getUTCHours())}:${p(tw.getUTCMinutes())}`;
}

function hmLabel(utcStr) {
  const d = new Date(String(utcStr).replace(/'/g, ''));
  if (isNaN(d.getTime())) return null;
  const tw = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${p(tw.getUTCHours())}:${p(tw.getUTCMinutes())}`;
}

function secondLabel(utcStr) {
  const d = new Date(String(utcStr).replace(/'/g, ''));
  if (isNaN(d.getTime())) return null;
  const tw = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${tw.getUTCFullYear()}-${p(tw.getUTCMonth() + 1)}-${p(tw.getUTCDate())} ${p(tw.getUTCHours())}:${p(tw.getUTCMinutes())}:${p(tw.getUTCSeconds())}`;
}

// 分析報告用：12 小時制（上午/下午）
function nowTW() {
  return new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: true });
}

// datadog-log-fetcher 查詢範圍：台灣時區當日 00:00:00 ~ 23:59:59 的 ISO 字串
function buildTWRange(dateDigits) {
  const y = dateDigits.slice(0, 4);
  const m = dateDigits.slice(4, 6);
  const d = dateDigits.slice(6, 8);
  return {
    fromISO: `${y}-${m}-${d}T00:00:00+08:00`,
    toISO: `${y}-${m}-${d}T23:59:59+08:00`,
  };
}

// cloudflare-log-fetcher 查詢範圍：台灣時區當日對應的 UTC ms 範圍
function buildUTCRange(dateDigits) {
  const y = parseInt(dateDigits.slice(0, 4), 10);
  const m = parseInt(dateDigits.slice(4, 6), 10) - 1;
  const d = parseInt(dateDigits.slice(6, 8), 10);

  const fromMs = Date.UTC(y, m, d, 0, 0, 0) - 8 * 3600 * 1000;
  const toMs = Date.UTC(y, m, d, 23, 59, 59, 999) - 8 * 3600 * 1000;

  const fmt = (ms) =>
    new Date(ms)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '');
  return { fromMs, toMs, startDisplay: fmt(fromMs), endDisplay: fmt(toMs) };
}

module.exports = {
  normalizeDate,
  toTW,
  hourLabel,
  minuteLabel,
  hmLabel,
  secondLabel,
  nowTW,
  buildTWRange,
  buildUTCRange,
};
