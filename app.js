// 列表頁：行事曆視圖
// Notion 資料一次抓全部，Drive 資料按月份懶載入（搭配 sessionStorage 快取）

const SCHEDULE = {
  2: ['週二晚間'],
  3: ['週三晚間'],
  5: ['週五晚間'],
  6: ['安息日上午', '安息日晚間'],
};

const ALL_TYPES = ['週二晚間', '週三晚間', '週五晚間', '安息日上午', '安息日晚間', '主日聚會'];

var state = {
  notionMeetings: [],
  driveFiles: [],           // 目前選擇月份的 Drive 檔案
  filter: 'all',
  sq: '',
  sy: null,
  sm: null,                 // null = 全年；0-11 = 月份
  theme: ThemeManager.get(),
  loading: true,
  loadingDrive: false,
  driveError: null,
  processing: {},
};

function init() {
  document.getElementById('themeSlot').innerHTML = renderThemeSwitcher(state.theme);
  ThemeManager.apply(state.theme, 'app');
  bindThemeSwitcher('app', function (t) { state.theme = t; render(); });

  loadInitial();
}

async function loadInitial() {
  state.loading = true;
  render();

  try {
    const result = await api.listMeetings();
    state.notionMeetings = (result.meetings || []).map(function (m) {
      const d = formatDate(m.date);
      return Object.assign({}, m, {
        year: d.y, month: d.m, day: d.d, dow: d.dow,
        dateKey: m.date ? m.date.substring(0, 10) : '',
      });
    });

    // 預設選擇當月
    const now = new Date();
    state.sy = now.getFullYear();
    state.sm = now.getMonth();
    state.loading = false;
    render();  // Notion 資料先顯示

    // 然後背景載入當月的 Drive 資料
    loadDriveForMonth(state.sy, state.sm);
  } catch (err) {
    state.loading = false;
    document.getElementById('root').innerHTML = '<div class="empty">載入失敗：' + err.message + '</div>';
  }
}

async function loadDriveForMonth(year, month0) {
  if (!gasApi.enabled()) return;

  const m1 = month0 + 1;  // 1-12

  // 先看快取
  const cached = DriveCache.get(year, m1);
  if (cached) {
    state.driveFiles = cached.filter(f => f.parseable);
    state.loadingDrive = false;
    state.driveError = null;
    render();
    return;
  }

  state.loadingDrive = true;
  state.driveError = null;
  render();

  try {
    const result = await gasApi.listUnprocessed(year, m1);
    const files = result.files || [];
    DriveCache.set(year, m1, files);
    // 確認使用者沒切到其他月份才更新
    if (state.sy === year && state.sm === month0) {
      state.driveFiles = files.filter(f => f.parseable);
      state.loadingDrive = false;
      render();
    }
  } catch (err) {
    if (state.sy === year && state.sm === month0) {
      state.driveError = err.message;
      state.loadingDrive = false;
      render();
    }
  }
}

function selectMonth(year, month0) {
  state.sy = year;
  state.sm = month0;
  state.driveFiles = [];  // 清舊資料
  render();
  if (month0 !== null) loadDriveForMonth(year, month0);
}

function selectYear(year) {
  state.sy = year;
  state.sm = null;
  state.driveFiles = [];
  render();
  // 全年模式不抓 Drive
}

// === 行事曆生成 ===

function buildRowsForMonth(year, month0) {
  const rows = [];
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(year, month0, d);
    const dow = dt.getDay();
    const expected = SCHEDULE[dow] || [];
    expected.forEach(function (type) {
      rows.push({ year: year, month: month0 + 1, day: d, dow: dow, type: type });
    });
  }
  return rows;
}

function enrichRow(slot) {
  const dateKey = `${slot.year}-${pad2(slot.month)}-${pad2(slot.day)}`;

  const notion = state.notionMeetings.find(function (m) {
    return m.dateKey === dateKey && m.type === slot.type;
  });
  if (notion) return Object.assign({}, slot, notion, { _state: 'filled' });

  const drive = state.driveFiles.find(function (f) {
    return f.date === dateKey && f.type === slot.type;
  });
  if (drive) return Object.assign({}, slot, { _state: 'pending', driveFile: drive });

  const now = new Date();
  const slotDate = new Date(slot.year, slot.month - 1, slot.day);
  const isFuture = slotDate > now;
  return Object.assign({}, slot, { _state: isFuture ? 'future' : 'empty' });
}

