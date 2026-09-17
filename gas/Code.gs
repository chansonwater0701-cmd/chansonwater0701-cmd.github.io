/**
 * 千山淨水 服務滿意度問卷 - Google Apps Script 後端
 *
 * 部署步驟：
 * 1. 打開你的 Google Sheet -> 上方選單「擴充功能」->「Apps Script」
 * 2. 把編輯器裡原本的範例程式碼全部刪除，貼上這個檔案的內容
 * 3. 左側「專案設定」(齒輪圖示) -> 指令碼屬性 -> 新增屬性：
 *      屬性：SURVEY_ADMIN_SECRET
 *      值：自己設一組密碼（例如一串隨機字串），之後建立問卷連結時要用
 * 4. 右上角「部署」->「新增部署作業」-> 類型選「網頁應用程式」
 *      執行身分：我 (你自己的帳號)
 *      具有存取權的使用者：所有人
 *    按下「部署」，第一次會跳出 Google 授權畫面，這是「你自己」在授權「你自己的指令碼」
 *    存取「你自己的」Google Sheet，不會經過或交給任何第三方。
 * 5. 複製部署後拿到的網址（結尾是 /exec），這就是前端要打的 API 網址。
 *
 * 2026-09-11 改版說明——換新 Google Sheet 收資料，但沒有換部署網址：
 * 老闆要求問卷回覆改收到一份新的 Google Sheet（NEW_SHEET_ID），但這個 exec 網址
 * 已經寫進 config.js 跟 create_invitation.py，而且已經有幾百則簡訊寄出去、客戶
 * 手上的連結都是打這個網址——換一個新的部署網址，那些還沒填的舊連結會全部失效
 * （客戶點進去查不到自己的 token，看到「連結無效」）。所以做法是：部署網址完全
 * 不變（這支程式本身還是綁在原本那份舊 Sheet 上，也就是下面的 getOldSpreadsheet()），
 * 只是程式邏輯改成「新建立的問卷連結、新的填寫結果都寫進新 Sheet（NEW_SHEET_ID）」，
 * 「舊連結」的驗證跟填寫仍然照查舊 Sheet（沒有找到才會退回舊 Sheet 找，見
 * findInvitationRow()）。這樣舊連結完全不受影響，新資料乾淨地分流到新表。
 *
 * 資料會自動建立兩個工作表：
 * - Invitations：一次性問卷連結的核發紀錄（Token雜湊、客戶代號、電話、建立時間、
 *   使用時間、門市、技師、離場日期、離場時間、派工單別、派工單號、派工日期——
 *   後面幾欄是建立連結當下就決定好，客戶填寫時不用再輸入，直接從這裡複製到
 *   Responses；派工單別/單號/日期是 2026-09-11 加的）
 * - Responses：問卷送出結果（派工單別、派工單號、派工日期、門市、技師、客戶代號、
 *   電話、離場、發送日期、回覆日期、服務滿意度、留下原因或建議）
 *
 * 連結有效期限：LINK_EXPIRY_DAYS（預設 7 天）。從 createInvitation 建立的當下起算，
 * 超過這個天數還沒使用的連結，即使 token 本身正確，送出時也會被拒絕（過期不等於用過，
 * 兩者在 Invitations 分頁裡是分開判斷的）。
 */

var LINK_EXPIRY_DAYS = 7;
// 公開網址不是密碼；若忘記設定指令碼屬性，固定使用目前正式 GitHub Pages 網址。
// 若未來更換網站，仍可用指令碼屬性的 PUBLIC_BASE_URL 覆蓋這個預設值。
var DEFAULT_PUBLIC_BASE_URL = "https://chansonwater0701-cmd.github.io";

// 2026-09-11 新問卷回覆表的 Google Sheet ID（從網址
// https://docs.google.com/spreadsheets/d/{這一段}/edit 取出來的那一段）。
var NEW_SHEET_ID = "1gaoPNQHr1sqexKGOPSmKxNeWaWNQZUrCVGuSo2XjOiQ";

function getNewSpreadsheet() {
  return SpreadsheetApp.openById(NEW_SHEET_ID);
}

