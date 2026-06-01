// 緊急事件通報平台 — 前端邏輯
// 通報資料會送到 Google 試算表後端(透過 Apps Script Web App)。
// 同時也在瀏覽器 localStorage 留一份備份。

// ⬇⬇⬇ Google Apps Script 後端網址 ⬇⬇⬇
const BACKEND_URL = "https://script.google.com/macros/s/AKfycbx78IpesNsBvQGjJKFv7QC6EZi3NEGb4C-LUQba9MQV3amjyGLQA_rvCucYlfzposCp/exec";
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
   功能 2:定位 + 座標自動轉地址 + 自動判斷廠區
   ============================================================ */

// 廠區清單(日後新增廠區,在此加一行即可)
// name:廠區名稱;lat/lng:中心座標;radiusKm:判定半徑(公里)
const PLANTS = [
  { name: "台泥總處", lat: 25.060732692038076, lng: 121.52320323854713, radiusKm: 5 },
  { name: "蘇澳廠",   lat: 24.588467741184218, lng: 121.85271529537127, radiusKm: 5 },
  { name: "和平廠",   lat: 24.303298283183537, lng: 121.75188570645906, radiusKm: 5 },
];

// 計算兩個座標間的距離(公里),Haversine 公式
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // 地球半徑(公里)
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 找出座標所在(或最近且在判定半徑內)的廠區;找不到回傳 null
function detectPlant(lat, lng) {
  let best = null;
  for (const p of PLANTS) {
    const d = distanceKm(lat, lng, p.lat, p.lng);
    if (d <= p.radiusKm && (!best || d < best.dist)) {
      best = { name: p.name, dist: d };
    }
  }
  return best;
}

locateBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    coordsEl.textContent = "此瀏覽器不支援定位功能。";
    return;
  }
  coordsEl.textContent = "定位中…(請允許瀏覽器存取位置)";
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      currentCoords = { lat: latitude, lng: longitude };

      // 自動判斷廠區:5 公里內最近的廠區自動填入「廠區」欄(仍可手動修改)
      const plant = detectPlant(latitude, longitude);
      const plantInput = document.getElementById("plant");
      let plantMsg = "";
      if (plant && !plantInput.value.trim()) {
        plantInput.value = plant.name;
        plantMsg = ` · 🏭 ${plant.name}`;
      } else if (!plant) {
        plantMsg = " · 不在已知廠區範圍(請手動填廠區)";
      }

      coordsEl.textContent = `已取得座標:${latitude.toFixed(5)}, ${longitude.toFixed(5)},查詢地址中…`;
      const address = await reverseGeocode(latitude, longitude);
      if (address) {
        const locInput = document.getElementById("location");
        if (!locInput.value.trim()) locInput.value = address;
        coordsEl.textContent = `📍 ${address}(${latitude.toFixed(5)}, ${longitude.toFixed(5)})${plantMsg}`;
      } else {
        coordsEl.textContent = `已取得座標:${latitude.toFixed(5)}, ${longitude.toFixed(5)}(地址查詢失敗,請手動填寫)${plantMsg}`;
      }
    },
    (err) => {
      // 依錯誤代碼給出明確中文提示與解決方式
      let msg;
      switch (err.code) {
        case err.PERMISSION_DENIED:
          msg = "定位權限被拒。iPhone 請到「設定 → Chrome → 位置」開啟,並確認「設定 → 隱私權與安全性 → 定位服務」為開啟,再重試。";
          break;
        case err.POSITION_UNAVAILABLE:
          msg = "目前無法取得位置(可能室內收訊不佳)。請移動到收訊較好處,或手動輸入地點。";
          break;
        case err.TIMEOUT:
          msg = "定位逾時,請再按一次「定位」,或手動輸入地點。";
          break;
        default:
          msg = "無法取得定位:" + (err.message || "未知原因") + "。可手動輸入地點。";
      }
      coordsEl.textContent = "⚠️ " + msg;
    },
    {
      enableHighAccuracy: true, // 盡量用 GPS 取得較精確位置
      timeout: 15000,           // 最多等 15 秒
      maximumAge: 0             // 不使用快取的舊位置
    }
  );
});

