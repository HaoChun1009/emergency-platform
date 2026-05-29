// 緊急事件通報平台 — 前端邏輯
// 通報資料會送到 Google 試算表後端(透過 Apps Script Web App)。
// 同時也在瀏覽器 localStorage 留一份備份。

// ⬇⬇⬇ Google Apps Script 後端網址 ⬇⬇⬇
const BACKEND_URL = "https://script.google.com/macros/s/AKfycbzhMa8_FULZGEoTPnS6nqIsNPCbO3VZBy5a8r56yNnuZyyX-E8wWQPzL02J1XC4XJiw/exec";
// ⬆⬆⬆ 部署新版本後端時,記得更新這段網址 ⬆⬆⬆

// 照片上傳開關:後端已更新並重新部署(含雲端硬碟儲存),正式啟用。
const PHOTO_UPLOAD_ENABLED = true;

const form = document.getElementById("report-form");
const successBox = document.getElementById("success");
const caseIdEl = document.getElementById("case-id");
const coordsEl = document.getElementById("coords");
const locateBtn = document.getElementById("locate-btn");
const newReportBtn = document.getElementById("new-report");
const submitBtn = form.querySelector(".btn-primary");
const typeSelect = document.getElementById("type");
const dynamicFields = document.getElementById("dynamic-fields");
const descriptionEl = document.getElementById("description");
const voiceBtn = document.getElementById("voice-btn");
const voiceStatus = document.getElementById("voice-status");
const photosInput = document.getElementById("photos");
const photoPreview = document.getElementById("photo-preview");

let currentCoords = null; // { lat, lng }
let selectedPhotos = []; // [{ name, dataUrl }]

/* ============================================================
   功能 1:依事件類型顯示對應的災損樣態欄位
   ============================================================ */

const DYNAMIC_FIELD_CONFIG = {
  fire: [
    { name: "trapped", label: "是否有人受困?", type: "select", options: ["不確定", "無", "有"] },
    { name: "smoke", label: "煙霧/火勢狀況", type: "text", placeholder: "例如:濃煙竄出、火勢延燒中" },
  ],
  medical: [
    { name: "conscious", label: "傷患意識狀態", type: "select", options: ["不確定", "清醒", "昏迷", "無呼吸"] },
    { name: "injuredCount", label: "傷患人數", type: "text", placeholder: "例如:1 人" },
  ],
  accident: [
    { name: "vehicles", label: "涉及車輛", type: "text", placeholder: "例如:轎車 1、機車 1" },
    { name: "injured", label: "是否有人受傷?", type: "select", options: ["不確定", "無", "有"] },
  ],
  crime: [
    { name: "ongoing", label: "事件是否進行中?", type: "select", options: ["不確定", "已結束", "進行中"] },
    { name: "suspect", label: "可疑人/車特徵", type: "text", placeholder: "外觀、衣著、車牌等" },
  ],
  disaster: [
    { name: "disasterType", label: "災害種類", type: "text", placeholder: "例如:淹水、土石、地震受損" },
    { name: "affected", label: "影響範圍", type: "text", placeholder: "例如:整條巷弄、約 5 戶" },
  ],
  infrastructure: [
    { name: "facility", label: "設施種類", type: "text", placeholder: "例如:路燈、橋梁、瓦斯管線" },
    { name: "risk", label: "立即危險性", type: "select", options: ["不確定", "低", "中", "高"] },
  ],
  other: [],
};

function renderDynamicFields(type) {
  dynamicFields.innerHTML = "";
  const config = DYNAMIC_FIELD_CONFIG[type] || [];
  config.forEach((f) => {
    const wrap = document.createElement("div");
    wrap.className = "field";

    const label = document.createElement("label");
    label.textContent = f.label;
    label.setAttribute("for", "dyn-" + f.name);
    wrap.appendChild(label);

    let input;
    if (f.type === "select") {
      input = document.createElement("select");
      f.options.forEach((opt) => {
        const o = document.createElement("option");
        o.value = opt;
        o.textContent = opt;
        input.appendChild(o);
      });
    } else {
      input = document.createElement("input");
      input.type = "text";
      if (f.placeholder) input.placeholder = f.placeholder;
    }
    input.id = "dyn-" + f.name;
    input.name = "dyn-" + f.name;
    input.dataset.dynLabel = f.label;
    wrap.appendChild(input);

    dynamicFields.appendChild(wrap);
  });
}