// 這支程式本身綁定的（就是這個部署網址背後）舊 Sheet，裡面還躺著幾百筆已經寄出去、
// 客戶尚未填寫的舊連結，只用來查詢驗證，不會再有新資料寫進去。
function getOldSpreadsheet() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getPublicBaseUrl() {
  var configured = (PropertiesService.getScriptProperties().getProperty("PUBLIC_BASE_URL") || DEFAULT_PUBLIC_BASE_URL).toString().trim();
  var base = configured.replace(/\/+$/, "");
  // GitHub Pages 的 index.html 入口統一使用根網址，避免 /index 與 / 造成誤判。
  if (base.toLowerCase().endsWith("/index")) base = base.substring(0, base.length - 6);
  return base || DEFAULT_PUBLIC_BASE_URL;
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === "createInvitation") {
      return handleCreateInvitation(body);
    }
    if (body.action === "shortenExisting") {
      return handleShortenExisting(body);
    }
    if (body.action === "shortenerStatus") {
      return handleShortenerStatus(body);
    }
    if (body.action === "submitSurvey") {
      return handleSubmitSurvey(body);
    }
    if (body.action === "updateInvitationMeta") {
      return handleUpdateInvitationMeta(body);
    }
    if (body.action === "cleanupInvitations") {
      return handleCleanupInvitations(body);
    }
    // Production API: debug actions are intentionally disabled.
    return jsonResponse({ error: "未知的操作" });
  } catch (err) {
    return jsonResponse({ error: "伺服器發生錯誤: " + err.message });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  var token = (e.parameter.token || "").toString().trim();
  if (!isValidToken(token)) return jsonResponse({ valid: false });

  var found = findInvitationRow(hashToken(token));
  if (!found || found.row.usedAt || isExpired(found.row.createdAt)) return jsonResponse({ valid: false });
  return jsonResponse({ valid: true });
}

function handleCreateInvitation(body) {
  var expected = PropertiesService.getScriptProperties().getProperty("SURVEY_ADMIN_SECRET");
  if (!expected || body.adminSecret !== expected) {
    return jsonResponse({ error: "未授權" });
  }

  var customerCode = (body.customerCode || "").toString().trim();
  var phone = (body.phone || "").toString().replace(/\D/g, "");
  if (!customerCode || phone.length < 8) {
    return jsonResponse({ error: "請提供客戶代號與有效電話" });
  }

  // 門市/技師/服務日期/服務時間，建立連結的人（賣場系統那邊的批次腳本）在這一刻
  // 就知道這些資訊，直接存起來，客戶端不用填、也不用另外查。都是選填——舊的
  // 呼叫方式（沒帶這幾個欄位）還是可以正常運作，只是 Responses 那幾欄會是空的。
  var store = safeCell(body.store);
  var technician = safeCell(body.technician);
  // serviceDate/serviceTime/dispatchDate 這種「2026/09/03」「14:31」格式的純文字，
  // Sheets 寫入時會自動辨識成日期/時間型別存起來（跟電話號碼開頭的0被吃掉是同一類
  // 問題），之後 Apps Script 用 getValues() 讀回來會變成 JS Date 物件，toString()
  // 出來就是「Thu Sep 03 2026 00:00:00 GMT+0800 (台北標準時間)」這種長長一串——
  // 使用者截圖回報過這個現象。前面加一個 "'" 強制這欄用純文字存，跟 getSheet()
  // 裡設定 setNumberFormat("@") 雙重保險（單獨設定格式不夠可靠，之前修電話號碼
  // 那次已經證實過，兩個一起用才穩）。
  var serviceDate = "'" + safeCell(body.serviceDate);
  var serviceTime = "'" + safeCell(body.serviceTime);
  // 2026-09-11 加上：派工單別/派工單號/派工日期，來源是賣場系統的
  // dbo.DispatchCalendar（跟 CHANSON 是不同資料表），一樣選填。派工單號通常是
  // 純數字，跟電話號碼一樣有被 Sheet 自動吃成數字型別的風險，一併加 "'" 前綴。
  var dispatchType = safeCell(body.dispatchType);
  var dispatchNo = "'" + safeCell(body.dispatchNo);
  var dispatchDate = "'" + safeCell(body.dispatchDate);

  // Token 維持一次性、7 天期限與 Sheet 端 SHA-256 雜湊比對。
  var token = Utilities.getUuid().replace(/-/g, "").substring(0, 16);

  // 公開網址固定由指令碼屬性提供；呼叫端只能帶相同值，避免管理密碼外洩後被
  // 用來建立釣魚網址。
  var propBase = getPublicBaseUrl();
  var bodyBase = body.baseUrl ? body.baseUrl.toString().replace(/\/$/, "") : "";
  if (!propBase || (bodyBase && bodyBase !== propBase)) {
    return jsonResponse({ error: "Invalid base URL" });
  }
  var base = propBase;
  var url = base + "/?token=" + token;
  // 目前不使用第三方短網址；C 欄直接保存一次性長網址，D 欄使用固定文案。
  // 長網址可能超過單則中文簡訊 70 字，仍回傳給寄送流程由業務決定如何處理。
  var smsText = "為了提供更優質的服務，千山淨水誠摯邀請您，為此次提供的服務給予評分，您的寶貴意見對我們非常重要：" + url;

  // 2026-09-11 起：新建立的邀請一律寫進新 Sheet（NEW_SHEET_ID），不再寫進這支
  // 程式綁定的舊 Sheet——見檔案開頭「2026-09-11 改版說明」。
  var sheet = getSheet(getNewSpreadsheet(), "Invitations");
  sheet.appendRow([
    hashToken(token), customerCode, "'" + phone, new Date(), "",
    store, technician, serviceDate, serviceTime,
    dispatchType, dispatchNo, dispatchDate,
  ]);

  return jsonResponse({
    ok: true,
    token: token,
    url: url,
    shortUrl: "",
    smsText: smsText,
    smsLength: smsText.length,
    smsParts: smsText.length > 70 ? 2 : 1,
  });
}

