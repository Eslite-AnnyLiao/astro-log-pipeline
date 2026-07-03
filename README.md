# astro-log-pipeline

Eslite Astro 商品頁 / 分類頁 log 下載與分析工具。從 analysis-log 拆分出來的獨立專案，架構改為
「一個 registry 設定檔驅動所有邏輯」，未來要加新頁面類型（例如文章頁）只需要改設定檔，不用改邏輯本體。

## 環境設置

```bash
npm install
cp .env.example .env   # 填入 Cloudflare 與 Datadog 的金鑰
```

`.env` 格式：

```
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
DATADOG_API_KEY=...
DATADOG_APP_KEY=...
```

## 日常使用

```bash
# 完整流程（下載 + 分析）
node bin/daily-pipeline.js --date 20260521

# 只跑分析，跳過下載
node bin/daily-pipeline.js --date 20260521 --analyze-only

# 只將既有的 CF JSON / 404 CSV merge 進既有的 combined JSON
node bin/daily-pipeline.js --date 20260521 --merge-cf-only

# 指定環境（預設 prod）
node bin/daily-pipeline.js --date 20260521 --env stg
```

### 執行流程

```
Step 1  bin/cloudflare-log-fetcher.js  ┐
        bin/datadog-log-fetcher.js     ┘ 同時下載

Step 2  bin/datadog-export-analyzer.js   產出各頁面類型 + combined 報告

Step 3  將 CF cache hit 數據寫入 combined JSON

Step 4  將 404 統計寫入 combined JSON
```

輸出目錄（不存在時自動建立）：

```
to-analyze-daily-data/
├── ssr/                    # 商品頁 SSR log CSV
├── ssg/                    # 商品頁 SSG log CSV
├── 404-errors/              # 商品頁 404 錯誤 CSV
├── category/                # 分類頁 log CSV
└── category-404-errors/     # 分類頁 404 錯誤 CSV

daily-analysis-result/
├── cloudflare/
│   ├── product/              # 商品頁 cache-hit 統計（日期在檔名裡）
│   └── category/             # 分類頁 cache-hit 統計
└── datadog-export/
    ├── ssr/
    ├── ssg/
    ├── category/
    └── combined/
```

`daily-analysis-result/` 底下統一「類型資料夾在外層、日期在檔名裡」，跟 `to-analyze-daily-data/`
一致；`--output` 明確指定時會直接沿用指定路徑，不會再依頁面類型分子資料夾。

### 單獨執行子工具

```bash
# 下載
node bin/cloudflare-log-fetcher.js --date 20260521
node bin/datadog-log-fetcher.js --date 20260521

# 分析（全部或單一 variant）
node bin/datadog-export-analyzer.js --type all --date 20260521
node bin/datadog-export-analyzer.js --type product-ssg --date 20260521
node bin/datadog-export-analyzer.js --type product-ssr --date 20260521
node bin/datadog-export-analyzer.js --type category-ssr --date 20260521
node bin/datadog-export-analyzer.js --type combined --date 20260521
```

`--type`/`--date` 都支援只查詢/分析單一頁面類型，例如 `--type category`（fetcher）只下載/查詢分類頁。

## 架構：如何加一個新頁面類型

整個 pipeline 由兩個 registry 設定檔驅動，**加新頁面類型只需要改這兩個檔案**：

- **`src/config/page-kinds.js`**：驅動 `bin/cloudflare-log-fetcher.js` 與 `bin/datadog-log-fetcher.js`。
  定義每種頁面的 URL path prefix、Datadog 查詢語法、CSV 欄位、輸出檔名。
- **`src/config/variants.js`**：驅動 `bin/datadog-export-analyzer.js`。
  定義每個分析 variant（例如 product-ssr、category-ssr）的報表標題、要不要顯示 Render Time
  區塊（`hasRenderTimeline`）、結尾的細項表格（`extraBreakdown`）、combined 模式的合併順序
  （`COMBINED_ORDER`）。

兩個檔案裡都有註解掉的「未來加文章頁」範例，照著形狀複製一份、取消註解即可，不需要碰
`src/cloudflare/*.js`、`src/datadog/*.js`、`src/analyzer/*.js` 的邏輯本體。

## 目錄結構

```
bin/                          # CLI 入口（thin wrapper）
src/
├── config/
│   ├── page-kinds.js         # 頁面類型 registry（下載端）
│   └── variants.js           # 分析 variant registry（分析端）
├── lib/                      # 通用工具（時間、HTTP、CSV、UA 解析）
├── cloudflare/                # Cloudflare Observability API client + fetcher
├── datadog/                   # Datadog Logs Search API client + CSV mapper + fetcher
└── analyzer/                  # CSV 讀取、統計、報表產生、combined 合併
```
