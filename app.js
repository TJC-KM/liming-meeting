// 列表頁：行事曆視圖
// Notion 資料一次抓全部，Drive 資料按月份懶載入（搭配 sessionStorage 快取）

const SCHEDULE = {
  0: ['主日聚會'],
  2: ['週二晚間'],
  3: ['週三晚間'],
  5: ['週五晚間'],
  6: ['安息日上午', '安息日下午'],
};

const ALL_TYPES = ['週二晚間', '週三晚間', '週五晚間', '安息日上午', '安息日下午', '主日聚會'];

// 篩選 chips：依星期（週六顯示為「安息日」）
const WEEKDAY_FILTERS = [
  { dow: 1, label: '週一' },
  { dow: 2, label: '週二' },
  { dow: 3, label: '週三' },
  { dow: 4, label: '週四' },
  { dow: 5, label: '週五' },
  { dow: 6, label: '安息日' },
  { dow: 0, label: '週日' },
];

var state = {
  notionMeetings: [],
  driveFiles: [],           // 目前選擇月份的 Drive 檔案
  filter: 'all',
  sq: '',
  sy: null,
  sm: null,                 // null = 全年；0-11 = 月份
  hideFuture: false,        // 隱藏未到日期
  theme: ThemeManager.get(),
  loading: true,
  loadingDrive: false,
  driveError: null,
  processing: {},
};

// 週幾標籤：週六顯示為「安息日」，其他為「週X」
function dowLabel(year, month, day) {
  const d = new Date(year, month - 1, day).getDay();
  if (d === 6) return '安息日';
  return '週' + DOW_NAMES[d];
}

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

  const m1 = month0 + 1;

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

async function loadDriveForYear(year) {
  if (!gasApi.enabled()) return;

  state.loadingDrive = true;
  state.driveError = null;
  state.driveFiles = [];
  render();

  // 並行載入 12 個月，搭配快取
  const promises = [];
  const allFiles = [];
  for (let m = 1; m <= 12; m++) {
    const cached = DriveCache.get(year, m);
    if (cached) {
      allFiles.push.apply(allFiles, cached);
    } else {
      promises.push(
        gasApi.listUnprocessed(year, m).then(function (result) {
          const files = result.files || [];
          DriveCache.set(year, m, files);
          allFiles.push.apply(allFiles, files);
        }).catch(function (e) {
          console.warn(`[loadDriveForYear] ${year}-${m} 失敗:`, e.message);
        })
      );
    }
  }

  if (promises.length === 0) {
    // 全部都在快取
    if (state.sy === year && state.sm === null) {
      state.driveFiles = allFiles.filter(f => f.parseable);
      state.loadingDrive = false;
      render();
    }
    return;
  }

  await Promise.all(promises);

  if (state.sy === year && state.sm === null) {
    state.driveFiles = allFiles.filter(f => f.parseable);
    state.loadingDrive = false;
    render();
  }
}

function selectMonth(year, month0) {
  state.sy = year;
  state.sm = month0;
  state.driveFiles = [];
  render();
  if (month0 !== null) loadDriveForMonth(year, month0);
  else loadDriveForYear(year);
}

function selectYear(year) {
  state.sy = year;
  state.sm = null;
  state.driveFiles = [];
  render();
  loadDriveForYear(year);
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
    // 全年：生成全年 12 個月的所有 slot，搭配已載入的 Drive 資料
    for (let m = 0; m < 12; m++) {
      const monthRows = buildRowsForMonth(state.sy, m).map(enrichRow);
      addSpecialEvents(monthRows, state.sy, m);
      rows = rows.concat(monthRows);
    }
  }

  rows.sort(function (a, b) {
    if (a.year !== b.year) return b.year - a.year;
    if (a.month !== b.month) return b.month - a.month;
    if (a.day !== b.day) return b.day - a.day;
    return ALL_TYPES.indexOf(a.type) - ALL_TYPES.indexOf(b.type);
  });

  if (state.filter !== 'all') {
    const targetDow = parseInt(state.filter, 10);
    rows = rows.filter(r => new Date(r.year, r.month - 1, r.day).getDay() === targetDow);
  }
  if (state.hideFuture) {
    rows = rows.filter(r => r._state !== 'future');
  }
  if (state.sq) {
    const q = state.sq.toLowerCase();
    rows = rows.filter(function (r) {
      const topic = (r.topic || (r.driveFile && r.driveFile.topic) || '').toLowerCase();
      const speaker = r.speaker || (r.driveFile && r.driveFile.speaker) || '';
      const type = r.type || '';
      return topic.indexOf(q) >= 0
        || speaker.indexOf(q) >= 0
        || type.indexOf(q) >= 0;
    });
  }
  return rows;
}

// 把 rows 依日期分組成「日卡片」
function groupByDay(rows) {
  const map = {};
  rows.forEach(function (r) {
    const key = `${r.year}-${r.month}-${r.day}`;
    if (!map[key]) {
      map[key] = {
        year: r.year, month: r.month, day: r.day,
        dow: new Date(r.year, r.month - 1, r.day).getDay(),
        items: [],
      };
    }
    map[key].items.push(r);
  });
  return Object.values(map);
}