function handleShortenExisting(body) {
  var expected = PropertiesService.getScriptProperties().getProperty("SURVEY_ADMIN_SECRET");
  if (!expected || body.adminSecret !== expected) {
    return jsonResponse({ error: "未授權" });
  }

  var longUrl = (body.url || "").toString().trim();
  var propBase = getPublicBaseUrl();
  if (!propBase || !isAllowedSurveyUrl(longUrl, propBase)) {
    return jsonResponse({ error: "Invalid survey URL" });
  }

  var shortUrl = createShortUrl(longUrl);
  if (!shortUrl) {
    return jsonResponse({ error: "Rebrandly 短網址服務尚未設定或無法使用" });
  }
  var smsText = "為了提供更優質的服務，千山淨水誠摯邀請您，為此次提供的服務給予評分，您的寶貴意見對我們非常重要：" + shortUrl;
  if (smsText.length > 70) {
    return jsonResponse({ error: "短網址仍超過單則簡訊長度" });
  }
  return jsonResponse({ ok: true, shortUrl: shortUrl, smsText: smsText, smsLength: smsText.length });
}

// 批次程式在處理 Excel 前先檢查必要設定，避免設定漏掉時對每一列都重複呼叫
// Rebrandly、留下大量失敗紀錄。只回傳是否可用與網域，不會回傳 API Key。
function handleShortenerStatus(body) {
  var expected = PropertiesService.getScriptProperties().getProperty("SURVEY_ADMIN_SECRET");
  if (!expected || body.adminSecret !== expected) {
    return jsonResponse({ error: "未授權" });
  }

  var properties = PropertiesService.getScriptProperties();
  var base = getPublicBaseUrl();

  var rebrandlyKey = (properties.getProperty("REBRANDLY_API_KEY") || "").trim();
  if (!rebrandlyKey) {
    return jsonResponse({ error: "尚未設定 REBRANDLY_API_KEY" });
  }
  var domain = (properties.getProperty("REBRANDLY_DOMAIN") || "rebrand.ly").trim().toLowerCase();
  if (domain !== "rebrand.ly") {
    return jsonResponse({ error: "REBRANDLY_DOMAIN 必須設為 rebrand.ly" });
  }
  return jsonResponse({ ok: true, provider: "rebrandly", domain: domain });
}