typeSelect.addEventListener("change", () => renderDynamicFields(typeSelect.value));

function collectDynamicData() {
  const result = {};
  dynamicFields.querySelectorAll("input, select").forEach((el) => {
    const val = el.value.trim();
    if (val && val !== "不確定") {
      result[el.dataset.dynLabel] = val;
    }
  });
  return result;
}

/* ============================================================
   功能 2:定位 + 座標自動轉地址(反向地理編碼)
   ============================================================ */

locateBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    coordsEl.textContent = "此瀏覽器不支援定位功能。";
    return;
  }
  coordsEl.textContent = "定位中…";
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      currentCoords = { lat: latitude, lng: longitude };
      coordsEl.textContent = `已取得座標:${latitude.toFixed(5)}, ${longitude.toFixed(5)},查詢地址中…`;
      const address = await reverseGeocode(latitude, longitude);
      if (address) {
        const locInput = document.getElementById("location");
        if (!locInput.value.trim()) locInput.value = address;
        coordsEl.textContent = `📍 ${address}(${latitude.toFixed(5)}, ${longitude.toFixed(5)})`;
      } else {
        coordsEl.textContent = `已取得座標:${latitude.toFixed(5)}, ${longitude.toFixed(5)}(地址查詢失敗,請手動填寫)`;
      }
    },
    (err) => {
      coordsEl.textContent = "無法取得定位:" + err.message;
    }
  );
});

