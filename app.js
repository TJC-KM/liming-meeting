// 列表頁：行事曆視圖
//
// 資料流：
//   1. 用真實日曆生出該月（或全年）的每一天
//   2. 把 Notion / Drive 錄音 / Study 預查依日期+topic 附到對應日子
//   3. dedup 規則：同日同 topic 視為同一場聚會（Notion 優先，Drive/Study 補資訊）
//   4. 沒有資料的日子也存在，渲染成空白的 day-card
//
// 沒有 SCHEDULE 這種「預期格子」概念。哪天有資料就出現哪天。

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
  driveFiles: [],
  studyDocs: [],            // 所有預查文件（一次性載入，含估計日期）
  filter: 'all',
  sq: '',
  sy: null,
  sm: null,
  hideFuture: true,  // 預設勾選：客戶通常看的是已經發生的聚會
  theme: ThemeManager.get(),
  device: DeviceManager.get(),
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
  // 套用配色主題（必須在 render 前）
  ColorThemeManager.apply(ColorThemeManager.get());

  document.getElementById('themeSlot').innerHTML = renderThemeSwitcher(state.theme, null, state.device);
  ThemeManager.apply(state.theme, 'app');
  DeviceManager.apply(state.device, 'app');
  bindThemeSwitcher('app', function (change) {
    if (change.size) state.theme = change.size;
    if (change.device) state.device = change.device;
    render();
  });

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
    render();

    // 背景並行載入：當月 Drive 錄音 + 所有預查文件
    loadDriveForMonth(state.sy, state.sm);
    loadStudyDocs();
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