// 讓賣場系統那邊拿到最新的門市/技師/派工資料後，直接「原地更新」還沒使用的那筆
// Invitations 資料，連結網址本身不變，客戶手上的連結繼續有效，之後填寫時
// Responses 就會帶出正確的資訊。已經使用過的（UsedAt 有值）不會被這支 API 動到。
// 2026-09-11 起只更新新 Sheet——舊 Sheet 的邀請都是換表之前建立的，不會再被
// 這支批次流程觸碰到（見檔案開頭「2026-09-11 改版說明」）。
function handleUpdateInvitationMeta(body) {
  var expected = PropertiesService.getScriptProperties().getProperty("SURVEY_ADMIN_SECRET");
  if (!expected || body.adminSecret !== expected) {
    return jsonResponse({ error: "未授權" });
  }

  var customerCode = (body.customerCode || "").toString().trim();
  var phone = (body.phone || "").toString().replace(/\D/g, "");
  if (!customerCode || phone.length < 8) {
    return jsonResponse({ error: "請提供客戶代號與有效電話" });
  }

  var store = safeCell(body.store);
  var technician = safeCell(body.technician);
  var serviceDate = "'" + safeCell(body.serviceDate);
  var serviceTime = "'" + safeCell(body.serviceTime);
  var dispatchType = safeCell(body.dispatchType);
  var dispatchNo = "'" + safeCell(body.dispatchNo);
  var dispatchDate = "'" + safeCell(body.dispatchDate);

  var sheet = getSheet(getNewSpreadsheet(), "Invitations");
  var data = sheet.getDataRange().getValues();
  var updated = 0;
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] !== customerCode) continue;
    var rowPhoneDigits = (data[i][2] || "").toString().replace(/\D/g, "");
    if (rowPhoneDigits.slice(-4) !== phone.slice(-4)) continue;
    if (data[i][4]) continue; // UsedAt 有值代表已經填過，不動它
    sheet.getRange(i + 1, 6, 1, 7).setValues([[store, technician, serviceDate, serviceTime, dispatchType, dispatchNo, dispatchDate]]);
    updated++;
  }
  return jsonResponse({ ok: true, updated: updated });
}

// 清掉 Invitations 裡「同一位客戶好幾筆都還沒使用」的孤兒連結，只留 CreatedAt
// 最新的一筆。已經使用過的（UsedAt 有值）一律保留，不會被清掉——那是已經定案的
// 問卷結果的憑證，不能動。2026-09-11 起只清新 Sheet，理由同 handleUpdateInvitationMeta。
//
// 效能考量：資料量大時（上萬筆）逐列 deleteRow() 太慢，改成整段 clearContent()
// 之後一次用 setValues() 把要保留的資料寫回去，只需要一次讀、一次寫。
function handleCleanupInvitations(body) {
  var expected = PropertiesService.getScriptProperties().getProperty("SURVEY_ADMIN_SECRET");
  if (!expected || body.adminSecret !== expected) {
    return jsonResponse({ error: "未授權" });
  }

  var sheet = getSheet(getNewSpreadsheet(), "Invitations");
  var data = sheet.getDataRange().getValues();
  var header = data[0];
  var rows = data.slice(1);

  var latestUnusedByKey = {}; // "客代|電話末4碼" -> {row, createdAt}
  var keepRows = [];

  rows.forEach(function (row) {
    var usedAt = row[4];
    if (usedAt) {
      keepRows.push(row); // 已使用過，永遠保留
      return;
    }
    var customerCode = row[1];
    var phone = (row[2] || "").toString();
    var key = customerCode + "|" + phone.slice(-4);
    var createdAt = row[3] ? new Date(row[3]).getTime() : 0;
    var existing = latestUnusedByKey[key];
    if (!existing || createdAt > existing.createdAt) {
      latestUnusedByKey[key] = { row: row, createdAt: createdAt };
    }
  });

  Object.keys(latestUnusedByKey).forEach(function (key) {
    keepRows.push(latestUnusedByKey[key].row);
  });

  var before = rows.length;
  var after = keepRows.length;

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, header.length).clearContent();
  }
  if (keepRows.length > 0) {
    sheet.getRange(2, 1, keepRows.length, header.length).setValues(keepRows);
  }

  return jsonResponse({ ok: true, before: before, after: after, deleted: before - after });
}

