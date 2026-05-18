// 列表頁：行事曆視圖
// 每個月顯示所有預期聚會的時段（週二/三/五晚 + 安息日上下午）
// 每列三種狀態：filled (有 Notion) / pending (Drive 有錄音待處理) / empty (預期但無資料)

const SCHEDULE = {
  // dow -> 預期類型陣列
  2: ['週二晚間'],
  3: ['週三晚間'],
  5: ['週五晚間'],
  6: ['安息日上午', '安息日晚間'],
};

const ALL_TYPES = ['週二晚間', '週三晚間', '週五晚間', '安息日上午', '安息日晚間', '主日聚會'];

var state = {
  notionMeetings: [],
  driveFiles: [],
  filter: 'all',
  sq: '',
  sy: null,
  sm: null,           // null = 全年; 0-11 = 月份
  theme: ThemeManager.get(),
  loading: true,
  driveError: null,
  processing: {},     // key = `${date}_${type}`, value = true while processing
};

function init() {
  document.getElementById('themeSlot').innerHTML = renderThemeSwitcher(state.theme);
  ThemeManager.apply(state.theme, 'app');
  bindThemeSwitcher('app', function (t) { state.theme = t; render(); });

  loadAll();
}

async function loadAll() {
  state.loading = true;
  render();

  // 同時抓 Notion + GAS（GAS 沒設就跳過）
  const tasks = [api.listMeetings()];
  if (gasApi.enabled()) tasks.push(gasApi.listUnprocessed().catch(e => ({ error: e.message })));

  try {
    const results = await Promise.all(tasks);
    state.notionMeetings = (results[0].meetings || []).map(function (m) {
      const d = formatDate(m.date);
      return Object.assign({}, m, {
        year: d.y, month: d.m, day: d.d, dow: d.dow,
        dateKey: m.date ? m.date.substring(0, 10) : '',
      });
    });

    if (results[1]) {
      if (results[1].error) {
        state.driveError = results[1].error;
        state.driveFiles = [];
      } else {
        state.driveFiles = (results[1].files || []).filter(f => f.parseable);
      }
    }

    // 預設選擇本月
    const now = new Date();
    state.sy = now.getFullYear();
    state.sm = now.getMonth();
  } catch (err) {
    document.getElementById('root').innerHTML = '<div class="empty">載入失敗：' + err.message + '</div>';
    return;
  }

  state.loading = false;
  render();
}

// 為指定年月生成所有預期 row
function buildRowsForMonth(year, month0) {
  // month0: 0-11
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

// 把預期 row 對應到實際資料（Notion / Drive）
function enrichRow(slot) {
  const dateKey = `${slot.year}-${pad2(slot.month)}-${pad2(slot.day)}`;
  const dateStr = `${slot.year}-${pad2(slot.month)}-${pad2(slot.day)}`;

  // 找 Notion 紀錄
  const notion = state.notionMeetings.find(function (m) {
    return m.dateKey === dateKey && m.type === slot.type;
  });
  if (notion) return Object.assign({}, slot, notion, { _state: 'filled' });

  // 找 Drive 錄音
  const drive = state.driveFiles.find(function (f) {
    return f.date === dateStr && f.type === slot.type;
  });
  if (drive) return Object.assign({}, slot, { _state: 'pending', driveFile: drive });

  // 預期但無資料
  const now = new Date();
  const slotDate = new Date(slot.year, slot.month - 1, slot.day);
  const isFuture = slotDate > now;
  return Object.assign({}, slot, { _state: isFuture ? 'future' : 'empty' });
}

// 加入「特殊事件」：Notion 內有但不在預期排程的紀錄（例如主日聚會）
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
    // 全年 mode：12 個月併在一起
    for (let m = 0; m < 12; m++) {
      const monthRows = buildRowsForMonth(state.sy, m).map(enrichRow);
      addSpecialEvents(monthRows, state.sy, m);
      rows = rows.concat(monthRows);
    }
  }

  // 排序：日期降冪，同日依類型
  rows.sort(function (a, b) {
    if (a.year !== b.year) return b.year - a.year;
    if (a.month !== b.month) return b.month - a.month;
    if (a.day !== b.day) return b.day - a.day;
    return ALL_TYPES.indexOf(a.type) - ALL_TYPES.indexOf(b.type);
  });

  // 套用篩選
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
  state.driveFiles.forEach(f => {
    if (f.date) set.add(parseInt(f.date.substring(0, 4)));
  });
  return Array.from(set).sort((a, b) => b - a);
}

