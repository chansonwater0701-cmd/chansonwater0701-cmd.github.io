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
 * 資料會自動建立兩個工作表：
 * - Invitations：一次性問卷連結的核發紀錄（token 雜湊、客戶代號、電話、建立時間、使用時間）
 * - Responses：問卷送出結果（時間、客戶代號、電話、服務滿意度、留下原因或建議）
 *
 * 連結有效期限：LINK_EXPIRY_DAYS（預設 7 天）。從 createInvitation 建立的當下起算，
 * 超過這個天數還沒使用的連結，即使 token 本身正確，送出時也會被拒絕（過期不等於用過，
 * 兩者在 Invitations 分頁裡是分開判斷的）。
 */

var LINK_EXPIRY_DAYS = 7;

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === "createInvitation") {
      return handleCreateInvitation(body);
    }
    if (body.action === "submitSurvey") {
      return handleSubmitSurvey(body);
    }
    return jsonResponse({ error: "未知的操作" });
  } catch (err) {
    return jsonResponse({ error: "伺服器發生錯誤: " + err.message });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  var token = e.parameter.token;
  if (!token) return jsonResponse({ valid: false });

  var row = findInvitationRow(hashToken(token));
  if (!row || row.usedAt || isExpired(row.createdAt)) return jsonResponse({ valid: false });
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

  // 2026-09-01 使用者要求縮短簡訊連結：原本兩組 UUID 接起來共 72 字元，過長。
  // 改成取一組 UUID 的前 16 個十六進位字元（64 bits 亂數），對一次性、7 天就
  // 過期、送出前還要跟資料庫比對雜湊值的連結來說，安全性綽綽有餘。
  var token = Utilities.getUuid().replace(/-/g, "").substring(0, 16);
  var sheet = getSheet("Invitations");
  sheet.appendRow([hashToken(token), customerCode, "'" + phone, new Date(), ""]);

  var base = (body.baseUrl || "").toString().replace(/\/$/, "");
  var url = base ? base + "/?token=" + token : token;

  return jsonResponse({
    ok: true,
    token: token,
    url: url,
    smsText: "為了提供更優質的服務，千山淨水誠摯邀請您，為此次提供的服務給予評分，您的寶貴意見對我們非常重要：" + url,
  });
}

function handleSubmitSurvey(body) {
  var rating = body.rating;
  var comment = (body.comment || "").toString().trim().slice(0, 300);
  var token = (body.token || "").toString();
  var customerCode = (body.customerCode || "").toString().trim();
  var phone = (body.phone || "").toString().replace(/\D/g, "");

  if (rating !== "satisfied" && rating !== "unsatisfied") {
    return jsonResponse({ error: "請選擇滿意或不滿意" });
  }
  if (!token) {
    return jsonResponse({ error: "問卷連結無效或已使用" });
  }

  var sheet = getSheet("Invitations");
  var data = sheet.getDataRange().getValues();
  var tokenHash = hashToken(token);
  var rowIndex = -1;
  var invitation = null;

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === tokenHash) {
      rowIndex = i;
      invitation = {
        customerCode: data[i][1],
        phone: data[i][2],
        createdAt: data[i][3],
        usedAt: data[i][4],
      };
      break;
    }
  }

  if (rowIndex === -1) {
    return jsonResponse({ error: "問卷連結無效或已使用" });
  }
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
  sheet.getRange(rowIndex + 1, 5).setValue(new Date());

  var responses = getSheet("Responses");
  responses.appendRow([new Date(), invitation.customerCode, "'" + invitation.phone, rating, comment]);

  return jsonResponse({ ok: true });
}

function findInvitationRow(tokenHash) {
  var sheet = getSheet("Invitations");
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === tokenHash) {
      return { createdAt: data[i][3], usedAt: data[i][4] };
    }
  }
  return null;
}

function isExpired(createdAt) {
  if (!createdAt) return false;
  var ageMs = Date.now() - new Date(createdAt).getTime();
  return ageMs > LINK_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
}

function hashToken(token) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token, Utilities.Charset.UTF_8);
  return bytes
    .map(function (b) {
      return (b < 0 ? b + 256 : b).toString(16).padStart(2, "0");
    })
    .join("");
}

function getSheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (name === "Invitations") {
      sheet.appendRow(["TokenHash", "CustomerCode", "Phone", "CreatedAt", "UsedAt"]);
    } else if (name === "Responses") {
      sheet.appendRow(["時間", "客戶代號", "電話", "服務滿意度", "留下原因或建議"]);
    }
  }
  // 電話欄位固定在 C 欄，強制設成純文字格式，避免 Sheet 自動把它當數字存而吃掉開頭的 0。
  if (name === "Invitations" || name === "Responses") {
    sheet.getRange("C:C").setNumberFormat("@");
  }
  return sheet;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