function handleSubmitSurvey(body) {
  var rating = body.rating;
  var comment = safeCell((body.comment || "").toString().slice(0, 300));
  var token = (body.token || "").toString().trim();
  var customerCode = (body.customerCode || "").toString().trim();
  var phone = (body.phone || "").toString().replace(/\D/g, "");

  if (rating !== "satisfied" && rating !== "unsatisfied") {
    return jsonResponse({ error: "請選擇滿意或不滿意" });
  }
  if (!isValidToken(token)) {
    return jsonResponse({ error: "問卷連結無效或已使用" });
  }

  var found = findInvitationRow(hashToken(token));
  if (!found) {
    return jsonResponse({ error: "問卷連結無效或已使用" });
  }
  var invitation = found.row;
  if (
    (customerCode && customerCode !== invitation.customerCode) ||
    (phone && phone.slice(-4) !== invitation.phone.slice(-4))
  ) {
    return jsonResponse({ error: "問卷資料不相符" });
  }
  if (invitation.usedAt) {
    return jsonResponse({ error: "這份問卷已完成，無法再次填寫" });
  }
  if (isExpired(invitation.createdAt)) {
    return jsonResponse({ error: "此連結已過期，請聯繫客服重新取得連結" });
  }

  // 欄位順序: TokenHash, CustomerCode, Phone, CreatedAt, UsedAt -> UsedAt 是第 5 欄
  // （新、舊 Sheet 這 5 欄的順序完全一樣，找到是哪個 sheet 就往哪個 sheet 寫）
  found.sheet.getRange(found.rowIndex + 1, 5).setValue(new Date());

  // 2026-09-11 起：不管這個 token 是舊 Sheet 還是新 Sheet 核發的，問卷回覆一律
  // 寫進新 Sheet 的 Responses（老闆要求「新的通通收到新表」，見檔案開頭說明）。
  // 派工單別/單號/日期只有新 Sheet 核發的邀請才有（舊 Sheet 沒有這幾欄，
  // invitation.dispatchType 等於空字串，Responses 那幾欄就留白，不是漏資料）。
  var ratingLabel = rating === "satisfied" ? "滿意" : "不滿意";
  // 2026-09-15 使用者要求：回覆日期要看得出幾點幾分，不能只有到日期，格式
  // 「yyyy/MM/dd HH:mm」（24小時制、零補齊），跟其他欄位一樣前面加 "'" 強制
  // 純文字存，避免 Sheets 把它當成日期/時間型別存起來（同一份原因見檔案開頭
  // 「2026-09-11 改版說明」上面那段對 setNumberFormat("@") 的說明）。因為
  // yyyy/MM/dd HH:mm 每個欄位都固定寬度、零補齊，純文字字串排序（sort()）
  // 出來的結果跟時間先後順序完全一致，下面的排序才能直接用字串比較。
  var submittedDate = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy/MM/dd HH:mm");
  var sentDate = invitation.createdAt
    ? Utilities.formatDate(new Date(invitation.createdAt), Session.getScriptTimeZone(), "yyyy/MM/dd")
    : "";
  var leaveDateTime = [safeCell(invitation.serviceDate), safeCell(invitation.serviceTime)].filter(String).join(" ");
  var responses = getSheet(getNewSpreadsheet(), "Responses");
  responses.appendRow([
    safeCell(invitation.dispatchType),
    "'" + safeCell(invitation.dispatchNo),
    "'" + safeCell(invitation.dispatchDate),
    safeCell(invitation.store),
    safeCell(invitation.technician),
    invitation.customerCode,
    "'" + invitation.phone,
    "'" + leaveDateTime,
    "'" + sentDate,
    "'" + submittedDate,
    ratingLabel,
    comment,
  ]);

  // 2026-09-15 使用者要求：整張表照「回覆日期」由舊到新、由上到下排列。單純
  // 靠 appendRow() 本來就會加在最後一列，正常情況下已經是舊到新，但這裡直接
  // 明確排序一次，不管之前有沒有人手動調過順序、或極端情況下兩筆回覆幾乎同時
  // 送出但寫入順序跟送出順序不一致，排序後都能保證正確，不必假設一定不會
  // 發生。J 欄（回覆日期）是第 10 欄，只排序資料列（跳過第 1 列標題）。
  var lastRow = responses.getLastRow();
  if (lastRow > 2) {
    responses.getRange(2, 1, lastRow - 1, responses.getLastColumn()).sort({ column: 10, ascending: true });
  }

  return jsonResponse({ ok: true });
}