function addSpecialEvents(rows, year, month0) {
  const seen = new Set(rows.filter(r => r.id).map(r => r.id));
  state.notionMeetings.forEach(function (m) {
    if (!m.date) return;
    if (m.year !== year || m.month !== month0 + 1) return;
    if (seen.has(m.id)) return;
    rows.push(Object.assign({}, m, {
      year: m.year, month: m.month, day: m.day, dow: m.dow,
      _state: 'filled', _special: true,
    }));
  });
}

function getRows() {
  let rows = [];
  if (state.sm !== null) {
    rows = buildRowsForMonth(state.sy, state.sm).map(enrichRow);
    addSpecialEvents(rows, state.sy, state.sm);
  } else {
    // 全年模式：只顯示 Notion 既有的紀錄（不顯示空 slot，避免 12 個月 × 28 slot 太多）
    rows = state.notionMeetings
      .filter(m => m.year === state.sy)
      .map(m => Object.assign({}, m, { _state: 'filled' }));
  }

  rows.sort(function (a, b) {
    if (a.year !== b.year) return b.year - a.year;
    if (a.month !== b.month) return b.month - a.month;
    if (a.day !== b.day) return b.day - a.day;
    return ALL_TYPES.indexOf(a.type) - ALL_TYPES.indexOf(b.type);
  });

  if (state.filter !== 'all') {
    rows = rows.filter(r => r.type === state.filter);
  }
  if (state.sq) {
    const q = state.sq.toLowerCase();
    rows = rows.filter(function (r) {
      return (r.topic || '').toLowerCase().indexOf(q) >= 0
        || (r.speaker || '').indexOf(q) >= 0
        || (r.type || '').indexOf(q) >= 0;
    });
  }
  return rows;
}

function getYears() {
  const set = new Set([new Date().getFullYear()]);
  state.notionMeetings.forEach(m => m.year && set.add(m.year));
  return Array.from(set).sort((a, b) => b - a);
}

function getMonthCounts() {
  const c = []; for (let i = 0; i < 12; i++) c.push(0);
  state.notionMeetings.forEach(function (m) {
    if (m.year === state.sy && m.month) c[m.month - 1]++;
  });
  return c;
}

function render() {
  if (state.loading) {
    document.getElementById('root').innerHTML = '<div class="loading">載入中...</div>';
    return;
  }

  const rows = getRows();
  const years = getYears();
  const mc = getMonthCounts();

  const filled = rows.filter(r => r._state === 'filled').length;
  const pending = rows.filter(r => r._state === 'pending').length;

  let h = '';

  h += '<div class="search-wrap"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
  h += '<input class="search" type="text" placeholder="搜尋主題、講員..." value="' + escapeAttr(state.sq) + '" id="si"></div>';

  h += '<div class="filters" id="ft"><button class="chip ' + (state.filter === 'all' ? 'active' : '') + '" data-f="all">全部</button>';
  ALL_TYPES.forEach(function (t) {
    h += '<button class="chip ' + (state.filter === t ? 'active' : '') + '" data-f="' + t + '">' + t + '</button>';
  });
  h += '</div>';

  if (years.length > 0) {
    h += '<div class="nav-row" id="yn"><span class="nav-label">年份</span>';
    years.forEach(function (y) {
      h += '<button class="nav-btn ' + (state.sy === y ? 'active' : '') + '" data-y="' + y + '">' + y + '</button>';
    });
    h += '</div>';
  }

  h += '<div class="nav-row" id="mn"><span class="nav-label">月份</span><button class="nav-btn ' + (state.sm === null ? 'active' : '') + '" data-m="x">全年</button>';
  for (let i = 11; i >= 0; i--) {
    h += '<button class="nav-btn ' + (state.sm === i ? 'active' : '') + '" data-m="' + i + '">' + (i + 1) + '月';
    if (mc[i] > 0) h += '<span class="cnt">' + mc[i] + '</span>';
    h += '</button>';
  }
  h += '</div>';

  h += '<div class="stats">';
  if (state.sm !== null) {
    h += '<span class="s-item">本月 <strong>' + rows.length + '</strong> 場聚會</span>';
  } else {
    h += '<span class="s-item">全年 <strong>' + rows.length + '</strong> 筆紀錄</span>';
  }
  h += '<span class="s-item"><span class="dot-pub"></span>已紀錄 ' + filled + '</span>';
  if (gasApi.enabled() && state.sm !== null) {
    if (state.loadingDrive) {
      h += '<span class="s-item" style="color:var(--tx3)">⏳ 載入錄音檔...</span>';
    } else if (state.driveError) {
      h += '<span class="s-item" style="color:var(--warn-tx)">⚠ 錄音檔載入失敗：' + escapeHtml(state.driveError) + '</span>';
    } else {
      h += '<span class="s-item"><span class="dot-up"></span>待處理 ' + pending + '</span>';
    }
  }
  h += '</div>';

  if (rows.length === 0) {
    h += '<div class="empty">找不到符合條件的聚會紀錄</div>';
  } else {
    h += '<div class="list" id="ml">';
    rows.forEach(function (r) {
      h += renderRow(r);
    });
    h += '</div>';
  }

  document.getElementById('root').innerHTML = h;
  bindEvents();
}

