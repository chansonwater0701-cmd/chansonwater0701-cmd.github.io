# 千山淨水｜服務滿意度問卷（GitHub Pages + Google Apps Script 版）

純靜態前端（可放 GitHub Pages），資料儲存在你自己的 Google Sheet，透過 Google Apps Script 當中介 API。不需要任何主機、不會碰到公司內網防火牆問題。

## 架構

- `index.html` / `styles.css` / `app.js`：問卷畫面（跟 MSSQL 版視覺與文案一致）
- `config.js`：填入 Apps Script Web App 網址的地方（部署後才會拿到）
- `gas/Code.gs`：貼到 Google Sheet 的 Apps Script 編輯器裡的後端程式碼

## 第一步：部署 Google Apps Script（資料庫 + API）

1. 打開你的 Google Sheet：<https://docs.google.com/spreadsheets/d/1e5A1Bz91Z7m-JwCN-bzIgC3jz6BBXTTA-69X6eXYJRI/edit>
2. 上方選單「擴充功能」→「Apps Script」
3. 把編輯器裡的範例程式碼刪掉，貼上 [`gas/Code.gs`](gas/Code.gs) 的內容
4. 左側齒輪圖示「專案設定」→ 捲到最下面「指令碼屬性」→ 新增屬性：
   - 屬性：`SURVEY_ADMIN_SECRET`
   - 值：自己設一組密碼字串（之後建立問卷連結時要用，不要外流）
5. 右上角「部署」→「新增部署作業」→ 齒輪選「網頁應用程式」：
   - 執行身分：**我**
   - 具有存取權的使用者：**所有人**
   - 按下「部署」
6. 第一次部署會跳出 Google 帳號授權畫面 —— 這是你自己在授權你自己的程式碼存取你自己的 Sheet，不涉及任何第三方，正常點「允許」即可
7. 複製拿到的網址（結尾是 `/exec`），這是你的 API 網址

部署後，Sheet 裡會自動多兩個工作表：`Invitations`（一次性連結核發紀錄）、`Responses`（問卷結果）。

## 第二步：設定前端

打開 [`config.js`](config.js)，把網址貼進去：

```js
window.SURVEY_API_URL = "https://script.google.com/macros/s/xxxxxxxx/exec";
```

## 第三步：放到 GitHub Pages

1. 建一個新的 GitHub repo，把這個資料夾（`index.html`、`styles.css`、`app.js`、`config.js`）推上去
2. repo 的 Settings → Pages → Source 選「Deploy from a branch」，Branch 選 `main` / `/(root)`
3. 存檔後幾分鐘會拿到網址，通常是 `https://<你的帳號>.github.io/<repo名稱>/`

## 第四步：產生一次性問卷連結（發簡訊用）

目前沒有另外做管理介面，用 `curl` 或 Postman 打 API 即可（把 `API_URL` 換成你的 Apps Script 網址，`BASE_URL` 換成你的 GitHub Pages 網址）：

```bash
curl -X POST "API_URL" \
  -H "content-type: text/plain;charset=utf-8" \
  -d '{
    "action": "createInvitation",
    "adminSecret": "你在步驟4設定的密碼",
    "customerCode": "C-001",
    "phone": "0912345678",
    "baseUrl": "https://<你的帳號>.github.io/<repo名稱>"
  }'
```

回傳的 `url` 就是可以放進簡訊的一次性問卷連結，`smsText` 是現成的簡訊文字。

## 單次填寫保護怎麼做到的

跟 MSSQL 版邏輯一致，只是換成 Sheet 實作：

- 每個連結只帶隨機 token，Sheet 裡存的是 token 的 SHA-256 雜湊，不存明碼
- 送出問卷時，Apps Script 用 `LockService` 鎖住，檢查該 token 是否已經有 `UsedAt`；沒有才允許寫入並蓋上時間戳記；已經有的話回傳「已完成」錯誤，拒絕重複寫入
- 前端另外用 `localStorage` 做一層使用體驗優化（送出後同一瀏覽器不會再顯示表單），但真正防止重複填寫的是 Sheet 端的判斷，不是前端

## 已知限制

- Apps Script Web App 的免費配額：每個 Google 帳號每天可執行的次數與時間有限制（一般小量問卷使用不太會碰到，量大再評估升級 Google Workspace 或改回正式後端）
- 每次送出問卷都要讀整張 `Invitations` 表找 token，資料量大（幾千筆以上）後查詢會變慢，屆時建議搬回正式資料庫（例如原本規劃的 MSSQL 方案）