function safeCell(value) {
  var text = (value || "").toString().trim();
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

// 先查新 Sheet（往後絕大多數的 token 都會在這裡），找不到才退回查舊 Sheet
// （2026-09-11 換表之前核發、客戶還沒填的舊連結）。回傳 { sheet, rowIndex, row }，
// rowIndex 是 0-based 的資料列索引（不含標題列，呼叫端要寫回去記得 +1 再 +1
// 轉成 Sheet 的 1-based 列號），找不到回傳 null。
function findInvitationRow(tokenHash) {
  // 2026-09-11 修正：改成延遲評估（傳函式、不是先算好的 sheet），只有在新 Sheet
  // 真的找不到時才會去開舊 Sheet、對它跑 getSheet()。原本兩個 sheet 一開始就
  // 一起算好，每次呼叫都會對「兩份」Sheet 執行 getSheet() 裡的格式設定，
  // 使用者反映送出問卷會卡頓，就是這裡多做的工。
  var sourceFns = [
    function () { return getSheet(getNewSpreadsheet(), "Invitations"); },
    function () { return getSheet(getOldSpreadsheet(), "Invitations"); },
  ];
  for (var s = 0; s < sourceFns.length; s++) {
    var sheet = sourceFns[s]();
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === tokenHash) {
        return {
          sheet: sheet,
          rowIndex: i,
          row: {
            customerCode: data[i][1],
            phone: (data[i][2] || "").toString(),
            createdAt: data[i][3],
            usedAt: data[i][4],
            store: data[i][5] || "",
            technician: data[i][6] || "",
            serviceDate: data[i][7] || "",
            serviceTime: data[i][8] || "",
            // 舊 Sheet 沒有這三欄，data[i][9]/[10]/[11] 會是 undefined，用 || "" 保底。
            dispatchType: data[i][9] || "",
            dispatchNo: data[i][10] || "",
            dispatchDate: data[i][11] || "",
          },
        };
      }
    }
  }
  return null;
}

function isExpired(createdAt) {
  if (!createdAt) return false;
  var ageMs = Date.now() - new Date(createdAt).getTime();
  return ageMs > LINK_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
}

function isValidToken(token) {
  // 目前 createInvitation 產生 16 位小寫十六進位 Token；先拒絕異常長度/字元，
  // 避免把任意輸入送進雜湊與試算表查詢，也避免未來誤把其他資料當 Token 使用。
  return typeof token === "string" && /^[a-f0-9]{16}$/.test(token);
}

function createShortUrl(longUrl) {
  var properties = PropertiesService.getScriptProperties();
  var rebrandlyKey = (properties.getProperty("REBRANDLY_API_KEY") || "").trim();
  if (rebrandlyKey) return createRebrandlyShortUrl(longUrl, properties, rebrandlyKey);
  return createFirstPartyShortUrl(longUrl);
}

function isAllowedSurveyUrl(longUrl, base) {
  try {
    var parsed = new URL(longUrl);
    var allowed = new URL(base);
    var token = parsed.searchParams.get("token") || "";
    return parsed.protocol === "https:"
      && allowed.protocol === "https:"
      && parsed.origin === allowed.origin
      && parsed.pathname === allowed.pathname
      && parsed.searchParams.toString() === "token=" + token
      && isValidToken(token);
  } catch (err) {
    return false;
  }
}

function createRebrandlyShortUrl(longUrl, properties, apiKey) {
  var workspaceId = (properties.getProperty("REBRANDLY_WORKSPACE_ID") || "").trim();
  var domain = (properties.getProperty("REBRANDLY_DOMAIN") || "rebrand.ly").trim().toLowerCase();
  var headers = {
    "Content-Type": "application/json",
    apikey: apiKey,
  };
  if (workspaceId) headers.workspace = workspaceId;

  try {
    var response = UrlFetchApp.fetch("https://api.rebrandly.com/v1/links", {
      method: "post",
      headers: headers,
      payload: JSON.stringify({
        destination: longUrl,
        title: "千山淨水服務問卷",
      }),
      muteHttpExceptions: true,
    });
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) return "";
    var result = JSON.parse(response.getContentText());
    var shortUrl = (result.shortUrl || "").toString().trim();
    if (!shortUrl) return "";
    if (shortUrl.indexOf("https://") !== 0) shortUrl = "https://" + shortUrl;

    var parsed = new URL(shortUrl);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.toLowerCase() !== domain ||
      !/^\/[A-Za-z0-9_-]{3,32}$/.test(parsed.pathname) ||
      parsed.search ||
      parsed.hash ||
      shortUrl.length > 40
    ) {
      return "";
    }
    return shortUrl;
  } catch (err) {
    console.error("Rebrandly 短網址服務失敗，未建立邀請：" + err.message);
    return "";
  }
}

