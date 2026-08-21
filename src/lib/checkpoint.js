'use strict';

const fs = require('fs');

// 通用 checkpoint 讀寫，供 Datadog 明細分頁、Cloudflare slot、404 aggregate 時間窗共用。
// expected 帶哪些欄位就比對哪些欄位，全部跟 checkpoint 裡存的完全一致才信任、回傳整包內容；
// 只要任一欄位不同（換了日期/查詢條件/variant 等）就視為無效，回傳 null 讓呼叫端走全新開始。
// 續傳用的數值欄位（如 bytesWritten）是否有效由呼叫端自行判斷：跟 undefined 做 >= 比較天生是
// false，NaN 語意上安全，所以這裡不需要重複做型別檢查。
function loadCheckpoint(checkpointPath, expected) {
  if (!fs.existsSync(checkpointPath)) return null;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  } catch {
    return null; // 檔案損毀（例如寫到一半當機），視同沒有 checkpoint
  }

  if (raw == null || typeof raw !== 'object') return null;
  const matches = Object.keys(expected).every((k) => raw[k] === expected[k]);
  if (!matches) return null;

  return raw;
}

function saveCheckpoint(checkpointPath, data) {
  fs.writeFileSync(checkpointPath, JSON.stringify(data), 'utf8');
}

function clearCheckpoint(checkpointPath) {
  fs.rmSync(checkpointPath, { force: true });
}

module.exports = { loadCheckpoint, saveCheckpoint, clearCheckpoint };