function getMonthCounts() {
  // 各月有「有資料」(filled or pending) 的數量
  const c = []; for (let i = 0; i < 12; i++) c.push(0);
  state.notionMeetings.forEach(function (m) {
    if (m.year === state.sy && m.month) c[m.month - 1]++;
  });
  state.driveFiles.forEach(function (f) {
    if (!f.date) return;
    const yr = parseInt(f.date.substring(0, 4));
    const mo = parseInt(f.date.substring(5, 7));
    if (yr === state.sy) c[mo - 1]++;
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

  // Search
  h += '<div class="search-wrap"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
  h += '<input class="search" type="text" placeholder="搜尋主題、講員..." value="' + escapeAttr(state.sq) + '" id="si"></div>';

  // Type filters
  h += '<div class="filters" id="ft"><button class="chip ' + (state.filter === 'all' ? 'active' : '') + '" data-f="all">全部</button>';
  ALL_TYPES.forEach(function (t) {
    h += '<button class="chip ' + (state.filter === t ? 'active' : '') + '" data-f="' + t + '">' + t + '</button>';
  });
  h += '</div>';

  // Year nav
  if (years.length > 0) {
    h += '<div class="nav-row" id="yn"><span class="nav-label">年份</span>';
    years.forEach(function (y) {
      h += '<button class="nav-btn ' + (state.sy === y ? 'active' : '') + '" data-y="' + y + '">' + y + '</button>';
    });
    h += '</div>';
  }

  // Month nav
  h += '<div class="nav-row" id="mn"><span class="nav-label">月份</span><button class="nav-btn ' + (state.sm === null ? 'active' : '') + '" data-m="x">全年</button>';
  for (let i = 11; i >= 0; i--) {
    h += '<button class="nav-btn ' + (state.sm === i ? 'active' : '') + '" data-m="' + i + '">' + (i + 1) + '月';
    if (mc[i] > 0) h += '<span class="cnt">' + mc[i] + '</span>';
    h += '</button>';
  }
  h += '</div>';

  // Stats
  h += '<div class="stats">';
  h += '<span class="s-item">本月 <strong>' + rows.length + '</strong> 場聚會</span>';
  h += '<span class="s-item"><span class="dot-pub"></span>已紀錄 ' + filled + '</span>';
  if (gasApi.enabled()) {
    h += '<span class="s-item"><span class="dot-up"></span>待處理 ' + pending + '</span>';
  }
  if (state.driveError) {
    h += '<span class="s-item" style="color:var(--warn-tx)">⚠ Drive 連線失敗：' + escapeHtml(state.driveError) + '</span>';
  }
  h += '</div>';

  // List
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

  if (st === 'filled' && r.topic) {
    h += `<div class="info-title">${escapeHtml(r.topic)}</div>`;
  } else {
    h += `<div class="info-title info-title-empty">${escapeHtml(r.type)}</div>`;
  }

  h += '<div class="info-meta">';
  if (st === 'filled') {
    h += `<span class="type-tag">${escapeHtml(r.type)}</span>`;
  }
  h += `<span>週${DOW_NAMES[r.dow]}</span>`;
  if (r.speaker) h += `<span>${escapeHtml(r.speaker)}</span>`;
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
    state.sy = parseInt(b.dataset.y); state.sm = null; render();
  });

  const mn = document.getElementById('mn');
  if (mn) mn.addEventListener('click', function (e) {
    const b = e.target.closest('.nav-btn');
    if (!b) return;
    state.sm = b.dataset.m === 'x' ? null : parseInt(b.dataset.m);
    render();
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

  const ok = confirm(`處理 ${date} ${type} 的錄音檔？\n\n會送給 Gemini 整理為主題、重點、經文，預計 1-2 分鐘。處理完成後會自動建立 Notion 草稿。`);
  if (!ok) return;

  state.processing[key] = true;
  render();

  try {
    const result = await gasApi.process(date, type);
    if (result.success) {
      alert(`完成！\n\n主題：${result.topic}\n講員：${result.speaker || '(未指定)'}\n\n已建立 Notion 草稿，請至 Notion 校稿後將狀態改為「已發布」。`);
      await loadAll();
    } else {
      throw new Error(result.error || '未知錯誤');
    }
  } catch (err) {
    alert(`處理失敗：${err.message}`);
    delete state.processing[key];
    render();
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
