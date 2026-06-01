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

// 使用的 Gemini 模型(免費版,快又輕,適合分級)
var GEMINI_MODEL = "gemini-2.5-flash";

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
   Gemini AI 分析
   ============================================================ */

// 把單筆通報交給 Gemini,回傳 { severity, guidance }
function analyzeWithGemini_(data) {
  var apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) {
    return { severity: "", guidance: "(尚未設定 GEMINI_API_KEY,請見檔案上方說明)" };
  }

  try {
    var url = "https://generativelanguage.googleapis.com/v1beta/models/" +
              GEMINI_MODEL + ":generateContent?key=" + apiKey;

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
        // 要求 Gemini 直接輸出符合結構的 JSON,免去字串解析的麻煩
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            severity: { type: "STRING", enum: ["重大", "一般"] },
            guidance: { type: "STRING" }
          },
          required: ["severity", "guidance"]
        }
      }
    };

    var res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var code = res.getResponseCode();
    if (code !== 200) {
      return {
        severity: "",
        guidance: "(AI 分析失敗 HTTP " + code + ":" + res.getContentText().slice(0, 200) + ")"
      };
    }

    var json = JSON.parse(res.getContentText());
    var text = json.candidates[0].content.parts[0].text;
    var result = JSON.parse(text);
    return {
      severity: result.severity || "",
      guidance: result.guidance || ""
    };
  } catch (err) {
    return { severity: "", guidance: "(AI 分析發生錯誤:" + err + ")" };
  }
}

// 組合給 Gemini 的提示詞
function buildPrompt_(data) {
  var typeLabel = TYPE_LABELS[data.type] || data.type || "未指定";
  var sevLabel = SEVERITY_LABELS[data.severity] || data.severity || "未指定";
  var hasPhotos = !!(data.photos && data.photos.length);
  return [
    "你是緊急事件通報的分析助理。請根據以下通報內容,判斷事件嚴重程度,並提供給承辦人員的初步處置建議。",
    "",
    "【通報資訊】",
    "事件類型:" + typeLabel,
    "通報人自評緊急程度:" + sevLabel,
    "地點:" + (data.location || "未提供"),
    "事件描述:" + (data.description || "未提供"),
    "",
    "【分析要求】",
    "1. severity:綜合判斷此事件屬於「重大」或「一般」。涉及生命安全、火勢蔓延、多人傷亡、大範圍影響等情況判為「重大」。",
    "2. guidance:給承辦人員的初步處置建議,2-4 句,具體、可執行,使用繁體中文。",
    "",
    (hasPhotos ? "※ 通報附有現場照片,請一併參考照片中的實際災情(如火勢、煙霧、淹水、受損程度等)輔助判斷。" : ""),
    "注意:你的判斷僅供輔助參考,重大事件仍須人工複核。"
  ].join("\n");
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
