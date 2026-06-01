/**
 * 緊急事件通報平台 — Google 試算表後端
 *
 * 用途:接收前端網頁送來的通報資料,寫入這份試算表;
 *       現場照片會存到 Google 雲端硬碟,並在試算表填入連結;
 *       新通報進來時,呼叫 Gemini 免費 API 自動分析「分級」與「處置建議」,寫回試算表;
 *       若通報附有現場照片,會一併將照片送給 Gemini(多模態)輔助辨識災情。
 *
 * ⚠️ 更新程式後,務必「重新部署」才會生效:
 *      部署 → 管理部署作業 → 編輯(鉛筆)→ 版本選「新版本」→ 部署
 *
 * 🔑 設定 Gemini API 金鑰(只需做一次,金鑰不會外洩到前端):
 *   1. 到 https://aistudio.google.com/apikey 申請免費 API Key(免信用卡)
 *   2. Apps Script 編輯器左側「專案設定(齒輪)」→「指令碼屬性」
 *   3. 新增屬性:名稱填 GEMINI_API_KEY,值填你的金鑰 → 儲存
 *   ⚠️ 切勿把金鑰寫進程式碼或前端網頁。
 *
 * 部署方式(第一次):
 *   1. 試算表上方選單「擴充功能 → Apps Script」
 *   2. 貼上本程式碼,存檔
 *   3. 右上角「部署 → 新增部署作業」
 *        - 類型:網頁應用程式 (Web app)
 *        - 執行身分:我
 *        - 具有存取權的使用者:任何人 (Anyone)
 *   4. 授權 → 複製網址(.../exec)
 */

// 試算表的標題列(在最後面新增「AI分級」「AI處置建議」欄,
// 放最後可確保既有舊資料的欄位不會錯位)
var HEADERS = [
  "送出時間", "通報編號", "事件類型", "緊急程度",
  "地點", "座標", "事件描述", "通報人", "聯絡電話", "現場照片", "狀態",
  "AI分級", "AI處置建議"
];

// 存放上傳照片的雲端硬碟資料夾名稱
var PHOTO_FOLDER_NAME = "緊急通報照片";

// 即時通知設定:當 AI 判為「重大災害」時,寄 Email 給承辦。
// 收件者改放在指令碼屬性 NOTIFY_EMAILS(多筆用逗號分隔),避免把信箱寫進公開程式。
// 設定方式:Apps Script 左側「專案設定(齒輪)→ 指令碼屬性」新增 NOTIFY_EMAILS。
// 只有「重大災害」會觸發通知的分級清單(日後要含廠級可加 "廠級事故")。
var NOTIFY_SEVERITIES = ["重大災害"];

// 使用的 Gemini 模型(免費版,快又輕,適合分級)
// 依序嘗試:主模型忙碌(503/429)時,自動改用下一個備援模型。
var GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite"];

// 標記「需人工判級」的提示文字(兩個模型都失敗時寫入試算表)
var MANUAL_REVIEW_TAG = "⚠️ 待人工判級";

// RAG 知識庫:存放 SOP 的試算表分頁名稱
// 此分頁不會公開(只在你的 Google 試算表內),程式只負責讀取。
// 分頁格式:A 欄=事件類型代碼(fire/medical…),B 欄=該類型的 SOP 內容文字。
var KNOWLEDGE_SHEET_NAME = "SOP知識庫";

// 從試算表「SOP知識庫」分頁讀取指定事件類型的 SOP 內容
// 找不到分頁或該類型時回傳空字串(AI 會退回一般性判斷)
function getKnowledge_(type) {
  if (!type) return "";
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(KNOWLEDGE_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 1) return "";
    var values = sheet.getRange(1, 1, sheet.getLastRow(), 2).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0]).trim() === type) {
        return String(values[i][1] || "").trim();
      }
    }
    return "";
  } catch (err) {
    return "";
  }
}

// 代碼轉中文
var TYPE_LABELS = {
  fire: "火災", medical: "醫療急救", accident: "交通事故",
  crime: "治安/犯罪", disaster: "天然災害",
  infrastructure: "公共設施危險", other: "其他"
};
var SEVERITY_LABELS = { high: "緊急", medium: "普通", low: "非緊急" };

