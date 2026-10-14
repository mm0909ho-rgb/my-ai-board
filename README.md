# AI 成果 Dashboard

正式網站：https://my-ai-board.pages.dev/

## 開發與驗證

- 網站功能：`assets/app.js`
- 頁面與既有 runtime：`index.html`
- 介面樣式：`assets/dashboard.css`
- 語法與回歸檢查：`npm run check`
- 靜態建置：`npm run build`

以上指令僅需要 Node.js，不需安裝額外套件。也可直接執行 `node scripts/build.mjs`。

## Cloudflare Pages

GitHub 的 `main` 分支連接 Cloudflare Pages 自動部署，目前部署來源為儲存庫根目錄、無建置指令。必須保留 `index.html` 與 `assets/`，以及既有 `functions/` API。

`dist/` 是純靜態建置輸出，不包含 Cloudflare Functions；GitHub 自動部署繼續使用根目錄以保留既有後端。

## 2026-10-14 更新

- 首頁成果捷徑、專案篩選與手機版樣式。
- 專案詳情返回來源頁面並還原捲動位置。
- 返回按鈕加大並提高對比。
- 圖片預覽新增 100%～400% 縮放、重設及鍵盤操作。

已通過語法及返回／縮放回歸檢查。尚未使用真實帳號完成登入後的瀏覽器操作驗證。
