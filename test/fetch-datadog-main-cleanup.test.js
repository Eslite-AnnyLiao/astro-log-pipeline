'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// main() 會直接 require PAGE_KINDS 讀真實的 page-kinds 設定（product/category 好幾個 subQuery +
// 404 aggregate/windowed），端對端測試若照真實設定 mock 太重。改用假的單一 kind 換掉 require cache
// ——node --test 預設每個測試檔案跑在獨立 process，這個替換不會外溢到其他測試檔案。
const pageKindsPath = require.resolve('../src/config/page-kinds');
const FAKE_KIND_KEY = 'testkind';
const FAKE_PAGE_KINDS = {
  [FAKE_KIND_KEY]: {
    label: 'Test Kind',
    datadog: {
      subQueries: [
        {
          variant: 'testkind-a',
          queryTemplate: (w) => `service:${w}`,
          header: 'id,val',
          mapRow: (log) => [log.id, log.val],
          outputDirName: 'TEST-main-cleanup/a',
          filePattern: (d) => `a-${d}.csv`,
        },
      ],
      // 沒有 aggregate，直接走 fetchWindowed404ToFile（跟 config/page-kinds.js 的 category 一樣的形狀），
      // 不用額外 mock aggregate endpoint。
      error404: {
        queryTemplate: (w) => `service:${w} status:error`,
        extractKey: () => null,
        keyLabel: 'Key',
        outputDirName: 'TEST-main-cleanup/404',
        filePattern: (d) => `404-${d}.csv`,
      },
    },
  },
};
require.cache[pageKindsPath] = { id: pageKindsPath, filename: pageKindsPath, loaded: true, exports: FAKE_PAGE_KINDS };

const http = require('../src/lib/http');
const { main } = require('../src/datadog/fetch-datadog');

const DATE_DIGITS = '20260101';

function emptySearchRes() {
  return {
    status: 200,
    headers: { 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': '10' },
    body: JSON.stringify({ data: [], meta: {} }),
  };
}

const rootDir = path.join(process.cwd(), 'to-analyze-daily-data', 'TEST-main-cleanup');
const subOutPath = path.join(rootDir, 'a', `a-${DATE_DIGITS}.csv`);
const subCheckpointPath = `${subOutPath}.tmp.checkpoint.json`;
const errOutPath = path.join(rootDir, '404', `404-${DATE_DIGITS}.csv`);
const errCheckpointPath = `${errOutPath}.checkpoint.json`;

function withArgv(argv, fn) {
  const original = process.argv;
  process.argv = argv;
  return fn().finally(() => { process.argv = original; });
}

test('main()：這次要下載的東西全部成功後，checkpoint 檔會被清掉，正式輸出檔仍然保留', async (t) => {
  fs.rmSync(rootDir, { recursive: true, force: true });
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  t.mock.method(http, 'httpsRequest', async () => emptySearchRes());

  await withArgv(
    ['node', 'datadog-log-fetcher.js', '--date', DATE_DIGITS, '--type', FAKE_KIND_KEY, '--api-key', 'k', '--app-key', 'a'],
    () => main(),
  );

  assert.ok(fs.existsSync(subOutPath), 'subQuery 正式輸出檔應該存在');
  assert.equal(fs.existsSync(subCheckpointPath), false, '全部成功後，subQuery 的 checkpoint 應該被清掉');
  assert.ok(fs.existsSync(errOutPath), '404 正式輸出檔應該存在');
  assert.equal(fs.existsSync(errCheckpointPath), false, '全部成功後，404 windowed 的 checkpoint 應該被清掉');
});

test('main()：其中一步中途失敗時，已經成功的 subQuery 的 checkpoint 不會被清掉（留給下次重跑用）', async (t) => {
  fs.rmSync(rootDir, { recursive: true, force: true });
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  t.mock.method(http, 'httpsRequest', async (_method, _url, _headers, body) => {
    const parsed = JSON.parse(body);
    // 400 不會觸發 client.js 內建的任何重試（網路層錯誤才會無限重試，見另一個修法），會立刻拋錯，
    // 用來模擬「404 windowed 下載中途失敗」而不必等待重試。
    if (parsed.filter.query.includes('status:error')) {
      return { status: 400, headers: {}, body: '模擬 404 windowed 下載失敗' };
    }
    return emptySearchRes();
  });

  await assert.rejects(
    withArgv(
      ['node', 'datadog-log-fetcher.js', '--date', DATE_DIGITS, '--type', FAKE_KIND_KEY, '--api-key', 'k', '--app-key', 'a'],
      () => main(),
    ),
    /HTTP 400/,
  );

  assert.ok(fs.existsSync(subOutPath), 'subQuery 正式輸出檔應該已經寫出來');
  assert.equal(fs.existsSync(subCheckpointPath), true, '整批還沒全部成功，subQuery 的 checkpoint 不該被清掉，否則之後重跑會失去「已完成」的紀錄');
  assert.equal(fs.existsSync(errOutPath), false, '404 windowed 失敗，不該有正式輸出檔');
});
