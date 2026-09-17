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

回傳的 `url` 是原始一次性問卷連結；目前不使用第三方短網址，`shortUrl` 會是空白，`smsText` 固定使用：

```text
為了提供更優質的服務，千山淨水誠摯邀請您，為此次提供的服務給予評分，您的寶貴意見對我們非常重要：https://chansonwater0701-cmd.github.io/?token=........
```

長網址可能超過中文簡訊常見的單則 70 字限制，產生流程會保留網址並提示可能分成多則簡訊。

若要更新已經存在的 `raw/customers.xlsx`，請使用 `update_excel_rebrandly.py`；它只更新 C、D
欄，不重新產生 Token。此功能保留作為舊資料的人工遷移工具，日常流程不會呼叫 Rebrandly。

## 批次檔怎麼用

日常只需要雙擊 [`qianshan_customer_tool.bat`](qianshan_customer_tool.bat)。它會直接執行不縮網址的完整流程：

1. 先同步現有 `customers.xlsx` 的 C、D、J 狀態回 master JSON（檔案不存在時略過）。
2. 重建昨天整天的待處理 `customers.xlsx`；只抓 G 欄昨天 00:00:00～23:59:59，J 欄已有寄送紀錄的歷史資料不匯出，但仍保留在 master JSON。
3. 只對 J 欄空白且 C 欄沒有連結的資料產生新的問卷長網址；C 欄已有連結時沿用原連結。
4. 同步 C、D、J 欄回主資料檔。
5. 重新輸出並統一 D 欄文案。

防重複規則：J 欄「簡訊發送時間」有值時，這位客戶不會再次產生連結或匯出簡訊；
J 欄空白但 C 欄已有連結時，代表連結已核發、等待寄送，不會再產生第二個 token。
因此每次重建看到舊的 C、D 欄是正常的，這些欄位是用來保留同一位客戶的原連結。
如果以前曾經人工寄送，但當時沒有在 J 欄留下紀錄，程式無法安全猜測這些資料是否已寄送；
這種資料會先視為待處理，請確認後補上 J 欄，再重新執行工具。

目前 `send_pending_sms.py` 是人工寄送流程：它會把符合條件的名單加入固定的待寄送檔，
但不會因為單純匯出就填 J 欄。請同事寄送後，在待寄送檔的「已寄送」欄填入 `已寄送`，
再執行一次工具，程式才會回寫 J 欄；同一客戶之後不會再次產生或匯出。程式本身無法
判斷簡訊平台是否真的成功送達；若要由平台回報成功，必須改接三竹等簡訊 API。

執行完成或失敗都會保留視窗，方便查看成功、略過與失敗筆數。

舊版批次檔已移到 `legacy_bat_backup`，保留作為可復原備份；不要再從該資料夾執行。

請先把最新的 [`gas/Code.gs`](gas/Code.gs) 部署為新的 Apps Script Web App 版本；目前不需要設定 Rebrandly API Key。指令碼屬性可設定：

```text
PUBLIC_BASE_URL=https://chansonwater0701-cmd.github.io  （可選；未設定時使用程式內的正式網址）
```

若未來重新啟用短網址，API Key 不要寫進 Excel、`.bat`、GitHub 或傳到聊天訊息中。

## 單次填寫保護怎麼做到的

跟 MSSQL 版邏輯一致，只是換成 Sheet 實作：

- 每個連結只帶隨機 token，Sheet 裡存的是 token 的 SHA-256 雜湊，不存明碼
- 送出問卷時，Apps Script 用 `LockService` 鎖住，檢查該 token 是否已經有 `UsedAt`；沒有才允許寫入並蓋上時間戳記；已經有的話回傳「已完成」錯誤，拒絕重複寫入
- 前端另外用 `localStorage` 做一層使用體驗優化（送出後同一瀏覽器不會再顯示表單），但真正防止重複填寫的是 Sheet 端的判斷，不是前端

## 已知限制

- Apps Script Web App 的免費配額：每個 Google 帳號每天可執行的次數與時間有限制（一般小量問卷使用不太會碰到，量大再評估升級 Google Workspace 或改回正式後端）
- 每次送出問卷都要讀整張 `Invitations` 表找 token，資料量大（幾千筆以上）後查詢會變慢，屆時建議搬回正式資料庫（例如原本規劃的 MSSQL 方案）
