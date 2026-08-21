#!/usr/bin/env bash
# 偵測 datadog-log-fetcher.js 是否卡住（log 太久沒更新），
# 若卡住就 kill 掉，讓 daily-pipeline.js 的內建重試機制自動重新 spawn、
# 從 checkpoint 續傳。安全前提：checkpoint 是每頁同步寫檔存的（見
# astro-log-pipeline/src/datadog/fetch-datadog.js），kill 不會遺失進度。
set -euo pipefail

PIPELINE_DIR="/Users/liaoliting/Webserver/astro-log-pipeline"
LOG_DIR="$PIPELINE_DIR/logs"
STALL_THRESHOLD_SEC=120   # log 超過這麼久沒更新就視為卡住
WAIT_FOR_RESPAWN_SEC=15   # kill 後等待自動重試 spawn 新行程的時間

echo "🔍 檢查 datadog-log-fetcher.js 是否卡住..."

DD_PID=$(pgrep -f "datadog-log-fetcher.js" | head -1 || true)

if [[ -z "$DD_PID" ]]; then
  echo "⚠️  目前沒有 datadog-log-fetcher.js 在跑。"
  echo "   如果整條流程已經停掉，請自行到 seo-agent 目錄執行：pnpm daily"
  exit 0
fi

LATEST_LOG=$(ls -t "$LOG_DIR"/DD-*.log 2>/dev/null | head -1 || true)
if [[ -z "$LATEST_LOG" ]]; then
  echo "❌ 找不到 DD log 檔，無法判斷進度（PID=$DD_PID 仍在跑，請手動檢查）"
  exit 1
fi

LAST_MOD=$(stat -f "%m" "$LATEST_LOG")
NOW=$(date +%s)
GAP=$((NOW - LAST_MOD))

echo "   PID=$DD_PID"
echo "   log=$LATEST_LOG"
echo "   最後寫入距今 ${GAP} 秒，目前進度："
tail -2 "$LATEST_LOG"
echo

if (( GAP < STALL_THRESHOLD_SEC )); then
  echo "✅ 還在正常下載中（${GAP}s < 門檻 ${STALL_THRESHOLD_SEC}s），不處理。"
  exit 0
fi

echo "🛑 判定卡住（超過 ${STALL_THRESHOLD_SEC}s 無新輸出），送出 kill $DD_PID ..."
kill "$DD_PID"

for _ in $(seq 1 "$WAIT_FOR_RESPAWN_SEC"); do
  sleep 1
  kill -0 "$DD_PID" 2>/dev/null || break
done

echo "⏳ 等待 daily-pipeline.js 自動重試、重新 spawn 新行程（最多 ${WAIT_FOR_RESPAWN_SEC}s）..."
NEW_PID=""
for _ in $(seq 1 "$WAIT_FOR_RESPAWN_SEC"); do
  NEW_PID=$(pgrep -f "datadog-log-fetcher.js" | head -1 || true)
  [[ -n "$NEW_PID" ]] && break
  sleep 1
done

if [[ -z "$NEW_PID" ]]; then
  echo "❌ ${WAIT_FOR_RESPAWN_SEC}s 內沒偵測到新行程，可能已重試 3 次後放棄。"
  echo "   請手動到 seo-agent 目錄重新執行：pnpm daily"
  exit 1
fi

NEW_LOG=$(ls -t "$LOG_DIR"/DD-*.log 2>/dev/null | head -1)
echo "✅ 新行程 PID=$NEW_PID 已啟動，log=$NEW_LOG"
sleep 3

if grep -q "偵測到中斷的下載進度" "$NEW_LOG" 2>/dev/null; then
  echo "✅ 確認從 checkpoint 續傳："
  grep "偵測到中斷的下載進度" "$NEW_LOG"
else
  echo "ℹ️  尚未看到續傳訊息，可自行用以下指令持續觀察："
  echo "   tail -f $NEW_LOG"
fi