function renderRow(r) {
  const st = r._state;
  const procKey = `${r.year}-${pad2(r.month)}-${pad2(r.day)}_${r.type}`;
  const isProcessing = !!state.processing[procKey];

  let badgeClass, badgeText, clickable = false, action = '';

  if (st === 'filled') {
    badgeClass = r.status === '已發布' ? 'badge-pub' : r.status === '預告' ? 'badge-up' : 'badge-draft';
    badgeText = r.status || '已紀錄';
    clickable = true;
    action = `data-action="open" data-id="${escapeAttr(r.id)}"`;
  } else if (st === 'pending') {
    badgeClass = 'badge-pending';
    badgeText = isProcessing ? '處理中...' : '待處理';
    clickable = !isProcessing && gasApi.enabled();
    action = `data-action="process" data-date="${r.year}-${pad2(r.month)}-${pad2(r.day)}" data-type="${escapeAttr(r.type)}"`;
  } else if (st === 'future') {
    badgeClass = 'badge-future';
    badgeText = '預定';
  } else {
    badgeClass = 'badge-empty';
    badgeText = '無紀錄';
  }

  const rowClass = [
    'row',
    `row-${st}`,
    isProcessing ? 'row-processing' : '',
    clickable ? 'row-clickable' : 'row-static',
  ].filter(Boolean).join(' ');

  let h = `<div class="${rowClass}" ${action}>`;
  h += `<div class="date-col"><div class="date-day">${r.day}</div><div class="date-mon">${r.month}月</div></div>`;
  h += '<div class="info">';

  const displayTopic = (st === 'filled' ? r.topic : null)
                    || (r.driveFile ? r.driveFile.topic : null);

  if (displayTopic) {
    h += `<div class="info-title">${escapeHtml(displayTopic)}</div>`;
  } else {
    h += `<div class="info-title info-title-empty">${escapeHtml(r.type)}</div>`;
  }

  const displaySpeaker = (st === 'filled' ? r.speaker : null)
                      || (r.driveFile ? r.driveFile.speaker : null);

  h += '<div class="info-meta">';
  h += `<span class="type-tag">${escapeHtml(r.type)}</span>`;
  h += `<span>週${DOW_NAMES[r.dow]}</span>`;
  if (displaySpeaker) h += `<span>${escapeHtml(displaySpeaker)}</span>`;
  if (r.driveFile) h += `<span class="file-size">${r.driveFile.sizeMB} MB</span>`;
  h += `<span class="badge ${badgeClass}">${escapeHtml(badgeText)}</span>`;
  h += '</div></div>';

  if (clickable) h += '<span class="arrow">›</span>';
  h += '</div>';
  return h;
}