function createFirstPartyShortUrl(longUrl) {
  var properties = PropertiesService.getScriptProperties();
  var apiUrl = (properties.getProperty("SHORTENER_API_URL") || "").trim();
  var shortBase = (properties.getProperty("SHORTENER_BASE_URL") || "").replace(/\/$/, "");
  var adminSecret = properties.getProperty("SHORTENER_ADMIN_SECRET") || "";
  if (!apiUrl || !shortBase || !adminSecret) return "";

  try {
    var response = UrlFetchApp.fetch(apiUrl, {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + adminSecret },
      payload: JSON.stringify({ targetUrl: longUrl }),
      muteHttpExceptions: true,
    });
    if (response.getResponseCode() !== 200) return "";
    var result = JSON.parse(response.getContentText());
    var shortUrl = (result.shortUrl || "").toString();
    var parsed = new URL(shortUrl);
    var configured = new URL(shortBase);
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== configured.origin ||
      !/^\/a\/[A-Za-z0-9_-]{8}$/.test(parsed.pathname) ||
      parsed.search ||
      parsed.hash ||
      shortUrl.length > 40
    ) {
      return "";
    }
    return shortUrl;
  } catch (err) {
    console.error("短網址服務失敗，未建立邀請：" + err.message);
    return "";
  }
}

function hashToken(token) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token, Utilities.Charset.UTF_8);
  return bytes
    .map(function (b) {
      return (b < 0 ? b + 256 : b).toString(16).padStart(2, "0");
    })
    .join("");
}

// 2026-09-11 改成接受明確的 spreadsheet 參數（不再只有 getActiveSpreadsheet()），
// 因為新版要同時操作舊 Sheet（只查詢，不新增）跟新 Sheet（新增+查詢）兩份試算表。
// 對舊 Sheet 來說，Invitations/Responses 兩個分頁本來就已經存在、有資料，
// 下面「建立分頁+寫標題列」那段不會被執行到，舊資料完全不會被動到。
function getSheet(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  // 2026-09-11 修正：分頁「已經存在但完全空白」（例如換表前手動清空過）也要補標題
  // 列，不能只判斷「分頁不存在」——原本的判斷漏了這個情況，導致第一筆資料直接
  // 寫進第 1 列，變成沒有標題列，後面 findInvitationRow() 又預設「第 1 列一定是
  // 標題」而跳過不查，那筆資料就永遠找不到（實測 TEST0001 就是這樣憑空「消失」）。
  if (sheet.getLastRow() === 0) {
    if (name === "Invitations") {
      sheet.appendRow([
        "Token雜湊", "客戶代號", "電話", "建立時間", "使用時間",
        "門市", "技師", "離場日期", "離場時間", "派工單別", "派工單號", "派工日期",
      ]);
    } else if (name === "Responses") {
      sheet.appendRow([
        "派工單別", "派工單號", "派工日期", "門市", "技師", "客戶代號", "電話",
        "離場", "發送日期", "回覆日期", "服務滿意度", "留下原因或建議",
      ]);
    }
    // Invitations 的電話欄位固定在 C 欄，強制設成純文字格式，避免 Sheet 自動把它
    // 當數字存而吃掉開頭的 0；離場日期/離場時間/派工日期是「2026/09/07」「14:31」
    // 這種看起來像日期/時間的字串，一樣要強制純文字，不然 Sheet 會自動轉成日期/
    // 時間型別存起來，之後讀回來變成 JS Date 物件（2026-09-08 使用者截圖回報過
    // 這個現象：日期欄位變成一長串「Thu Sep 03 2026 00:00:00 GMT+0800 (台北標準
    // 時間)」）。Responses 的日期/離場欄位一樣要強制純文字。單獨設定格式不夠可靠
    // （欄位建立之後才設定格式、不會回頭修正已經存進去的值），寫入時另外在值前面
    // 加 "'" 雙重保險，見 handleCreateInvitation/handleUpdateInvitationMeta/
    // handleSubmitSurvey。
    // 2026-09-11 修正：這段格式設定移到「剛建立標題列」這個只會發生一次的分支
    // 裡面——原本每次呼叫 getSheet() 都會對整欄重跑一次 setNumberFormat，使用者
    // 反映送出問卷會卡頓，元兇就是這個（而且 findInvitationRow 每次還會對「兩份」
    // Sheet 都跑一次）。格式只要設定過一次就會保留，不需要每次呼叫都重設。
    if (name === "Invitations") {
      sheet.getRange("C:C").setNumberFormat("@");
      sheet.getRange("H:L").setNumberFormat("@");
    } else if (name === "Responses") {
      sheet.getRange("B:C").setNumberFormat("@");
      sheet.getRange("G:J").setNumberFormat("@");
    }
  }
  return sheet;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
