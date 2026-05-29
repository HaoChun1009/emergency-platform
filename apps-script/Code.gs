/**
 * 緊急事件通報平台 — Google 試算表後端
 *
 * 用途:接收前端網頁送來的通報資料,寫入這份試算表;
 *       現場照片會存到 Google 雲端硬碟,並在試算表填入連結。
 *
 * ⚠️ 更新程式後,務必「重新部署」才會生效:
 *      部署 → 管理部署作業 → 編輯(鉛筆)→ 版本選「新版本」→ 部署
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

// 試算表的標題列(新增「現場照片」欄)
var HEADERS = [
  "送出時間", "通報編號", "事件類型", "緊急程度",
  "地點", "座標", "事件描述", "通報人", "聯絡電話", "現場照片", "狀態"
];

// 存放上傳照片的雲端硬碟資料夾名稱
var PHOTO_FOLDER_NAME = "緊急通報照片";

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
      data.status || "new"
    ]);

    return jsonOutput_({ ok: true, caseId: data.caseId, photoCount: photoLinks.length });
  } catch (err) {
    return jsonOutput_({ ok: false, error: String(err) });
  }
}

// 方便測試:用瀏覽器直接打開網址時會看到這個
function doGet() {
  return jsonOutput_({ ok: true, message: "緊急通報平台後端運作中" });
}

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

// 取得工作表,若沒有標題列則自動建立
function getSheet_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function jsonOutput_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
