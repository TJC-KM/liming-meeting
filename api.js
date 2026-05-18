// 資料層：可在 mock / 真實 API 之間切換
//
// 部署 Cloudflare Worker 之後，把 USE_MOCK 設為 false，
// 並把 API_URL 改成你的 Worker endpoint。

const CONFIG = {
  USE_MOCK: false,
  API_URL: 'https://church-meeting-api.c3012312.workers.dev',
};

const api = {
  async listMeetings() {
    if (CONFIG.USE_MOCK) {
      const r = await fetch('./mock-data.json');
      if (!r.ok) throw new Error('讀取 mock 資料失敗');
      return r.json();
    }
    const r = await fetch(`${CONFIG.API_URL}/meetings`);
    if (!r.ok) throw new Error(`API 錯誤：${r.status}`);
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
    if (!r.ok) throw new Error(`API 錯誤：${r.status}`);
    return r.json();
  },
};

// 共用工具
const ThemeManager = {
  KEY: 'church-meeting-theme',
  get() {
    const url = new URLSearchParams(location.search).get('theme');
    if (url && ['adult', 'senior', 'kids'].includes(url)) return url;
    return localStorage.getItem(this.KEY) || 'adult';
  },
  set(t) {
    localStorage.setItem(this.KEY, t);
  },
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

// 解析參考經文：每節以空行分隔，每節三行（reference / chinese / english）
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