function getYears() {
  // 固定從 2018 到本年
  const current = new Date().getFullYear();
  const years = [];
  for (let y = current; y >= 2018; y--) years.push(y);
  return years;
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
  WEEKDAY_FILTERS.forEach(function (w) {
    h += '<button class="chip ' + (state.filter === String(w.dow) ? 'active' : '') + '" data-f="' + w.dow + '">' + w.label + '</button>';
  });
  h += '<button class="chip ' + (state.hideFuture ? 'active' : '') + '" id="hf-chip">' + (state.hideFuture ? '✓ ' : '') + '隱藏未到</button>';
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
  if (gasApi.enabled()) {
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
    const days = groupByDay(rows);
    h += '<div class="list" id="ml">';
    days.forEach(function (d) {
      h += renderDay(d);
    });
    h += '</div>';
  }

  document.getElementById('root').innerHTML = h;
  bindEvents();
}

function renderDay(d) {
  const dowStr = dowLabel(d.year, d.month, d.day).replace('週', '');
  let h = '<div class="day-card">';
  h += '<div class="day-date">';
  h += `<div class="date-day">${d.day}</div>`;
  h += `<div class="date-mon">${d.month}月</div>`;
  h += `<div class="date-dow">${dowStr}</div>`;
  h += '</div>';
  h += '<div class="day-items">';
  d.items.forEach(function (item) {
    h += renderRow(item);
  });
  h += '</div>';
  h += '</div>';
  return h;
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
    if (isProcessing) {
      const startedAt = state.processing[procKey];
      const elapsedMs = Date.now() - (typeof startedAt === 'number' ? startedAt : Date.now());
      const min = Math.floor(elapsedMs / 60000);
      const sec = Math.floor((elapsedMs % 60000) / 1000);
      const elapsedStr = min > 0 ? `${min}:${String(sec).padStart(2, '0')}` : `${sec}s`;
      badgeText = `<span class="spinner"></span>處理中 ${elapsedStr}`;
    } else {
      badgeText = '待處理';
    }
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
  if (displaySpeaker) h += `<span>${escapeHtml(displaySpeaker)}</span>`;
  if (r.driveFile) h += `<span class="file-size">${r.driveFile.sizeMB} MB</span>`;
  // badgeText 可能含 HTML（spinner），不能用 escapeHtml
  h += `<span class="badge ${badgeClass}">${badgeText}</span>`;
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
    if (b.id === 'hf-chip') {
      state.hideFuture = !state.hideFuture;
    } else {
      state.filter = b.dataset.f;
    }
    render();
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

  const estMin = sizeMB ? Math.max(1, Math.round(sizeMB / 15)) : 2;
  const promptLines = [
    `處理「${topic}」${speaker ? '(' + speaker + ')' : ''}？`,
    '',
    `日期：${date} (${type})${sizeMB ? '，檔案 ' + sizeMB + ' MB' : ''}`,
    '',
    `會送 Gemini 整理為重點與經文，預估 ${estMin}-${estMin * 2} 分鐘。`,
    '完成後 Notion 會出現新草稿，前端自動偵測更新。',
    '',
    '⚠ Gemini 每日配額有限，建議一天處理 5-6 篇',
    '   超過上限會顯示「今日配額用完」，明天再試。',
  ];
  const ok = confirm(promptLines.join('\n'));
  if (!ok) return;

  state.processing[key] = Date.now();
  startProcessingTicker();
  render();

  try {
    const result = await gasApi.process(date, type);
    if (!result.success) {
      throw new Error(result.error || '排程失敗');
    }
    console.log(`[process] 已加入隊列: ${result.fileName}`, result);
    pollForCompletion(date, type, key);
  } catch (err) {
    alert(`處理失敗：${err.message}`);
    delete state.processing[key];
    stopProcessingTickerIfDone();
    render();
  }
}

// 每秒重繪一次「處理中」列，更新顯示經過時間
var _processingTicker = null;
function startProcessingTicker() {
  if (_processingTicker) return;
  _processingTicker = setInterval(function () {
    if (Object.keys(state.processing).length === 0) {
      stopProcessingTickerIfDone();
    } else {
      render();
    }
  }, 5000);
}
function stopProcessingTickerIfDone() {
  if (_processingTicker && Object.keys(state.processing).length === 0) {
    clearInterval(_processingTicker);
    _processingTicker = null;
  }
}

async function pollForCompletion(date, type, processingKey) {
  const MAX_POLL_MS = 12 * 60 * 1000;  // 12 分鐘上限（大檔可能要久）
  const POLL_INTERVAL_MS = 15000;
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
        stopProcessingTickerIfDone();
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
  stopProcessingTickerIfDone();
  render();
  alert(`處理超過 12 分鐘仍未完成，可能 Cloudflare 處理超時或 Gemini 持續忙線。\n可到 Cloudflare Dashboard 看 Worker logs，或稍後重試。`);
}

function pad2(n) { return String(n).padStart(2, '0'); }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function escapeAttr(s) { return escapeHtml(s); }

init();