// 接收前端 POST 過來的通報
function doPost(e) {
  try {
    var sheet = getSheet_();
    var data = JSON.parse(e.postData.contents);

    var coords = data.coords ? (data.coords.lat + ", " + data.coords.lng) : "";

    // 儲存照片到雲端硬碟,取得連結
    var photoLinks = savePhotos_(data.photos, data.caseId);

    // 呼叫 Gemini 自動分析:分級 + 處置建議
    var ai = analyzeWithGemini_(data);

    sheet.appendRow([
      new Date(),
      data.caseId || "",
      TYPE_LABELS[data.type] || data.type || "",
      SEVERITY_LABELS[data.severity] || data.severity || "",
      data.location || "",
      coords,
      data.description || "",
      data.reporter || "",
      data.phone || "",
      photoLinks.join("\n"),
      data.status || "new",
      ai.severity,
      ai.guidance
    ]);

    // 若 AI 全部失敗、需人工判級,把該列整列標成淺紅,讓承辦一眼看到
    if (ai.severity === MANUAL_REVIEW_TAG) {
      var row = sheet.getLastRow();
      sheet.getRange(row, 1, 1, HEADERS.length).setBackground("#fde2e1");
    }

    // 即時通知:重大災害時寄 Email 給承辦(失敗不影響通報儲存)
    // 通知結果寫進「狀態」欄,方便直接在試算表看到有沒有成功通知。
    var notifyResult = "";
    try {
      notifyResult = notifyIfNeeded_(data, ai, coords, photoLinks);
    } catch (notifyErr) {
      notifyResult = "通知失敗:" + notifyErr;
    }
    if (notifyResult) {
      var statusRow = sheet.getLastRow();
      var statusCol = HEADERS.indexOf("狀態") + 1;
      sheet.getRange(statusRow, statusCol).setValue(notifyResult);
    }

    return jsonOutput_({
      ok: true,
      caseId: data.caseId,
      photoCount: photoLinks.length,
      ai: ai
    });
  } catch (err) {
    return jsonOutput_({ ok: false, error: String(err) });
  }
}

// 方便測試:用瀏覽器直接打開網址時會看到這個
function doGet() {
  return jsonOutput_({ ok: true, message: "緊急通報平台後端運作中" });
}

/* ============================================================
   即時通知(重大災害寄 Email)
   ============================================================ */

// 依 AI 分級判斷是否需通知;需要時寄 Email 給承辦。
// 回傳一段「狀態文字」寫回試算表狀態欄,讓寄信結果在試算表就看得到。
function notifyIfNeeded_(data, ai, coords, photoLinks) {
  // 只有指定分級(預設「重大災害」)才通知;其他分級回傳空字串(狀態欄維持原值)
  if (NOTIFY_SEVERITIES.indexOf(ai.severity) === -1) return "";

  var emails = PropertiesService.getScriptProperties().getProperty("NOTIFY_EMAILS");
  if (!emails) {
    return "⚠️ 未設定通知信箱(NOTIFY_EMAILS)";
  }

  // 先檢查今日剩餘額度,額度不足時明確標示(這是「真實通報沒收到信」最常見的原因)
  var remaining = MailApp.getRemainingDailyQuota();
  if (remaining <= 0) {
    return "⚠️ Email 今日額度用罄,未送出(建議改用 LINE)";
  }

  var typeLabel = TYPE_LABELS[data.type] || data.type || "未指定";
  var subject = "🔴【重大災害通報】" + typeLabel + " " + (data.caseId || "");

  var bodyLines = [
    "系統偵測到一筆【重大災害】等級的緊急通報,請立即處理。",
    "",
    "通報編號:" + (data.caseId || "—"),
    "事件類型:" + typeLabel,
    "AI 研判分級:" + ai.severity,
    "地點:" + (data.location || "—"),
    "座標:" + (coords || "—"),
    "事件描述:" + (data.description || "—"),
    "聯絡電話:" + (data.phone || "—"),
    "通報人:" + (data.reporter || "—"),
    "現場照片:" + (photoLinks && photoLinks.length ? photoLinks.join("  ") : "無"),
    "",
    "【AI 處置建議】",
    ai.guidance || "—",
    "",
    "※ 本通知由系統自動發送,AI 研判僅供參考,實際處置請依現場狀況與 SOP 判斷。"
  ];

  MailApp.sendEmail({
    to: emails,                       // 多筆收件者用逗號分隔
    subject: subject,
    body: bodyLines.join("\n")
  });
  return "✅ 已通知(Email,當下剩餘額度 " + (remaining - 1) + ")";
}

// 測試用:在編輯器執行此函式,可驗證 Email 通知是否正常(會用一筆假的重大災害)
function testNotify() {
  var sample = {
    caseId: "ER-TEST-NOTIFY",
    type: "fire",
    location: "和平廠 測試地點",
    description: "測試:儲槽大火延燒、多人受傷、無法控制",
    phone: "0900-000-000",
    reporter: "系統測試"
  };
  var ai = { severity: "重大災害", guidance: "(測試)請立即通報 119 並啟動應變組織。" };
  notifyIfNeeded_(sample, ai, "24.0, 121.7", []);
  Logger.log("testNotify 執行完畢,請檢查收件匣");
}

