'use strict';

const fs = require('fs');

// 只有 query/fromISO/toISO/variant 跟本次執行完全一致，才信任舊 checkpoint 的 cursor；
// 只要程式改了 query 或換了日期/variant，就視為無效，避免拿錯的 cursor 續接出錯的資料。
function loadCheckpoint(checkpointPath, expected) {
  if (!fs.existsSync(checkpointPath)) return null;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  } catch {
    return null; // 檔案損毀（例如寫到一半當機），視同沒有 checkpoint
  }

  const matches = ['query', 'fromISO', 'toISO', 'variant'].every((k) => raw[k] === expected[k]);
  if (!matches) return null;
  if (typeof raw.bytesWritten !== 'number' || typeof raw.total !== 'number') return null;

  return raw;
}

function saveCheckpoint(checkpointPath, data) {
  fs.writeFileSync(checkpointPath, JSON.stringify(data), 'utf8');
}

function clearCheckpoint(checkpointPath) {
  fs.rmSync(checkpointPath, { force: true });
}

module.exports = { loadCheckpoint, saveCheckpoint, clearCheckpoint };
