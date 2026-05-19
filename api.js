// 資料層
//
// 兩個後端：
//   1. Cloudflare Worker（讀 Notion）— 列表 + 詳細
//   2. GAS Web App（讀 Drive + 觸發轉檔）— 列出未處理錄音 / 處理單一檔案
//
// 部署後填入 GAS_URL。

const CONFIG = {
  USE_MOCK: false,
  API_URL: 'https://church-meeting-api.c3012312.workers.dev',
  GAS_URL: 'https://script.google.com/macros/s/AKfycbwvdpxMqKCtpcDf6dzjvprv46kNS1Gwj0C1fPdQO7dTfTOQquvzPEZL5_aYeAYUUMs/exec',
};

// === Notion 端（Worker proxy）===
const api = {
  async listMeetings() {
    if (CONFIG.USE_MOCK) {
      const r = await fetch('./mock-data.json');
      if (!r.ok) throw new Error('讀取 mock 資料失敗');
      return r.json();
    }
    const r = await fetch(`${CONFIG.API_URL}/meetings`);
    if (!r.ok) throw new Error(`Worker 錯誤：${r.status}`);
    return r.json();
  },

  async getMeeting(id) {
    if (CONFIG.USE_MOCK) {
      const r = await fetch('./mock-data.json');
      if (!r.ok) throw new Error('讀取 mock 資料失敗');
      const data = await r.json();
      const m = data.meetings.find(x => x.id === id);
      if (!m) throw new Error('找不到聚會紀錄');
      return m;
    }
    const r = await fetch(`${CONFIG.API_URL}/meetings/${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error(`Worker 錯誤：${r.status}`);
    return r.json();
  },
};

// === GAS 端（Drive 掃描 + 處理觸發）===
const gasApi = {
  enabled() {
    return !!CONFIG.GAS_URL;
  },

  async _post(payload) {
    if (!CONFIG.GAS_URL) throw new Error('GAS_URL 未設定');
    const body = new URLSearchParams({ data: JSON.stringify(payload) });
    const r = await fetch(CONFIG.GAS_URL, {
      method: 'POST',
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'follow',
    });
    if (!r.ok) throw new Error(`GAS HTTP ${r.status}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    return data;
  },

  // 取得指定年月的錄音檔清單（推薦用法，比掃整個 Drive 快上百倍）
  // 若不傳 year/month，預設只回近 30 天上傳的
  async listUnprocessed(year, month) {
    const payload = { action: 'list' };
    if (year && month) {
      payload.year = year;
      payload.month = month;
    }
    return this._post(payload);
  },

  async process(date, type) {
    return this._post({ action: 'process', date: date, type: type });
  },
};

// === 客戶端快取（sessionStorage，5 分鐘 TTL）===
const DriveCache = {
  TTL_MS: 5 * 60 * 1000,
  _key(year, month) { return `drive_${year}_${month}`; },

  get(year, month) {
    try {
      const raw = sessionStorage.getItem(this._key(year, month));
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (Date.now() - obj.t > this.TTL_MS) return null;
      return obj.files;
    } catch (e) { return null; }
  },

  set(year, month, files) {
    try {
      sessionStorage.setItem(this._key(year, month), JSON.stringify({ t: Date.now(), files }));
    } catch (e) { /* sessionStorage 滿了就略過 */ }
  },

  invalidate(year, month) {
    try { sessionStorage.removeItem(this._key(year, month)); } catch (e) {}
  },

  invalidateAll() {
    try {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const key = sessionStorage.key(i);
        if (key && key.startsWith('drive_')) sessionStorage.removeItem(key);
      }
    } catch (e) {}
  },
};

// === 共用工具 ===
const ThemeManager = {
  KEY: 'church-meeting-theme',
  get() {
    const url = new URLSearchParams(location.search).get('theme');
    if (url && ['adult', 'senior', 'kids'].includes(url)) return url;
    return localStorage.getItem(this.KEY) || 'adult';
  },
  set(t) { localStorage.setItem(this.KEY, t); },
  apply(t, containerId) {
    const el = document.getElementById(containerId);
    if (el) el.className = 'container ' + (t === 'adult' ? '' : t);
  },
};

function renderThemeSwitcher(current) {
  return `
    <div class="theme-switcher" id="themeSwitcher">
      <button class="theme-btn ${current === 'adult' ? 'active' : ''}" data-t="adult">成人版</button>
      <button class="theme-btn ${current === 'senior' ? 'active' : ''}" data-t="senior">長輩版</button>
      <button class="theme-btn ${current === 'kids' ? 'active' : ''}" data-t="kids">兒童版</button>
    </div>
  `;
}

function bindThemeSwitcher(containerId, onChange) {
  const sw = document.getElementById('themeSwitcher');
  if (!sw) return;
  sw.addEventListener('click', function (e) {
    const b = e.target.closest('.theme-btn');
    if (!b) return;
    document.querySelectorAll('.theme-btn').forEach(t => t.classList.remove('active'));
    b.classList.add('active');
    const t = b.dataset.t;
    ThemeManager.set(t);
    ThemeManager.apply(t, containerId);
    if (onChange) onChange(t);
  });
}

// 解析參考經文：每節以空行分隔，每節三行
function parseVerses(text) {
  if (!text) return [];
  return text.split(/\n\s*\n/).map(block => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    const refMatch = lines[0].match(/^【(.+?)】$/);
    return {
      ref: refMatch ? refMatch[1] : lines[0],
      chinese: lines[1] || '',
      english: lines.slice(2).join(' ') || '',
    };
  }).filter(Boolean);
}

function formatDate(iso) {
  if (!iso) return { y: '', m: '', d: '', dow: '', full: '' };
  const dt = new Date(iso);
  const DOW = ['日', '一', '二', '三', '四', '五', '六'];
  return {
    y: dt.getFullYear(),
    m: dt.getMonth() + 1,
    d: dt.getDate(),
    dow: DOW[dt.getDay()],
    full: `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()} (週${DOW[dt.getDay()]})`,
    raw: dt,
  };
}

const DOW_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