// 查詢今日 Email 剩餘額度:在編輯器執行此函式,結果會跳出對話框 + 寫在執行紀錄
function checkEmailQuota() {
  var remaining = MailApp.getRemainingDailyQuota();
  var msg = "今日 Email 剩餘可寄送封數:" + remaining;
  Logger.log(msg);
  // 也記到指令碼屬性,方便事後查
  PropertiesService.getScriptProperties().setProperty("LAST_EMAIL_QUOTA", String(remaining));
  return msg;
}

/* ============================================================
   Gemini AI 分析
   ============================================================ */

// 把單筆通報交給 Gemini 分析,回傳 { severity, guidance }
// 主模型忙碌(503/429)時,自動改用備援模型;全部失敗則標記「待人工判級」。
function analyzeWithGemini_(data) {
  var apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) {
    return { severity: "", guidance: "(尚未設定 GEMINI_API_KEY,請見檔案上方說明)" };
  }

  var lastInfo = "";
  // 依序嘗試每個模型(主 → 備援)
  for (var m = 0; m < GEMINI_MODELS.length; m++) {
    var outcome = callGeminiModel_(GEMINI_MODELS[m], apiKey, data);
    if (outcome.ok) {
      return { severity: outcome.severity, guidance: outcome.guidance };
    }
    lastInfo = outcome.info;
    // 只有「暫時性忙碌」才換下一個模型試;其他錯誤直接跳出
    if (!outcome.busy) break;
  }

  // 所有模型都失敗 → 標記待人工判級,提示承辦依 SOP 判斷
  return {
    severity: MANUAL_REVIEW_TAG,
    guidance: "AI 服務暫時無法分析(" + lastInfo + ")。請承辦人員『依現場資訊與 SOP 自行判定分級並處置』,勿等待 AI。"
  };
}

// 呼叫單一模型(含暫時性錯誤的小幅重試)
// 回傳 { ok, busy, severity, guidance, info }
function callGeminiModel_(model, apiKey, data) {
  try {
    var url = "https://generativelanguage.googleapis.com/v1beta/models/" +
              model + ":generateContent?key=" + apiKey;

    // 組合 parts:第一段是文字提示,接著把現場照片一起送給 Gemini 辨識
    var parts = [{ text: buildPrompt_(data) }];
    var imageParts = buildImageParts_(data.photos);
    for (var p = 0; p < imageParts.length; p++) {
      parts.push(imageParts[p]);
    }

    var payload = {
      contents: [{ parts: parts }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            severity: { type: "STRING", enum: ["重大災害", "廠級事故", "一般事故"] },
            guidance: { type: "STRING" }
          },
          required: ["severity", "guidance"]
        }
      }
    };

    var options = {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    // 同一模型先小幅重試 2 次(因應瞬間忙碌)
    var res, code;
    for (var t = 0; t < 2; t++) {
      res = UrlFetchApp.fetch(url, options);
      code = res.getResponseCode();
      if (code === 200 || (code !== 503 && code !== 429 && code !== 500)) break;
      if (t < 1) Utilities.sleep(1200);
    }

    if (code === 200) {
      var json = JSON.parse(res.getContentText());
      var text = json.candidates[0].content.parts[0].text;
      var result = JSON.parse(text);
      return {
        ok: true, busy: false,
        severity: result.severity || "",
        guidance: result.guidance || ""
      };
    }

    // 503/429 視為「忙碌」,讓上層換下一個備援模型
    var busy = (code === 503 || code === 429 || code === 500);
    return {
      ok: false, busy: busy,
      info: model + " HTTP " + code
    };
  } catch (err) {
    return { ok: false, busy: true, info: model + " 例外:" + err };
  }
}