function bindEvents() {
  const si = document.getElementById('si');
  if (si) si.addEventListener('input', function (e) { state.sq = e.target.value; render(); });

  const ft = document.getElementById('ft');
  if (ft) ft.addEventListener('click', function (e) {
    const b = e.target.closest('.chip');
    if (!b) return;
    state.filter = b.dataset.f; render();
  });

  const yn = document.getElementById('yn');
  if (yn) yn.addEventListener('click', function (e) {
    const b = e.target.closest('.nav-btn');
    if (!b) return;
    selectYear(parseInt(b.dataset.y));
  });

  const mn = document.getElementById('mn');
  if (mn) mn.addEventListener('click', function (e) {
    const b = e.target.closest('.nav-btn');
    if (!b) return;
    selectMonth(state.sy, b.dataset.m === 'x' ? null : parseInt(b.dataset.m));
  });

  const ml = document.getElementById('ml');
  if (ml) ml.addEventListener('click', function (e) {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const action = b.dataset.action;
    if (action === 'open') {
      const id = b.dataset.id;
      if (id) location.href = 'meeting.html?id=' + encodeURIComponent(id) + (state.theme !== 'adult' ? '&theme=' + state.theme : '');
    } else if (action === 'process') {
      handleProcess(b.dataset.date, b.dataset.type);
    }
  });
}

async function handleProcess(date, type) {
  const key = `${date}_${type}`;
  if (state.processing[key]) return;

  const file = state.driveFiles.find(f => f.date === date && f.type === type);
  const topic = file ? file.topic : '';
  const speaker = file ? file.speaker : '';
  const sizeMB = file ? file.sizeMB : null;

  const estMin = sizeMB ? Math.max(1, Math.round(sizeMB / 10)) : 2;
  const promptLines = [
    `處理「${topic}」${speaker ? '(' + speaker + ')' : ''}？`,
    '',
    `日期：${date} (${type})${sizeMB ? '，檔案 ' + sizeMB + ' MB' : ''}`,
    '',
    `會在背景送 Gemini 整理為重點與經文，預估 ${estMin}-${estMin * 2} 分鐘。`,
    '完成後 Notion 會出現新草稿，前端會自動偵測並更新。',
  ];
  const ok = confirm(promptLines.join('\n'));
  if (!ok) return;

  state.processing[key] = true;
  render();

  try {
    // 1. 送出 queue 請求（立刻回應）
    const result = await gasApi.process(date, type);
    if (!result.success) {
      throw new Error(result.error || '排程失敗');
    }
    console.log(`[process] 已加入隊列: ${result.fileName}`, result);

    // 2. 開始輪詢 Notion 看是否完成
    pollForCompletion(date, type, key);
  } catch (err) {
    alert(`處理失敗：${err.message}`);
    delete state.processing[key];
    render();
  }
}

async function pollForCompletion(date, type, processingKey) {
  const MAX_POLL_MS = 8 * 60 * 1000;   // 8 分鐘上限
  const POLL_INTERVAL_MS = 15000;       // 每 15 秒
  const startedAt = Date.now();

  while (Date.now() - startedAt < MAX_POLL_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    try {
      const noResult = await api.listMeetings();
      const found = (noResult.meetings || []).find(m => {
        const d = m.date ? m.date.substring(0, 10) : '';
        return d === date && m.type === type;
      });

      if (found) {
        console.log(`[poll] 偵測到完成：${found.topic}`);
        state.notionMeetings = (noResult.meetings || []).map(function (m) {
          const d = formatDate(m.date);
          return Object.assign({}, m, {
            year: d.y, month: d.m, day: d.d, dow: d.dow,
            dateKey: m.date ? m.date.substring(0, 10) : '',
          });
        });
        delete state.processing[processingKey];
        DriveCache.invalidate(state.sy, state.sm + 1);
        await loadDriveForMonth(state.sy, state.sm);
        alert(`完成！「${found.topic}」已建立 Notion 草稿，請至 Notion 校稿。`);
        return;
      }
    } catch (e) {
      console.warn(`[poll] 輪詢失敗（會重試）：${e.message}`);
    }
  }

  delete state.processing[processingKey];
  render();
  alert(`處理超過 8 分鐘仍未完成，可能失敗了。\n請查看 GAS 執行紀錄：\nhttps://script.google.com/d/1gjOAw4XvHQa8YVv21Kh0T6kYVqTws_c3-ESQQB9uVCJx2RCrQjH_zPno/executions`);
}

function pad2(n) { return String(n).padStart(2, '0'); }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function escapeAttr(s) { return escapeHtml(s); }

init();