// 用 OpenStreetMap Nominatim 把座標轉成地址(免費、免金鑰)
// 只取結構化欄位重組成「市區路門牌」的簡潔地址,去除別名、里、郵遞區號、國家等雜訊。
async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=zh-TW`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    return formatAddress(data) || data.display_name || null;
  } catch (err) {
    console.warn("反向地理編碼失敗:", err);
    return null;
  }
}

// 從 Nominatim 的結構化 address 物件,組出「市 + 區 + 路 + 門牌」的簡潔地址
function formatAddress(data) {
  const a = data && data.address;
  if (!a) return null;

  // 直轄市/縣市(不同地點欄位名稱可能不同,依序取第一個有值的)
  const city = a.city || a.county || a.state || a.town || "";
  // 行政區(區/鄉/鎮)
  const district = a.city_district || a.district || a.suburb ||
                   a.town || a.township || "";
  // 路 / 街
  const road = a.road || a.pedestrian || a.neighbourhood || "";
  // 門牌號(Nominatim 多半放在 house_number)
  const houseNumber = a.house_number ? a.house_number + "號" : "";

  // 依台灣習慣由大到小串接,去重、去空白
  const parts = [city, district, road, houseNumber].filter(Boolean);
  // 移除相鄰重複(例如 city 與 district 取到同一值)
  const dedup = parts.filter((v, i) => i === 0 || v !== parts[i - 1]);
  const result = dedup.join("");
  return result || null;
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
    plant: form.plant.value.trim(),
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

  try {
    if (BACKEND_URL) {
      // 用一般模式送出,讓前端能讀取後端回傳的 AI 分析結果。
      // Apps Script 部署為「任何人」時,回應為簡單請求,可正常讀取。
      const res = await fetch(BACKEND_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      showSuccess(data.caseId);
      // 後端回傳的 ai 物件:{ severity, guidance }
      showAiFeedback(result && result.ai ? result.ai : null);
    } else {
      console.warn("尚未設定 BACKEND_URL,資料僅存於本機 localStorage。");
      showSuccess(data.caseId);
    }
  } catch (err) {
    console.error("送出失敗:", err);
    alert("網路傳送發生問題,資料已暫存於本機,請稍後確認網路再試一次。");
    showSuccess(data.caseId);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "送出通報";
  }
});

// 顯示 AI 研判結果(severity:重大/一般;guidance:處置建議)
function showAiFeedback(ai) {
  const box = document.getElementById("ai-feedback");
  const loading = document.getElementById("ai-loading");
  const resultEl = document.getElementById("ai-result");
  const severityEl = document.getElementById("ai-severity");
  const guidanceEl = document.getElementById("ai-guidance");

  box.classList.remove("hidden");
  loading.classList.add("hidden");
  resultEl.classList.remove("hidden");

  const severity = ai && ai.severity ? ai.severity : "";
  const guidance = ai && ai.guidance ? ai.guidance : "";

  severityEl.textContent = severity || "無法判定";
  // 三級分級對應顏色:重大災害=紅、廠級事故=橘、一般事故=綠
  let sevClass = "unknown";
  if (severity === "重大災害") sevClass = "major";
  else if (severity === "廠級事故") sevClass = "mid";
  else if (severity === "一般事故") sevClass = "normal";
  severityEl.className = "ai-badge " + sevClass;

  guidanceEl.textContent = guidance || "(目前無建議內容)";
}

function showSuccess(caseId) {
  caseIdEl.textContent = caseId;
  // 先把 AI 區塊重設為「分析中」狀態(等回應到了再由 showAiFeedback 填入)
  const box = document.getElementById("ai-feedback");
  const loading = document.getElementById("ai-loading");
  const resultEl = document.getElementById("ai-result");
  box.classList.remove("hidden");
  loading.classList.remove("hidden");
  resultEl.classList.add("hidden");
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
  document.getElementById("ai-feedback").classList.add("hidden");
  successBox.classList.add("hidden");
  form.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
});
