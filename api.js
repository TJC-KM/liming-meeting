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
  // 共用 liming-news2026 的留言 GAS Web App（同一張 Google Sheet）
  COMMENTS_GAS_URL: 'https://script.google.com/macros/s/AKfycbzWzh7mEl9wt7ehw7SWLQpwpJlbRB6AoDhSiFSex7YC2sp92ceICPct4AO64LiyN8lbPg/exec',
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

// === Worker 端（Drive 掃描 + 處理觸發；取代原本的 GAS）===
// 變數名稱保留為 gasApi 是因為現有 app.js 還用這個名字呼叫，純向後相容
const gasApi = {
  enabled() {
    return !!CONFIG.API_URL;
  },

  async listUnprocessed(year, month) {
    const params = new URLSearchParams({ year: String(year), month: String(month) });
    const r = await fetch(`${CONFIG.API_URL}/drive/list?${params}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`Worker HTTP ${r.status}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    return data;
  },

  async process(date, type) {
    const params = new URLSearchParams({ date, type });
    const r = await fetch(`${CONFIG.API_URL}/drive/process?${params}`, {
      method: 'POST',
      cache: 'no-store',
      keepalive: true,
    }).catch(err => {
      console.warn('[process fetch]', err.message);
      return null;
    });
    if (!r) return { success: true, queued: true };
    let data;
    try {
      const text = await r.text();
      data = text ? JSON.parse(text) : { success: true, queued: true };
    } catch (e) {
      data = { success: true, queued: true };
    }
    if (data.error && !data.success) throw new Error(data.error);
    return data;
  },

  // 列出所有預查文件（快速，含估計日期）
  async listStudy() {
    const r = await fetch(`${CONFIG.API_URL}/study/list`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`Worker HTTP ${r.status}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    return data;
  },

  // 處理單篇預查
  async processStudy(fileId) {
    const r = await fetch(`${CONFIG.API_URL}/study/process?fileId=${encodeURIComponent(fileId)}`, {
      method: 'POST',
      cache: 'no-store',
      keepalive: true,
    }).catch(err => {
      console.warn('[processStudy fetch]', err.message);
      return null;
    });
    if (!r) return { success: true, queued: true };
    let data;
    try {
      const text = await r.text();
      data = text ? JSON.parse(text) : { success: true, queued: true };
    } catch (e) {
      data = { success: true, queued: true };
    }
    if (data.error && !data.success) throw new Error(data.error);
    return data;
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
// 字級主題：正常版 (adult) / 大字版 (senior)
// 舊的 kids 值自動遷移成 adult
const ThemeManager = {
  KEY: 'church-meeting-theme',
  get() {
    const url = new URLSearchParams(location.search).get('theme');
    if (url && ['adult', 'senior'].includes(url)) return url;
    let v = localStorage.getItem(this.KEY);
    if (v === 'kids') { v = 'adult'; localStorage.setItem(this.KEY, v); }  // 遷移
    return v || 'adult';
  },
  set(t) { localStorage.setItem(this.KEY, t); },
  apply(t, containerId) {
    // 字級類別：adult 不加 class（預設），senior 加 .senior
    const el = document.getElementById(containerId);
    if (!el) return;
    el.classList.remove('senior');
    if (t === 'senior') el.classList.add('senior');
  },
};

// 裝置主題：手機 (mobile) / 電腦 (desktop)
// 首次進入：螢幕寬 >= 900 → desktop，否則 mobile
const DeviceManager = {
  KEY: 'church-meeting-device',
  get() {
    const url = new URLSearchParams(location.search).get('device');
    if (url && ['mobile', 'desktop'].includes(url)) return url;
    const stored = localStorage.getItem(this.KEY);
    if (stored && ['mobile', 'desktop'].includes(stored)) return stored;
    return (typeof window !== 'undefined' && window.innerWidth >= 900) ? 'desktop' : 'mobile';
  },
  set(d) { localStorage.setItem(this.KEY, d); },
  apply(d, containerId) {
    // 裝置類別：mobile 不加 class（預設），desktop 加 .desktop
    const el = document.getElementById(containerId);
    if (!el) return;
    el.classList.remove('desktop');
    if (d === 'desktop') el.classList.add('desktop');
  },
};

// 配色主題：light / dark（影響背景色）
const ColorThemeManager = {
  KEY: 'church-meeting-color',
  get() {
    return localStorage.getItem(this.KEY) || 'light';
  },
  set(c) { localStorage.setItem(this.KEY, c); },
  apply(c) {
    document.documentElement.classList.toggle('dark', c === 'dark');
  },
};

const SUN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
const MOON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

function renderThemeSwitcher(currentSize, currentColor, currentDevice) {
  currentColor = currentColor || ColorThemeManager.get();
  currentDevice = currentDevice || DeviceManager.get();
  return `
    <div class="theme-switcher" id="themeSwitcher">
      <div class="theme-group">
        <button class="theme-btn ${currentSize === 'adult' ? 'active' : ''}" data-t="adult">正常版</button>
        <button class="theme-btn ${currentSize === 'senior' ? 'active' : ''}" data-t="senior">大字版</button>
      </div>
      <div class="theme-group">
        <button class="theme-btn ${currentDevice === 'mobile' ? 'active' : ''}" data-d="mobile">手機版</button>
        <button class="theme-btn ${currentDevice === 'desktop' ? 'active' : ''}" data-d="desktop">電腦版</button>
      </div>
      <div class="theme-group">
        <button class="theme-btn theme-btn-icon ${currentColor === 'light' ? 'active' : ''}" data-c="light" title="淺色">${SUN_SVG}</button>
        <button class="theme-btn theme-btn-icon ${currentColor === 'dark' ? 'active' : ''}" data-c="dark" title="深色">${MOON_SVG}</button>
      </div>
    </div>
  `;
}

function bindThemeSwitcher(containerId, onChange) {
  const sw = document.getElementById('themeSwitcher');
  if (!sw) return;
  sw.addEventListener('click', function (e) {
    const b = e.target.closest('.theme-btn');
    if (!b) return;

    if (b.dataset.t) {
      // 字級主題
      sw.querySelectorAll('[data-t]').forEach(t => t.classList.remove('active'));
      b.classList.add('active');
      const t = b.dataset.t;
      ThemeManager.set(t);
      ThemeManager.apply(t, containerId);
      if (onChange) onChange({ size: t });
    } else if (b.dataset.d) {
      // 裝置主題
      sw.querySelectorAll('[data-d]').forEach(d => d.classList.remove('active'));
      b.classList.add('active');
      const d = b.dataset.d;
      DeviceManager.set(d);
      DeviceManager.apply(d, containerId);
      if (onChange) onChange({ device: d });
    } else if (b.dataset.c) {
      // 配色主題
      sw.querySelectorAll('[data-c]').forEach(c => c.classList.remove('active'));
      b.classList.add('active');
      const c = b.dataset.c;
      ColorThemeManager.set(c);
      ColorThemeManager.apply(c);
    }
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