// 用 OpenStreetMap Nominatim 把座標轉成地址(免費、免金鑰)
async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=zh-TW`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    return data.display_name || null;
  } catch (err) {
    console.warn("反向地理編碼失敗:", err);
    return null;
  }
}

/* ============================================================
   功能 3:語音轉文字(Web Speech API)
   ============================================================ */

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isListening = false;
let baseText = ""; // 開始辨識前已有的文字

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.lang = "zh-TW";
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.addEventListener("result", (e) => {
    let finalText = "";
    let interimText = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const transcript = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += transcript;
      else interimText += transcript;
    }
    if (finalText) baseText += finalText;
    descriptionEl.value = (baseText + interimText).trim();
  });

  recognition.addEventListener("end", () => {
    isListening = false;
    voiceBtn.classList.remove("recording");
    voiceBtn.textContent = "🎤 語音輸入";
    voiceStatus.textContent = "";
  });

  recognition.addEventListener("error", (e) => {
    isListening = false;
    voiceBtn.classList.remove("recording");
    voiceBtn.textContent = "🎤 語音輸入";
    if (e.error === "not-allowed") {
      voiceStatus.textContent = "麥克風權限被拒,請允許後再試。";
    } else if (e.error === "no-speech") {
      voiceStatus.textContent = "沒有聽到聲音,請再試一次。";
    } else {
      voiceStatus.textContent = "語音辨識發生問題:" + e.error;
    }
  });

  voiceBtn.addEventListener("click", () => {
    if (isListening) {
      recognition.stop();
      return;
    }
    baseText = descriptionEl.value ? descriptionEl.value + " " : "";
    try {
      recognition.start();
      isListening = true;
      voiceBtn.classList.add("recording");
      voiceBtn.textContent = "⏹ 停止";
      voiceStatus.textContent = "聆聽中…請開始說話";
    } catch (err) {
      console.warn(err);
    }
  });
} else {
  if (voiceBtn) voiceBtn.style.display = "none";
}

/* ============================================================
   功能 4:現場照片(壓縮 + 預覽 + 隨通報上傳)
   ============================================================ */

const MAX_PHOTOS = 5;
const MAX_DIMENSION = 1280; // 壓縮後最長邊
const JPEG_QUALITY = 0.7;

photosInput.addEventListener("change", async () => {
  const files = Array.from(photosInput.files || []);
  for (const file of files) {
    if (selectedPhotos.length >= MAX_PHOTOS) {
      alert(`最多上傳 ${MAX_PHOTOS} 張照片。`);
      break;
    }
    if (!file.type.startsWith("image/")) continue;
    try {
      const dataUrl = await compressImage(file);
      selectedPhotos.push({ name: file.name, dataUrl });
    } catch (err) {
      console.warn("照片壓縮失敗:", file.name, err);
    }
  }
  photosInput.value = ""; // 清空以便可重複選同一檔
  renderPhotoPreview();
});

// 用 canvas 壓縮圖片,輸出 JPEG dataURL
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > MAX_DIMENSION) {
          height = Math.round((height * MAX_DIMENSION) / width);
          width = MAX_DIMENSION;
        } else if (height > MAX_DIMENSION) {
          width = Math.round((width * MAX_DIMENSION) / height);
          height = MAX_DIMENSION;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function renderPhotoPreview() {
  photoPreview.innerHTML = "";
  selectedPhotos.forEach((photo, index) => {
    const thumb = document.createElement("div");
    thumb.className = "photo-thumb";

    const img = document.createElement("img");
    img.src = photo.dataUrl;
    thumb.appendChild(img);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "×";
    remove.title = "移除這張";
    remove.addEventListener("click", () => {
      selectedPhotos.splice(index, 1);
      renderPhotoPreview();
    });
    thumb.appendChild(remove);

    photoPreview.appendChild(thumb);
  });
}

/* ============================================================
   送出表單
   ============================================================ */

function generateCaseId() {
  const now = new Date();
  const ymd =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0");
  const rand = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `ER-${ymd}-${rand}`;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const dynamicData = collectDynamicData();

  let fullDescription = form.description.value.trim();
  const dynamicSummary = Object.entries(dynamicData)
    .map(([k, v]) => `${k}:${v}`)
    .join("、");
  if (dynamicSummary) {
    fullDescription += `\n【補充】${dynamicSummary}`;
  }

  const data = {
    caseId: generateCaseId(),
    type: form.type.value,
    severity: form.severity.value,
    location: form.location.value.trim(),
    coords: currentCoords,
    description: fullDescription,
    details: dynamicData,
    reporter: form.reporter.value.trim(),
    phone: form.phone.value.trim(),
    photos: PHOTO_UPLOAD_ENABLED ? selectedPhotos : [], // 後端就緒前不送照片
    createdAt: new Date().toISOString(),
    status: "new",
  };

  // localStorage 備份不含照片(體積大,避免塞爆),其餘照存
  const { photos, ...dataWithoutPhotos } = data;
  const reports = JSON.parse(localStorage.getItem("reports") || "[]");
  reports.push(dataWithoutPhotos);
  try {
    localStorage.setItem("reports", JSON.stringify(reports));
  } catch (err) {
    console.warn("localStorage 備份失敗(可能已滿):", err);
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "送出中…";

  // 版本標記,方便確認瀏覽器是否載入最新程式(對照 console)
  console.log("送出程式版本:v5 no-cors,照片數:", data.photos.length);

  try {
    if (BACKEND_URL) {
      // 用 no-cors 送出:請求會送達後端,但瀏覽器基於跨網域規則不讓我們讀回應。
      // 對「只送資料、不需讀回傳」的情境這樣最穩,不會誤判失敗。
      await fetch(BACKEND_URL, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(data),
      });
    } else {
      console.warn("尚未設定 BACKEND_URL,資料僅存於本機 localStorage。");
    }
    showSuccess(data.caseId);
  } catch (err) {
    console.error("送出失敗:", err);
    // 暫時把真正的錯誤內容顯示出來,方便診斷
    alert("送出發生問題(診斷用):\n" + (err && err.message ? err.message : err) +
          "\n\n資料已暫存於本機。");
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

newReportBtn.addEventListener("click", () => {
  form.reset();
  currentCoords = null;
  selectedPhotos = [];
  photoPreview.innerHTML = "";
  coordsEl.textContent = "";
  voiceStatus.textContent = "";
  dynamicFields.innerHTML = "";
  successBox.classList.add("hidden");
  form.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
});
