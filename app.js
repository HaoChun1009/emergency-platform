// 緊急事件通報平台 — 前端邏輯(原型版)
// 目前資料暫存於瀏覽器 localStorage,之後可改接後端 API。

const form = document.getElementById("report-form");
const successBox = document.getElementById("success");
const caseIdEl = document.getElementById("case-id");
const coordsEl = document.getElementById("coords");
const locateBtn = document.getElementById("locate-btn");
const newReportBtn = document.getElementById("new-report");

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
form.addEventListener("submit", (e) => {
  e.preventDefault();

  // 原生驗證
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

  // 暫存到 localStorage(之後改為 fetch POST 到後端)
  const reports = JSON.parse(localStorage.getItem("reports") || "[]");
  reports.push(data);
  localStorage.setItem("reports", JSON.stringify(reports));

  // 顯示成功畫面
  caseIdEl.textContent = data.caseId;
  form.classList.add("hidden");
  successBox.classList.remove("hidden");

  console.log("已儲存通報:", data);
});

// 再通報一筆
newReportBtn.addEventListener("click", () => {
  form.reset();
  currentCoords = null;
  coordsEl.textContent = "";
  successBox.classList.add("hidden");
  form.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
});
