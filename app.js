// 列表頁邏輯
var TYPES = ['週二晚間', '週三晚間', '週五晚間', '安息日上午', '安息日晚間', '主日聚會'];
var DOW = ['日', '一', '二', '三', '四', '五', '六'];

var state = {
  meetings: [],
  filter: 'all',
  sq: '',
  pg: 1,
  sy: null,
  sm: null,
  theme: ThemeManager.get(),
};

var PP = state.theme === 'senior' ? 8 : 10;

function init() {
  // 渲染主題切換器
  document.getElementById('themeSlot').innerHTML = renderThemeSwitcher(state.theme);
  ThemeManager.apply(state.theme, 'app');
  bindThemeSwitcher('app', function (t) {
    state.theme = t;
    PP = t === 'senior' ? 8 : 10;
    state.pg = 1;
    render();
  });

  // 載入資料
  api.listMeetings()
    .then(function (data) {
      state.meetings = (data.meetings || []).map(function (m) {
        var d = formatDate(m.date);
        return Object.assign({}, m, {
          year: d.y, month: d.m, day: d.d, dow: d.dow,
          dateObj: d.raw,
          hasSum: !!(m.summary || m.fullContent),
        });
      });
      // 預設選擇最新一筆的年份
      if (state.meetings.length > 0) {
        var years = Array.from(new Set(state.meetings.map(function (x) { return x.year; }))).sort(function (a, b) { return b - a; });
        state.sy = years[0];
      }
      render();
    })
    .catch(function (err) {
      document.getElementById('root').innerHTML = '<div class="empty">載入失敗：' + err.message + '</div>';
    });
}

function getFiltered() {
  var l = state.meetings;
  if (state.sy) l = l.filter(function (x) { return x.year === state.sy; });
  if (state.sm !== null) l = l.filter(function (x) { return x.month === state.sm + 1; });
  if (state.filter !== 'all') l = l.filter(function (x) { return x.type === state.filter; });
  if (state.sq) {
    var q = state.sq.toLowerCase();
    l = l.filter(function (x) {
      return (x.topic || '').toLowerCase().indexOf(q) >= 0
          || (x.type || '').indexOf(q) >= 0
          || (x.speaker || '').indexOf(q) >= 0;
    });
  }
  return l;
}

function getMonthCounts() {
  var l = state.meetings.filter(function (x) { return x.year === state.sy; });
  if (state.filter !== 'all') l = l.filter(function (x) { return x.type === state.filter; });
  var c = []; for (var i = 0; i < 12; i++) c.push(0);
  l.forEach(function (x) { c[x.month - 1]++; });
  return c;
}

function getYears() {
  return Array.from(new Set(state.meetings.map(function (x) { return x.year; }))).sort(function (a, b) { return b - a; });
}