// 組合給 Gemini 的提示詞(含 RAG 知識庫:依事件類型帶入對應 SOP)
function buildPrompt_(data) {
  var typeLabel = TYPE_LABELS[data.type] || data.type || "未指定";
  var sevLabel = SEVERITY_LABELS[data.severity] || data.severity || "未指定";
  var hasPhotos = !!(data.photos && data.photos.length);

  // RAG 檢索:依事件類型從試算表「SOP知識庫」分頁取出對應 SOP
  var knowledge = getKnowledge_(data.type);

  var lines = [
    "你是台泥和平廠緊急事件通報的分析助理。請『嚴格依據下方公司應變指引(SOP)』判斷事件分級,並提供初步處置建議。"
  ];

  if (knowledge) {
    lines.push("");
    lines.push("===== 公司應變指引(SOP)=====");
    lines.push(knowledge);
    lines.push("===== 指引結束 =====");
  }

  lines.push("");
  lines.push("【本次通報資訊】");
  lines.push("事件類型:" + typeLabel);
  lines.push("通報人自評緊急程度:" + sevLabel);
  lines.push("地點:" + (data.location || "未提供"));
  lines.push("事件描述:" + (data.description || "未提供"));
  lines.push("");
  lines.push("【分析要求】");

  if (knowledge) {
    lines.push("1. severity:請『依上方 SOP 的三級分級標準』判定為「重大災害」「廠級事故」或「一般事故」其中之一。務必對照 SOP 的判定條件(例如受傷人數、是否可控、是否需外部救援)。");
    lines.push("2. guidance:依 SOP 的應變流程與通報原則,給承辦/現場人員的初步處置建議,2-4 句,具體可執行,使用繁體中文。若 SOP 有對應步驟(如通報 119、切斷電源、疏散方向等),請具體引用。");
  } else {
    // 尚無此類型 SOP 時,退回一般性判斷
    lines.push("1. severity:此事件類型尚無對應 SOP,請依常理判定為「重大災害」「廠級事故」或「一般事故」其中之一(涉及人員傷亡或不可控判為重大)。");
    lines.push("2. guidance:給承辦人員的初步處置建議,2-4 句,具體、可執行,使用繁體中文。");
  }

  lines.push("");
  if (hasPhotos) {
    lines.push("※ 通報附有現場照片,請一併參考照片中的實際災情(如火勢、煙霧、淹水、受損程度等)輔助判斷。");
  }
  lines.push("注意:你的判斷僅供輔助參考,重大事件仍須人工複核。");

  return lines.join("\n");
}

// 把通報照片(dataURL)轉成 Gemini 接受的 inline_data 格式
// 限制送出的張數與大小,避免超過免費額度或請求過大
function buildImageParts_(photos) {
  var parts = [];
  if (!photos || !photos.length) return parts;

  var MAX_IMAGES = 3; // 最多送 3 張給 AI 分析(其餘仍會存檔,只是不分析)
  for (var i = 0; i < photos.length && i < MAX_IMAGES; i++) {
    try {
      var dataUrl = photos[i].dataUrl;
      var comma = dataUrl.indexOf(",");
      if (comma < 0) continue;
      var meta = dataUrl.substring(0, comma); // data:image/jpeg;base64
      var base64 = dataUrl.substring(comma + 1);
      var mime = meta.substring(meta.indexOf(":") + 1, meta.indexOf(";")) || "image/jpeg";
      parts.push({ inline_data: { mime_type: mime, data: base64 } });
    } catch (err) {
      // 單張照片處理失敗就略過,不影響其他張與文字分析
    }
  }
  return parts;
}

// 測試用:在編輯器選此函式按「執行」,可驗證金鑰與 API 是否正常(結果看「執行紀錄」)
function testGemini() {
  var sample = {
    type: "fire",
    severity: "high",
    location: "台北市信義區市府路 1 號",
    description: "三樓住宅冒出濃煙,疑似有人受困,火勢延燒中"
  };
  var result = analyzeWithGemini_(sample);
  Logger.log(JSON.stringify(result, null, 2));
}

/* ============================================================
   照片儲存
   ============================================================ */

// 將前端傳來的照片(dataURL)存成雲端硬碟檔案,回傳連結陣列
function savePhotos_(photos, caseId) {
  var links = [];
  if (!photos || !photos.length) return links;

  var folder = getPhotoFolder_();
  for (var i = 0; i < photos.length; i++) {
    try {
      var photo = photos[i];
      var parts = photo.dataUrl.split(",");
      var meta = parts[0]; // 例如 data:image/jpeg;base64
      var contentType = meta.substring(meta.indexOf(":") + 1, meta.indexOf(";"));
      var bytes = Utilities.base64Decode(parts[1]);
      var ext = contentType.split("/")[1] || "jpg";
      var fileName = (caseId || "report") + "_" + (i + 1) + "." + ext;
      var blob = Utilities.newBlob(bytes, contentType, fileName);
      var file = folder.createFile(blob);
      // 設為「知道連結的人可檢視」,方便管理者點開
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      links.push(file.getUrl());
    } catch (err) {
      links.push("(照片儲存失敗:" + err + ")");
    }
  }
  return links;
}

// 取得(或建立)存放照片的資料夾
function getPhotoFolder_() {
  var folders = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(PHOTO_FOLDER_NAME);
}

/* ============================================================
   試算表
   ============================================================ */

// 取得工作表,若沒有標題列則自動建立;既有試算表欄位不足時補上新欄位標題
function getSheet_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
  } else if (sheet.getLastColumn() < HEADERS.length) {
    // 既有試算表是舊版欄位:補上新標題(AI分級 / AI處置建議)
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight("bold");
  }
  return sheet;
}

function jsonOutput_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
