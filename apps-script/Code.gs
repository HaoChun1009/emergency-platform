/**
 * 緊急事件通報平台 — Google 試算表後端
 *
 * 用途:接收前端網頁送來的通報資料,寫入這份試算表。
 *
 * 部署方式(只需做一次):
 *   1. 在 Google 試算表中,點上方選單「擴充功能 → Apps Script」
 *   2. 把這整段程式碼貼進去,覆蓋原本的內容,按存檔(磁碟圖示)
 *   3. 右上角「部署 → 新增部署作業」
 *        - 類型選「網頁應用程式 (Web app)」
 *        - 執行身分:我(你自己)
 *        - 具有存取權的使用者:「任何人 (Anyone)」  ← 很重要
 *   4. 按「部署」,第一次會要你授權,點允許
 *   5. 複製產生的「網頁應用程式網址」(https://script.google.com/macros/s/.../exec)
 *      把這個網址貼回來給我,我會填進前端網頁
 */

// 試算表的標題列
var HEADERS = [
  "送出時間", "通報編號", "事件類型", "緊急程度",
  "地點", "座標", "事件描述", "通報人", "聯絡電話", "狀態"
];

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
      data.status || "new"
    ]);

    return jsonOutput_({ ok: true, caseId: data.caseId });
  } catch (err) {
    return jsonOutput_({ ok: false, error: String(err) });
  }
}

// 方便測試:用瀏覽器直接打開網址時會看到這個
function doGet() {
  return jsonOutput_({ ok: true, message: "緊急通報平台後端運作中" });
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
