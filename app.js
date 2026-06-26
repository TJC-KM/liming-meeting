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
  showFuture: false,  // 預設不顯示未來日子；勾選「未來」chip 才顯示
  view: ViewManager.get(),  // 'day' | 'week' | 'month'
  weekDate: null,            // 週視圖：當週週日的 Date 物件，由 getWeekStart 設定
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

// 給定一個 Date，回傳那一週的「週日」Date（時間歸零）
function getWeekStart(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - d.getDay());
  return d;
}

// 對 sunday 加 N 天回傳新 Date
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

// 給 sunday Date，產生一週 7 天的 day 物件（items 為空）
function buildDaysForWeek(sundayDate) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const dt = addDays(sundayDate, i);
    days.push({
      year: dt.getFullYear(),
      month: dt.getMonth() + 1,
      day: dt.getDate(),
      dow: dt.getDay(),
      items: [],
    });
  }
  return days;
}

// 格式化週標籤：「5/17 ~ 5/23」或跨月「5/30 ~ 6/5」
function formatWeekRange(sundayDate) {
  const saturday = addDays(sundayDate, 6);
  const m1 = sundayDate.getMonth() + 1, d1 = sundayDate.getDate();
  const m2 = saturday.getMonth() + 1, d2 = saturday.getDate();
  if (m1 === m2) return `${m1}/${d1} ~ ${d2}`;
  return `${m1}/${d1} ~ ${m2}/${d2}`;
}

