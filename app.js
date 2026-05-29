// 緊急事件通報平台 — 前端邏輯
// 通報資料會送到 Google 試算表後端(透過 Apps Script Web App)。
// 同時也在瀏覽器 localStorage 留一份備份。

// ⬇⬇⬇ Google Apps Script 後端網址 ⬇⬇⬇
const BACKEND_URL = "https://script.google.com/macros/s/AKfycbzYmmlJqgXR4TmoHn2GCi8XBVhRoVxwPBcE0mt_xnjyPEMMudg0qPubA1vOurGpVnQS/exec";
// ⬆⬆⬆ 部署新版本後端時,記得更新這段網址 ⬆⬆⬆

const form = document.getElementById("report-form");
const successBox = document.getElementById("success");
const caseIdEl = document.getElementById("case-id");
const coordsEl = document.getElementById("coords");
const locateBtn = document.getElementById("locate-btn");
const newReportBtn = document.getElementById("new-report");
const submitBtn = form.querySelector(".btn-primary");

let currentCoords = null; // { lat, lng }

// 使用瀏覽器定位填入經緯度
locateBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    coordsEl.textContent = "此瀏覽器不支援定位功能。";
    return;
  }
  coordsEl.textContent = "定位中…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      currentCoords = { lat: latitude, lng: longitude };
      coordsEl.textContent = `已取得座標:${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
    },
    (err) => {
      coordsEl.textContent = "無法取得定位:" + err.message;
    }
  );
});

// 產生通報編號,例如 ER-20260529-0432
function generateCaseId() {
  const now = new Date();
  const ymd =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0");
  const rand = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `ER-${ymd}-${rand}`;
}

// 送出表單
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const data = {
    caseId: generateCaseId(),
    type: form.type.value,
    severity: form.severity.value,
    location: form.location.value.trim(),
    coords: currentCoords,
    description: form.description.value.trim(),
    reporter: form.reporter.value.trim(),
    phone: form.phone.value.trim(),
    createdAt: new Date().toISOString(),
    status: "new",
  };

  // 在 localStorage 留一份備份
  const reports = JSON.parse(localStorage.getItem("reports") || "[]");
  reports.push(data);
  localStorage.setItem("reports", JSON.stringify(reports));

  // 送到後端
  submitBtn.disabled = true;
  submitBtn.textContent = "送出中…";

  try {
    if (BACKEND_URL) {
      await fetch(BACKEND_URL, {
        method: "POST",
        // 用 text/plain 可避免觸發 CORS 預檢,Apps Script 端會自行 JSON.parse
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(data),
      });
    } else {
      console.warn("尚未設定 BACKEND_URL,資料僅存於本機 localStorage。");
    }
    showSuccess(data.caseId);
  } catch (err) {
    console.error("送出失敗:", err);
    // 後端送出失敗,但本機已備份,仍提示成功並保留資料
    alert("網路傳送發生問題,資料已暫存於本機,請稍後確認網路再試一次。");
    showSuccess(data.caseId);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "送出通報";
  }
});

function showSuccess(caseId) {
  caseIdEl.textContent = caseId;
  form.classList.add("hidden");
  successBox.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// 再通報一筆
newReportBtn.addEventListener("click", () => {
  form.reset();
  currentCoords = null;
  coordsEl.textContent = "";
  successBox.classList.add("hidden");
  form.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
});