// 載入所有預查文件（只跑一次，全部資料夾掃描）
async function loadStudyDocs() {
  if (!gasApi.enabled()) return;
  try {
    const result = await gasApi.listStudy();
    state.studyDocs = (result.docs || []).filter(d => d.topic);
    render();
  } catch (e) {
    console.warn('[loadStudyDocs] 失敗:', e.message);
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

// === 日曆生成 ===

// 真實日曆：產生指定月份所有日子的空 day-card（items 為空陣列）
function buildDaysForMonth(year, month0) {
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();
  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    days.push({
      year: year,
      month: month0 + 1,
      day: d,
      dow: new Date(year, month0, d).getDay(),
      items: [],
    });
  }
  return days;
}

// 找到對應日子的 day-card；若日子不在範圍內回 null
function findDay(days, year, month, day) {
  return days.find(d => d.year === year && d.month === month && d.day === day) || null;
}

// 同一天「同 topic」視為同一場聚會：將 Drive / Study 資訊合併到既有 item
// 同一天「不同 topic」則並存（例：安息日上午 + 下午）
function attachEntries(days) {
  // Layer 1：Notion 紀錄 → filled
  state.notionMeetings.forEach(function (m) {
    const dayObj = findDay(days, m.year, m.month, m.day);
    if (!dayObj) return;
    dayObj.items.push(Object.assign({}, m, { _state: 'filled' }));
  });

  // Layer 2：Drive 錄音 → 已有同 topic 就合併，否則新增 pending
  state.driveFiles.forEach(function (f) {
    if (!f.date || !f.topic) return;
    const parts = f.date.split('-').map(Number);
    const dayObj = findDay(days, parts[0], parts[1], parts[2]);
    if (!dayObj) return;
    const existing = dayObj.items.find(it => it.topic === f.topic);
    if (existing) {
      existing.driveFile = f;
      return;
    }
    dayObj.items.push({
      year: parts[0], month: parts[1], day: parts[2], dow: dayObj.dow,
      topic: f.topic, speaker: f.speaker, type: f.type,
      driveFile: f, _state: 'pending',
    });
  });

  // Layer 3：Study 預查 → 已有同 topic 就合併，否則新增 pending-study
  state.studyDocs.forEach(function (doc) {
    if (!doc.estimatedDate || !doc.topic) return;
    const parts = doc.estimatedDate.split('-').map(Number);
    const dayObj = findDay(days, parts[0], parts[1], parts[2]);
    if (!dayObj) return;
    const existing = dayObj.items.find(it => it.topic === doc.topic);
    if (existing) {
      existing.studyDoc = doc;
      return;
    }
    dayObj.items.push({
      year: parts[0], month: parts[1], day: parts[2], dow: dayObj.dow,
      topic: doc.topic, speaker: doc.speaker, type: '週三晚間',
      studyDoc: doc, _state: 'pending-study',
    });
  });
}

function getDays() {
  let days = [];
  if (state.sm !== null) {
    days = buildDaysForMonth(state.sy, state.sm);
  } else {
    for (let m = 0; m < 12; m++) {
      days = days.concat(buildDaysForMonth(state.sy, m));
    }
  }
  attachEntries(days);

  // 篩選
  const now = new Date();
  if (state.filter !== 'all') {
    const targetDow = parseInt(state.filter, 10);
    days = days.filter(d => d.dow === targetDow);
  }
  if (state.hideFuture) {
    days = days.filter(d => new Date(d.year, d.month - 1, d.day) <= now);
  }
  if (state.sq) {
    const q = state.sq.toLowerCase();
    days = days.filter(d => d.items.some(item => {
      const topic = (item.topic || '').toLowerCase();
      const speaker = (item.speaker || '').toLowerCase();
      return topic.indexOf(q) >= 0 || speaker.indexOf(q) >= 0;
    }));
  }

  // 排序：新→舊；同日內 items 用 type 大致排（早晨→晚間）
  days.sort(function (a, b) {
    if (a.year !== b.year) return b.year - a.year;
    if (a.month !== b.month) return b.month - a.month;
    return b.day - a.day;
  });
  days.forEach(d => d.items.sort((a, b) => (a.type || '').localeCompare(b.type || '')));

  return days;
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
  // 保留搜尋框的焦點與游標位置（innerHTML 重畫會把 DOM 換掉，焦點會掉）
  var activeId = document.activeElement && document.activeElement.id;
  var cursorPos = null;
  if (activeId === 'si' && document.activeElement.selectionStart != null) {
    cursorPos = document.activeElement.selectionStart;
  }

  _doRender();

  // render 完之後把焦點還回去
  if (activeId === 'si') {
    var newSi = document.getElementById('si');
    if (newSi) {
      newSi.focus();
      if (cursorPos != null) {
        try { newSi.setSelectionRange(cursorPos, cursorPos); } catch (e) {}
      }
    }
  }
}

function _doRender() {
  if (state.loading) {
    document.getElementById('root').innerHTML = '<div class="loading">載入中...</div>';
    return;
  }

  const days = getDays();
  const years = getYears();
  const mc = getMonthCounts();

  // 統計：以「items」為單位（一天可能有多場聚會）
  const allItems = days.flatMap(d => d.items);
  const filled = allItems.filter(i => i._state === 'filled').length;
  const pending = allItems.filter(i => i._state === 'pending' || i._state === 'pending-study').length;
  const daysWithMeeting = days.filter(d => d.items.length > 0).length;

  let h = '';

  h += '<div class="search-wrap"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
  h += '<input class="search" type="text" placeholder="搜尋主題、講員..." value="' + escapeAttr(state.sq) + '" id="si"></div>';

  // sidebar：篩選 / 年份 / 月份（電腦版會被 CSS Grid 推到左側 sticky）
  h += '<aside class="sidebar">';
  h += '<div class="filters" id="ft"><button class="chip ' + (state.filter === 'all' ? 'active' : '') + '" data-f="all">全部</button>';
  WEEKDAY_FILTERS.forEach(function (w) {
    h += '<button class="chip ' + (state.filter === String(w.dow) ? 'active' : '') + '" data-f="' + w.dow + '">' + w.label + '</button>';
  });
  h += '<button class="chip chip-toggle ' + (state.hideFuture ? 'active' : '') + '" id="hf-chip">' + (state.hideFuture ? '✓ ' : '') + '隱藏未到</button>';
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
  h += '</aside>';

  h += '<div class="stats">';
  if (state.sm !== null) {
    h += '<span class="s-item">本月 <strong>' + daysWithMeeting + '</strong> 天有聚會</span>';
  } else {
    h += '<span class="s-item">全年 <strong>' + daysWithMeeting + '</strong> 天有聚會</span>';
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

  if (days.length === 0) {
    h += '<div class="empty">找不到符合條件的日子</div>';
  } else {
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
  const isEmpty = d.items.length === 0;
  const cardClass = 'day-card' + (isEmpty ? ' day-card-empty' : '');

  let h = `<div class="${cardClass}">`;
  h += '<div class="day-date">';
  h += `<div class="date-day">${d.day}</div>`;
  h += `<div class="date-mon">${d.month}月</div>`;
  h += `<div class="date-dow">${dowStr}</div>`;
  h += '</div>';
  h += '<div class="day-items">';
  if (isEmpty) {
    h += '<div class="day-empty-hint">—</div>';
  } else {
    d.items.forEach(function (item) {
      h += renderRow(item);
    });
  }
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
      badgeText = '🎙 待轉錄';
    }
    clickable = !isProcessing && gasApi.enabled();
    action = `data-action="process" data-date="${r.year}-${pad2(r.month)}-${pad2(r.day)}" data-type="${escapeAttr(r.type)}"`;
  } else if (st === 'pending-study') {
    badgeClass = 'badge-pending';
    if (isProcessing) {
      const startedAt = state.processing[procKey];
      const elapsedMs = Date.now() - (typeof startedAt === 'number' ? startedAt : Date.now());
      const min = Math.floor(elapsedMs / 60000);
      const sec = Math.floor((elapsedMs % 60000) / 1000);
      const elapsedStr = min > 0 ? `${min}:${String(sec).padStart(2, '0')}` : `${sec}s`;
      badgeText = `<span class="spinner"></span>處理中 ${elapsedStr}`;
    } else {
      badgeText = '📖 待處理預查';
    }
    clickable = !isProcessing && gasApi.enabled();
    action = `data-action="process-study" data-fileid="${escapeAttr(r.studyDoc.id)}"`;
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
                    || (r.driveFile ? r.driveFile.topic : null)
                    || (r.studyDoc ? r.studyDoc.topic : null);

  if (displayTopic) {
    h += `<div class="info-title">${escapeHtml(displayTopic)}</div>`;
  } else {
    h += `<div class="info-title info-title-empty">${escapeHtml(r.type)}</div>`;
  }

  const displaySpeaker = (st === 'filled' ? r.speaker : null)
                      || (r.driveFile ? r.driveFile.speaker : null)
                      || (r.studyDoc ? r.studyDoc.speaker : null);

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
    } else if (action === 'process-study') {
      handleProcessStudy(b.dataset.fileid);
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

  // 發 Worker 請求（不 await，keepalive 確保離開頁面仍會送出）
  gasApi.process(date, type)
    .then(r => console.log('[process] worker 完成', r))
    .catch(e => console.warn('[process] worker 失敗', e.message));

  // 立刻跳到 meeting.html 等待模式
  // audioFileId 讓 meeting 頁能在 Notion 寫入前就提供播放/下載/心得功能
  const qp = new URLSearchParams({
    date: date,
    type: type,
    topic: topic || '',
    speaker: speaker || '',
    sizeMB: sizeMB ? String(sizeMB) : '',
    audioFileId: file ? file.id : '',
    processing: '1',
  });
  if (state.theme !== 'adult') qp.set('theme', state.theme);
  location.href = 'meeting.html?' + qp.toString();
}

async function handleProcessStudy(fileId) {
  const doc = state.studyDocs.find(d => d.id === fileId);
  if (!doc) return;
  const key = `study_${fileId}`;
  if (state.processing[key]) return;

  state.processing[key] = Date.now();
  startProcessingTicker();
  render();

  // Fire 處理（不 await）
  gasApi.processStudy(fileId)
    .then(r => console.log('[processStudy]', r))
    .catch(e => console.warn('[processStudy] worker 失敗', e.message));

  // 跳到 meeting 頁等待（用 estimatedDate + 週三晚間 + studyFileId）
  const qp = new URLSearchParams({
    date: doc.estimatedDate,
    type: '週三晚間',
    topic: doc.topic || '',
    speaker: doc.speaker || '',
    studyFileId: fileId,
    processing: '1',
  });
  if (state.theme !== 'adult') qp.set('theme', state.theme);
  location.href = 'meeting.html?' + qp.toString();
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