function init() {
  // 套用配色主題（必須在 render 前）
  ColorThemeManager.apply(ColorThemeManager.get());

  document.getElementById('themeSlot').innerHTML = renderThemeSwitcher(state.theme, null, state.view);
  ThemeManager.apply(state.theme, 'app');
  ViewManager.apply(state.view, 'app');
  bindThemeSwitcher('app', function (change) {
    if (change.size) state.theme = change.size;
    if (change.view) {
      // 切換視圖 → reset 到「今天」的對應月/週，並重載 drive
      const before = state.view;
      state.view = change.view;
      onViewChange(before, change.view);
    }
    render();
  });

  // 從 localStorage 還原「處理中」狀態（跨 reload / 返回保留）
  restoreProcessing();
  if (Object.keys(state.processing).length > 0) {
    startProcessingTicker();
    startCompletionPolling();
  }

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

// 載入一週可能跨到的月份的 Drive 檔案（1~2 個月）
async function loadDriveForWeek(sundayDate) {
  if (!gasApi.enabled()) return;

  const startY = sundayDate.getFullYear();
  const startM = sundayDate.getMonth();
  const endDate = addDays(sundayDate, 6);
  const endY = endDate.getFullYear();
  const endM = endDate.getMonth();

  const months = [{ y: startY, m: startM }];
  if (startY !== endY || startM !== endM) months.push({ y: endY, m: endM });

  state.loadingDrive = true;
  state.driveError = null;
  state.driveFiles = [];
  render();

  try {
    const results = await Promise.all(months.map(async ({ y, m }) => {
      const cached = DriveCache.get(y, m + 1);
      if (cached) return cached;
      const result = await gasApi.listUnprocessed(y, m + 1);
      const files = result.files || [];
      DriveCache.set(y, m + 1, files);
      return files;
    }));
    state.driveFiles = results.flat().filter(f => f.parseable);
    state.loadingDrive = false;
    render();
  } catch (err) {
    state.driveError = err.message;
    state.loadingDrive = false;
    render();
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

// 視圖切換的副作用：reset 到「今天」對應的月/週，重新載入 drive 資料
// 由 bindThemeSwitcher 觸發；不是給 UI 按鈕直接呼叫的（按鈕已併入 themeSwitcher）
function onViewChange(before, after) {
  const now = new Date();
  if (after === 'week') {
    state.weekDate = getWeekStart(now);
    state.sy = state.weekDate.getFullYear();
    loadDriveForWeek(state.weekDate);
  } else if (after === 'month') {
    state.sy = now.getFullYear();
    state.sm = now.getMonth();
    loadDriveForMonth(state.sy, state.sm);
  } else {  // 'day'
    state.sy = now.getFullYear();
    state.sm = now.getMonth();   // 預設單月，使用者可改全年
    loadDriveForMonth(state.sy, state.sm);
  }
}

function gotoWeek(sundayDate) {
  state.weekDate = sundayDate;
  state.sy = sundayDate.getFullYear();   // 同步年份按鈕高亮
  render();
  loadDriveForWeek(sundayDate);
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

  // Layer 2：Drive 錄音 → 已在 Notion 的 fileId 就跳過，否則新增 pending
  const notionAudioFileIds = new Set(
    state.notionMeetings.filter(m => m.audioUrl).map(m => {
      const match = m.audioUrl.match(/\/d\/([^/]+)/);
      return match ? match[1] : null;
    }).filter(Boolean)
  );
  state.driveFiles.forEach(function (f) {
    if (!f.date || !f.topic) return;
    if (notionAudioFileIds.has(f.id)) return;
    const parts = f.date.split('-').map(Number);
    const dayObj = findDay(days, parts[0], parts[1], parts[2]);
    if (!dayObj) return;
    dayObj.items.push({
      year: parts[0], month: parts[1], day: parts[2], dow: dayObj.dow,
      topic: f.topic, speaker: f.speaker, type: f.type,
      driveFile: f, _state: 'pending',
    });
  });

  // Layer 3：Study 預查 → 已有同 topic 就合併，否則新增 pending-study
  // 先建立已在 Notion 的 fileId 集合，避免已轉檔的檔案在估計日期再出現一次
  const notionStudyFileIds = new Set(
    state.notionMeetings.filter(m => m.studyUrl).map(m => {
      const match = m.studyUrl.match(/\/d\/([^/]+)/);
      return match ? match[1] : null;
    }).filter(Boolean)
  );
  state.studyDocs.forEach(function (doc) {
    if (!doc.estimatedDate || !doc.topic) return;
    if (notionStudyFileIds.has(doc.id)) return;
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
  if (!state.showFuture) {
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
  h += '<button class="chip chip-toggle ' + (state.showFuture ? 'active' : '') + '" id="hf-chip">' + (state.showFuture ? '✓ ' : '') + '未來</button>';
  h += '</div>';

  if (years.length > 0) {
    h += '<div class="nav-row" id="yn"><span class="nav-label">年份</span>';
    years.forEach(function (y) {
      h += '<button class="nav-btn ' + (state.sy === y ? 'active' : '') + '" data-y="' + y + '">' + y + '</button>';
    });
    h += '</div>';
  }

  // 視圖決定的 nav：日→月份(可全年)；週→週導覽；月→月份(無全年)
  if (state.view === 'week') {
    if (!state.weekDate) state.weekDate = getWeekStart(new Date());
    h += '<div class="nav-row" id="wn"><span class="nav-label">週次</span>';
    h += '<button class="nav-btn" data-wk="prev">← 上週</button>';
    h += '<button class="nav-btn nav-btn-static">' + formatWeekRange(state.weekDate) + '</button>';
    h += '<button class="nav-btn" data-wk="next">下週 →</button>';
    h += '<button class="nav-btn" data-wk="today">回到本週</button>';
    h += '</div>';
  } else {
    // day 與 month 共用月份 nav；「全年」按鈕只在 day 視圖顯示
    h += '<div class="nav-row" id="mn"><span class="nav-label">月份</span>';
    if (state.view === 'day') {
      h += '<button class="nav-btn ' + (state.sm === null ? 'active' : '') + '" data-m="x">全年</button>';
    }
    for (let i = 11; i >= 0; i--) {
      h += '<button class="nav-btn ' + (state.sm === i ? 'active' : '') + '" data-m="' + i + '">' + (i + 1) + '月';
      if (mc[i] > 0) h += '<span class="cnt">' + mc[i] + '</span>';
      h += '</button>';
    }
    h += '</div>';
  }

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

  // 視圖派發：week → 4+3 週曆；month + 已選月份 → 月曆網格；其他 (day) → list
  if (state.view === 'week') {
    h += renderWeekView();
  } else if (state.view === 'month' && state.sm !== null) {
    h += renderCalendarView();
  } else if (days.length === 0) {
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

// === 月曆網格（電腦版單月）===

// 月曆模式專屬：全部日子都顯示，週幾篩選不套用（網格本來就照週幾排）
// showFuture 控制「未來日子的 events 是否顯示」，未來日子的 cell 一律存在但 faded
function renderCalendarView() {
  const days = buildDaysForMonth(state.sy, state.sm);
  attachEntries(days);
  days.sort((a, b) => a.day - b.day);

  // 搜尋：過濾每個 day 的 items
  if (state.sq) {
    const q = state.sq.toLowerCase();
    days.forEach(d => {
      d.items = d.items.filter(item => {
        const topic = (item.topic || '').toLowerCase();
        const speaker = (item.speaker || '').toLowerCase();
        return topic.indexOf(q) >= 0 || speaker.indexOf(q) >= 0;
      });
    });
  }

  // showFuture 關閉時：未來日子的 events 清空（cell 仍存在但無內容）
  if (!state.showFuture) {
    const now = new Date();
    days.forEach(d => {
      if (new Date(d.year, d.month - 1, d.day) > now) d.items = [];
    });
  }

  return renderCalendarMonth(days, state.sy, state.sm);
}

function renderCalendarMonth(days, year, month0) {
  // 計算這個月 1 號是星期幾，補齊 leading cells
  const firstDow = new Date(year, month0, 1).getDay();  // 0=日 6=六
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  days.forEach(d => cells.push(d));
  while (cells.length % 7 !== 0) cells.push(null);

  let h = '<div class="calendar">';

  // 週日 ~ 週六 表頭
  h += '<div class="cal-head">';
  ['日', '一', '二', '三', '四', '五', '六'].forEach((label, i) => {
    const cls = 'cal-head-cell' + (i === 6 ? ' cal-head-sat' : '');
    h += '<div class="' + cls + '">' + label + '</div>';
  });
  h += '</div>';

  // 日子 cells
  h += '<div class="cal-body">';
  cells.forEach(cell => {
    if (!cell) {
      h += '<div class="cal-cell cal-cell-blank"></div>';
      return;
    }
    h += renderCalendarCell(cell);
  });
  h += '</div>';

  h += '</div>';
  return h;
}

function renderCalendarCell(d) {
  const today = new Date();
  const isToday = today.getFullYear() === d.year
               && today.getMonth() === d.month - 1
               && today.getDate() === d.day;
  const isSat = d.dow === 6;
  const cellDate = new Date(d.year, d.month - 1, d.day);
  const isFuture = cellDate > today;

  let cls = 'cal-cell';
  if (isToday) cls += ' cal-cell-today';
  if (isSat) cls += ' cal-cell-sat';
  if (isFuture) cls += ' cal-cell-future';
  if (d.items.length === 0) cls += ' cal-cell-empty';

  let h = '<div class="' + cls + '">';
  h += '<div class="cal-day">' + d.day + '</div>';
  if (d.items.length > 0) {
    h += '<div class="cal-events">';
    d.items.forEach(item => h += renderCalendarEvent(item, d));
    h += '</div>';
  }
  h += '</div>';
  return h;
}

function renderCalendarEvent(item, d) {
  const st = item._state;
  // 用 fileId 當 processing key（同 date+type 多場活動才能各自獨立追蹤）
  const fid = item.driveFile && item.driveFile.id;
  const procKey = fid || `${d.year}-${pad2(d.month)}-${pad2(d.day)}_${item.type}`;
  const isProcessing = !!state.processing[procKey];

  let action = '';
  let cls = 'cal-event cal-event-' + st;
  if (isProcessing) cls += ' cal-event-processing';

  if (st === 'filled' && item.id) {
    action = `data-action="open" data-id="${escapeAttr(item.id)}"`;
    cls += ' cal-event-clickable';
  } else if (st === 'pending' && !isProcessing) {
    action = `data-action="process" data-date="${d.year}-${pad2(d.month)}-${pad2(d.day)}" data-type="${escapeAttr(item.type)}" data-fileid="${escapeAttr(fid || '')}"`;
    cls += ' cal-event-clickable';
  } else if (st === 'pending-study' && !isProcessing && item.studyDoc) {
    action = `data-action="process-study" data-fileid="${escapeAttr(item.studyDoc.id)}"`;
    cls += ' cal-event-clickable';
  }

  const topic = item.topic || (item.driveFile && item.driveFile.topic) || (item.studyDoc && item.studyDoc.topic) || '(未命名)';
  const speaker = item.speaker || (item.driveFile && item.driveFile.speaker) || (item.studyDoc && item.studyDoc.speaker) || '';

  // 狀態徽章短文字（cell 寬度有限，用短字）
  let badge = '';
  if (isProcessing) badge = '<span class="cal-event-badge">處理中</span>';
  else if (st === 'filled') badge = '<span class="cal-event-badge">' + escapeHtml(item.status || '草稿') + '</span>';
  else if (st === 'pending') badge = '<span class="cal-event-badge">待轉錄</span>';
  else if (st === 'pending-study') badge = '<span class="cal-event-badge">預查</span>';

  const titleAttr = topic + (speaker ? ' / ' + speaker : '');
  let h = `<div class="${cls}" ${action} title="${escapeAttr(titleAttr)}">`;
  h += '<div class="cal-event-topic">' + escapeHtml(topic) + '</div>';
  if (speaker) h += '<div class="cal-event-speaker">' + escapeHtml(speaker) + '</div>';
  h += badge;
  h += '</div>';
  return h;
}

// === 週曆視圖（電腦版 + 週模式）===
// 排版：上排 4 天（日 一 二 三），下排 3 天（四 五 六）—— 讓安息日格子大很多
function renderWeekView() {
  if (!state.weekDate) state.weekDate = getWeekStart(new Date());
  const days = buildDaysForWeek(state.weekDate);
  attachEntries(days);

  // 套用搜尋：過濾每個 day 的 items
  if (state.sq) {
    const q = state.sq.toLowerCase();
    days.forEach(d => {
      d.items = d.items.filter(item => {
        const topic = (item.topic || '').toLowerCase();
        const speaker = (item.speaker || '').toLowerCase();
        return topic.indexOf(q) >= 0 || speaker.indexOf(q) >= 0;
      });
    });
  }

  // showFuture 控制未來日子的 events 是否清空
  if (!state.showFuture) {
    const now = new Date();
    days.forEach(d => {
      if (new Date(d.year, d.month - 1, d.day) > now) d.items = [];
    });
  }

  const top = days.slice(0, 4);     // 日 一 二 三
  const bottom = days.slice(4, 7);  // 四 五 六

  let h = '<div class="week-view">';
  h += '<div class="week-row week-row-top">';
  top.forEach(d => h += renderWeekCell(d));
  h += '</div>';
  h += '<div class="week-row week-row-bottom">';
  bottom.forEach(d => h += renderWeekCell(d));
  h += '</div>';
  h += '</div>';
  return h;
}

function renderWeekCell(d) {
  const today = new Date();
  const isToday = today.getFullYear() === d.year
               && today.getMonth() === d.month - 1
               && today.getDate() === d.day;
  const isSat = d.dow === 6;
  const isFuture = new Date(d.year, d.month - 1, d.day) > today;

  let cls = 'week-cell';
  if (isToday) cls += ' week-cell-today';
  if (isSat) cls += ' week-cell-sat';
  if (isFuture) cls += ' week-cell-future';
  if (d.items.length === 0) cls += ' week-cell-empty';

  const dowName = ['日', '一', '二', '三', '四', '五', '六'][d.dow];
  const label = isSat ? '安息日' : '週' + dowName;

  let h = '<div class="' + cls + '">';
  h += '<div class="week-cell-head">';
  h += '<div class="week-cell-date">' + d.month + '/' + d.day + '</div>';
  h += '<div class="week-cell-dow">' + label + '</div>';
  h += '</div>';
  if (d.items.length > 0) {
    h += '<div class="week-cell-events">';
    d.items.forEach(item => h += renderWeekEvent(item, d));
    h += '</div>';
  }
  h += '</div>';
  return h;
}

function renderWeekEvent(item, d) {
  const st = item._state;
  const fid = item.driveFile && item.driveFile.id;
  const procKey = fid || `${d.year}-${pad2(d.month)}-${pad2(d.day)}_${item.type}`;
  const isProcessing = !!state.processing[procKey];

  let action = '';
  let cls = 'week-event week-event-' + st;
  if (isProcessing) cls += ' week-event-processing';

  if (st === 'filled' && item.id) {
    action = `data-action="open" data-id="${escapeAttr(item.id)}"`;
    cls += ' week-event-clickable';
  } else if (st === 'pending' && !isProcessing) {
    action = `data-action="process" data-date="${d.year}-${pad2(d.month)}-${pad2(d.day)}" data-type="${escapeAttr(item.type)}" data-fileid="${escapeAttr(fid || '')}"`;
    cls += ' week-event-clickable';
  } else if (st === 'pending-study' && !isProcessing && item.studyDoc) {
    action = `data-action="process-study" data-fileid="${escapeAttr(item.studyDoc.id)}"`;
    cls += ' week-event-clickable';
  }

  const topic = item.topic || (item.driveFile && item.driveFile.topic) || (item.studyDoc && item.studyDoc.topic) || '(未命名)';
  const speaker = item.speaker || (item.driveFile && item.driveFile.speaker) || (item.studyDoc && item.studyDoc.speaker) || '';

  // 狀態徽章
  let badge = '';
  if (isProcessing) badge = '<span class="week-event-badge"><span class="spinner"></span>處理中</span>';
  else if (st === 'filled') badge = '<span class="week-event-badge">' + escapeHtml(item.status || '草稿') + '</span>';
  else if (st === 'pending') badge = '<span class="week-event-badge">🎙 待轉錄</span>';
  else if (st === 'pending-study') badge = '<span class="week-event-badge">📖 預查</span>';

  let h = `<div class="${cls}" ${action}>`;
  h += '<div class="week-event-topic">' + escapeHtml(topic) + '</div>';
  if (speaker) h += '<div class="week-event-speaker">' + escapeHtml(speaker) + '</div>';
  if (badge) h += '<div class="week-event-meta">' + badge + '</div>';
  h += '</div>';
  return h;
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
  const fid = r.driveFile && r.driveFile.id;
  const procKey = fid || `${r.year}-${pad2(r.month)}-${pad2(r.day)}_${r.type}`;
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
    action = `data-action="process" data-date="${r.year}-${pad2(r.month)}-${pad2(r.day)}" data-type="${escapeAttr(r.type)}" data-fileid="${escapeAttr(fid || '')}"`;
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
      state.showFuture = !state.showFuture;
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

  const wn = document.getElementById('wn');
  if (wn) wn.addEventListener('click', function (e) {
    const b = e.target.closest('.nav-btn');
    if (!b || !b.dataset.wk) return;
    const dir = b.dataset.wk;
    if (dir === 'prev') gotoWeek(addDays(state.weekDate, -7));
    else if (dir === 'next') gotoWeek(addDays(state.weekDate, 7));
    else if (dir === 'today') gotoWeek(getWeekStart(new Date()));
  });

  // #root 是 HTML 寫死的 ID（不會被 innerHTML 重畫），所以 listener 只能綁一次
  // 否則每 render 一次就累積一個 listener，點一次按鈕就會觸發 N 次！
  if (!_rootClickBound) {
    _rootClickBound = true;
    const root = document.getElementById('root');
    if (root) root.addEventListener('click', function (e) {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      const action = b.dataset.action;
      if (action === 'open') {
        const id = b.dataset.id;
        if (id) location.href = 'meeting.html?id=' + encodeURIComponent(id) + (state.theme !== 'adult' ? '&theme=' + state.theme : '');
      } else if (action === 'process') {
        handleProcess(b.dataset.date, b.dataset.type, b.dataset.fileid);
      } else if (action === 'process-study') {
        handleProcessStudy(b.dataset.fileid);
      }
    });
  }
}
var _rootClickBound = false;

async function handleProcess(date, type, fileId) {
  // 優先用 fileId 找檔（精準），fallback 才用 date+type（同 date+type 多場活動時會 first-match 撞錯場）
  const file = (fileId && state.driveFiles.find(f => f.id === fileId))
            || state.driveFiles.find(f => f.date === date && f.type === type);
  const fid = (file && file.id) || fileId || '';
  const key = fid || `${date}_${type}`;
  if (state.processing[key]) return;

  const topic = file ? file.topic : '';
  const speaker = file ? file.speaker : '';
  const sizeMB = file ? file.sizeMB : null;

  // 設 lock — in-memory + localStorage 持久化，避免重複觸發
  console.log(`[handleProcess] 設 lock key="${key}", file=${file ? file.name : '(unknown)'}`);
  markProcessing(key);
  startProcessingTicker();
  startCompletionPolling();

  // 發 Worker 請求（不 await，keepalive 確保離開頁面仍會送出）
  // 傳 fileId 為主，避免 worker 用 date+type 找又中第一場
  gasApi.process(date, type, fid)
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
    audioFileId: fid,
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

  markProcessing(key);
  startProcessingTicker();
  startCompletionPolling();
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

// === 處理中狀態管理（in-memory + localStorage 同步）===

function markProcessing(key) {
  ProcessingStore.set(key);
  state.processing[key] = Date.now();
}
function clearProcessing(key) {
  ProcessingStore.delete(key);
  delete state.processing[key];
}

// 從 localStorage 還原處理中清單（init 時呼叫，跨 reload 保留狀態）
function restoreProcessing() {
  Object.assign(state.processing, ProcessingStore.getActive());
}

// === Index 端輪詢 Notion，偵測「處理完成」===
// 每 15 秒呼叫 listMeetings；發現某個 processing key 對應的紀錄已存在 → 清 lock + render
// 只在 state.processing 有東西時運作；空了就自動停止
var _completionPoll = null;
function startCompletionPolling() {
  if (_completionPoll) return;
  if (Object.keys(state.processing).length === 0) return;

  console.log(`[poll] 開始輪詢，間隔 15s`);
  // 立刻先檢查一次，不要等 15 秒
  _pollOnce();

  _completionPoll = setInterval(_pollOnce, 15000);
}

async function _pollOnce() {
    if (Object.keys(state.processing).length === 0) {
      clearInterval(_completionPoll);
      _completionPoll = null;
      console.log('[poll] 沒有處理中，停止輪詢');
      return;
    }
    try {
      const result = await api.listMeetings();
      const meetings = result.meetings || [];
      const keys = Object.keys(state.processing);
      console.log(`[poll] 檢查 ${keys.length} 個處理中: [${keys.join(', ')}]，Notion 共 ${meetings.length} 筆`);
      let changed = false;

      keys.forEach(function (key) {
        let match;
        if (key.indexOf('study_') === 0) {
          const fileId = key.substring(6);
          match = meetings.find(m => m.studyUrl && m.studyUrl.indexOf(fileId) >= 0);
          if (!match) console.log(`[poll] ✗ 未匹配 ${key}（找不到 studyUrl 包含 ${fileId} 的紀錄）`);
        } else {
          const idx = key.indexOf('_');
          const date = key.substring(0, idx);
          const type = key.substring(idx + 1);
          match = meetings.find(function (m) {
            const d = m.date ? m.date.substring(0, 10) : '';
            return d === date && m.type === type;
          });
          if (!match) {
            const sameDate = meetings.filter(m => (m.date || '').substring(0, 10) === date);
            console.log(`[poll] ✗ 未匹配 ${key}: Notion 同日期 ${sameDate.length} 筆, types=[${sameDate.map(m => m.type).join(', ')}]`);
          }
        }
        if (match) {
          console.log(`[poll] ✓ 偵測完成：${match.topic}（清掉 ${key}）`);
          clearProcessing(key);
          changed = true;
        }
      });

      if (changed) {
        state.notionMeetings = meetings.map(function (m) {
          const d = formatDate(m.date);
          return Object.assign({}, m, {
            year: d.y, month: d.m, day: d.d, dow: d.dow,
            dateKey: m.date ? m.date.substring(0, 10) : '',
          });
        });
        DriveCache.invalidateAll();
        // 同步重新載入當前視圖的 Drive 資料（剛處理完的檔案應該不在 unprocessed 清單裡了）
        if (state.view === 'week' && state.weekDate) loadDriveForWeek(state.weekDate);
        else if (state.sm !== null) loadDriveForMonth(state.sy, state.sm);
        else loadDriveForYear(state.sy);
        render();
      }
    } catch (e) {
      console.warn(`[poll] 輪詢失敗（會重試）：${e.message}`);
    }
}

function pad2(n) { return String(n).padStart(2, '0'); }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function escapeAttr(s) { return escapeHtml(s); }

init();
