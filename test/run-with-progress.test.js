'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runWithProgress, LOG_DIR } = require('../bin/daily-pipeline');

function cleanupLogs() {
  if (!fs.existsSync(LOG_DIR)) return;
  for (const f of fs.readdirSync(LOG_DIR)) {
    if (f.startsWith('TEST-')) fs.unlinkSync(path.join(LOG_DIR, f));
  }
}

function runWithProgressInline(scriptBody, label, onLine) {
  const tmpFile = path.join(os.tmpdir(), `rwp-inline-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(tmpFile, scriptBody);
  const relPath = path.relative(path.join(__dirname, '..', 'bin'), tmpFile);
  return runWithProgress(relPath, [], onLine || null, label).finally(() => {
    fs.unlinkSync(tmpFile);
  });
}

function findLatestLog(labelPrefix) {
  const files = fs.readdirSync(LOG_DIR).filter((f) => f.startsWith(`${labelPrefix}-`));
  assert.ok(files.length > 0, `找不到 ${labelPrefix} 的 log 檔`);
  files.sort((a, b) => fs.statSync(path.join(LOG_DIR, b)).mtimeMs - fs.statSync(path.join(LOG_DIR, a)).mtimeMs);
  return path.join(LOG_DIR, files[0]);
}

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 20 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test('runWithProgress：子程序正常結束 → resolve，且原始輸出完整落地到 log 檔', async () => {
  cleanupLogs();
  await runWithProgressInline("console.log('hello from child')", 'TEST-ok');
  const content = fs.readFileSync(findLatestLog('TEST-ok'), 'utf8');
  assert.match(content, /hello from child/);
});

// 重現 8/2 那次故障的真正機制：子程序在 console.error 後「立即呼叫
// process.exit()」，stderr 走 pipe 時是非同步寫入，Node 不保證資料在
// process.exit() 前 flush 完，大量輸出時父程序收到的內容會被截斷——這就是
// 為什麼當時畫面上「完全沒有錯誤訊息」：訊息根本沒送到父程序，不是被進度條蓋掉。
test('fail-then-pass：舊寫法（console.error 後立即 process.exit）會截斷大量 stderr 輸出', async () => {
  cleanupLogs();
  const payload = 'X'.repeat(500_000); // 夠大，確保超過 pipe buffer，逼出截斷
  const buggyScript = `process.stderr.write(${JSON.stringify(payload)}); process.exit(1);`;

  await assert.rejects(runWithProgressInline(buggyScript, 'TEST-buggy'));

  const content = fs.readFileSync(findLatestLog('TEST-buggy'), 'utf8');
  assert.ok(
    content.length < payload.length,
    `舊寫法（立即 process.exit）預期會截斷輸出，但收到完整 ${content.length} bytes，跟 payload 一樣長`,
  );
});

test('fail-then-pass：新寫法（process.exitCode，不強制 exit）大量 stderr 輸出不會被截斷', async () => {
  cleanupLogs();
  const payload = 'Y'.repeat(500_000);
  const fixedScript = `process.stderr.write(${JSON.stringify(payload)}); process.exitCode = 1;`;

  await assert.rejects(
    runWithProgressInline(fixedScript, 'TEST-fixed'),
    (err) => { assert.match(err.message, /exit code=1/); return true; },
  );

  const content = fs.readFileSync(findLatestLog('TEST-fixed'), 'utf8');
  assert.equal(content.length, payload.length, '新寫法：完整 payload 應該一字不漏地留在 log 檔裡');
});

test('runWithProgress：子程序被系統訊號中止 → reject 訊息要標明 signal，而不是含糊的 exit null', async () => {
  cleanupLogs();
  let childPid = null;
  const promise = runWithProgressInline(
    'console.log(process.pid); setTimeout(() => {}, 60000);',
    'TEST-signal',
    (line) => { const n = Number(line.trim()); if (!Number.isNaN(n)) childPid = n; },
  );

  await waitFor(() => childPid !== null);
  process.kill(childPid, 'SIGKILL');

  await assert.rejects(promise, /signal=SIGKILL/);
});