function render() {
  var fl = getFiltered();
  var tp = Math.max(1, Math.ceil(fl.length / PP));
  if (state.pg > tp) state.pg = tp;
  var sl = fl.slice((state.pg - 1) * PP, state.pg * PP);
  var mc = getMonthCounts();
  var years = getYears();
  var pub = fl.filter(function (x) { return x.status === '已發布'; }).length;
  var upc = fl.filter(function (x) { return x.status === '預告'; }).length;
  var drf = fl.filter(function (x) { return x.status === '草稿'; }).length;

  var h = '';
  // Search
  h += '<div class="search-wrap"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
  h += '<input class="search" type="text" placeholder="搜尋聚會主題、講員..." value="' + escapeAttr(state.sq) + '" id="si"></div>';

  // Type filters
  h += '<div class="filters" id="ft"><button class="chip ' + (state.filter === 'all' ? 'active' : '') + '" data-f="all">全部</button>';
  TYPES.forEach(function (t) {
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
  for (var i = 11; i >= 0; i--) {
    if (mc[i] > 0) {
      h += '<button class="nav-btn ' + (state.sm === i ? 'active' : '') + '" data-m="' + i + '">' + (i + 1) + '月<span class="cnt">' + mc[i] + '</span></button>';
    }
  }
  h += '</div>';

  // Stats
  h += '<div class="stats">';
  h += '<span class="s-item">共 <strong>' + fl.length + '</strong> 筆</span>';
  h += '<span class="s-item"><span class="dot-pub"></span>已發布 ' + pub + '</span>';
  h += '<span class="s-item"><span class="dot-up"></span>預告 ' + upc + '</span>';
  h += '<span class="s-item"><span class="dot-dr"></span>草稿 ' + drf + '</span>';
  h += '</div>';

  // List
  if (sl.length === 0) {
    h += '<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><br>找不到符合條件的聚會紀錄</div>';
  } else {
    h += '<div class="list" id="ml">';
    sl.forEach(function (m) {
      var bc = m.status === '已發布' ? 'badge-pub' : m.status === '預告' ? 'badge-up' : 'badge-draft';
      h += '<div class="row ' + (m.status === '預告' ? 'future' : '') + '" data-id="' + escapeAttr(m.id) + '">';
      h += '<div class="date-col"><div class="date-day">' + (m.day || '?') + '</div><div class="date-mon">' + (m.month || '?') + '月</div></div>';
      h += '<div class="info"><div class="info-title">' + escapeHtml(m.topic || '(未命名)') + '</div>';
      h += '<div class="info-meta"><span class="type-tag">' + escapeHtml(m.type || '') + '</span>';
      if (m.dow) h += '<span>週' + m.dow + '</span>';
      if (m.speaker) h += '<span>' + escapeHtml(m.speaker) + '</span>';
      if (m.hasSum) h += '<span class="has-sum">✓ 有摘要</span>';
      h += '<span class="badge ' + bc + '">' + escapeHtml(m.status || '') + '</span>';
      h += '</div></div>';
      h += '<span class="arrow">›</span>';
      h += '</div>';
    });
    h += '</div>';
  }

  // Pager
  if (tp > 1) {
    h += '<div class="pager" id="pgr">';
    h += '<button class="pg" data-p="prev" ' + (state.pg === 1 ? 'disabled' : '') + '>&lsaquo;</button>';
    var pages = [];
    if (tp <= 7) { for (var p = 1; p <= tp; p++) pages.push(p); }
    else {
      pages = [1];
      if (state.pg > 3) pages.push('…');
      for (var p2 = Math.max(2, state.pg - 1); p2 <= Math.min(tp - 1, state.pg + 1); p2++) pages.push(p2);
      if (state.pg < tp - 2) pages.push('…');
      pages.push(tp);
    }
    pages.forEach(function (p) {
      if (p === '…') h += '<span class="pg-info">…</span>';
      else h += '<button class="pg ' + (p === state.pg ? 'active' : '') + '" data-p="' + p + '">' + p + '</button>';
    });
    h += '<button class="pg" data-p="next" ' + (state.pg === tp ? 'disabled' : '') + '>&rsaquo;</button>';
    h += '</div>';
  }

  document.getElementById('root').innerHTML = h;
  bindEvents();
}

function bindEvents() {
  var si = document.getElementById('si');
  if (si) si.addEventListener('input', function (e) { state.sq = e.target.value; state.pg = 1; render(); });

  var ft = document.getElementById('ft');
  if (ft) ft.addEventListener('click', function (e) {
    var b = e.target.closest('.chip');
    if (!b) return;
    state.filter = b.dataset.f; state.pg = 1; render();
  });

  var yn = document.getElementById('yn');
  if (yn) yn.addEventListener('click', function (e) {
    var b = e.target.closest('.nav-btn');
    if (!b) return;
    state.sy = parseInt(b.dataset.y); state.sm = null; state.pg = 1; render();
  });

  var mn = document.getElementById('mn');
  if (mn) mn.addEventListener('click', function (e) {
    var b = e.target.closest('.nav-btn');
    if (!b) return;
    state.sm = b.dataset.m === 'x' ? null : parseInt(b.dataset.m);
    state.pg = 1; render();
  });

  var ml = document.getElementById('ml');
  if (ml) ml.addEventListener('click', function (e) {
    var b = e.target.closest('.row');
    if (!b) return;
    var id = b.dataset.id;
    if (id) location.href = 'meeting.html?id=' + encodeURIComponent(id) + (state.theme !== 'adult' ? '&theme=' + state.theme : '');
  });

  var pgr = document.getElementById('pgr');
  if (pgr) pgr.addEventListener('click', function (e) {
    var b = e.target.closest('.pg');
    if (!b || b.disabled) return;
    var v = b.dataset.p;
    if (v === 'prev') state.pg--;
    else if (v === 'next') state.pg++;
    else state.pg = parseInt(v);
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function escapeAttr(s) { return escapeHtml(s); }

init();
