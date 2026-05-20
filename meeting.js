// 詳細頁邏輯
(function () {
  var theme = ThemeManager.get();
  var id = new URLSearchParams(location.search).get('id');

  document.getElementById('themeSlot').innerHTML = renderThemeSwitcher(theme);
  ThemeManager.apply(theme, 'app');
  bindThemeSwitcher('app', function (t) { theme = t; });

  if (!id) {
    document.getElementById('root').innerHTML = '<div class="empty">缺少聚會 ID</div>';
    return;
  }

  api.getMeeting(id)
    .then(function (m) {
      document.title = (m.topic || '聚會紀錄') + ' - 教會聚會紀錄';
      document.getElementById('root').innerHTML = renderMeeting(m);
    })
    .catch(function (err) {
      document.getElementById('root').innerHTML = '<div class="empty">載入失敗：' + err.message + '</div>';
    });

  function renderMeeting(m) {
    var d = formatDate(m.date);
    var bc = m.status === '已發布' ? 'badge-pub' : m.status === '預告' ? 'badge-up' : 'badge-draft';

    var h = '';
    // Header
    h += '<div class="meeting-header">';
    h += '<div class="meeting-title">' + escapeHtml(m.topic || '(未命名)') + '</div>';
    h += '<div class="meeting-meta">';
    h += '<span class="type-tag">' + escapeHtml(m.type || '') + '</span>';
    h += '<span class="badge ' + bc + '">' + escapeHtml(m.status || '') + '</span>';
    if (d.full) h += '<span>📅 ' + d.full + '</span>';
    if (m.speaker) h += '<span>🎤 ' + escapeHtml(m.speaker) + '</span>';
    h += '</div></div>';

    // 操作列
    if (m.audioUrl || m.attachmentUrl) {
      h += '<div class="actions">';
      if (m.audioUrl) {
        h += '<a class="action-btn" href="' + escapeAttr(m.audioUrl) + '" target="_blank" rel="noopener">';
        h += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg>';
        h += '聆聽錄音</a>';
      }
      if (m.attachmentUrl) {
        h += '<a class="action-btn" href="' + escapeAttr(m.attachmentUrl) + '" target="_blank" rel="noopener">';
        h += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>';
        h += '附件資料夾</a>';
      }
      h += '</div>';
    }

    // 聚會資訊（預告用）
    if (m.info) {
      h += '<div class="section">';
      h += '<div class="section-title">📢 聚會資訊</div>';
      h += '<div class="section-body">' + escapeHtml(m.info) + '</div>';
      h += '</div>';
    }

    // 簡易重點（property，永遠顯示在最上面方便快速瀏覽）
    if (m.summary) {
      h += '<div class="section">';
      h += '<div class="section-title">📝 簡易重點</div>';
      h += '<div class="summary-box">' + escapeHtml(m.summary) + '</div>';
      h += '</div>';
    }

    var hasContent = false;

    // 新格式：page body 的 blocks（heading_2 / heading_3 / paragraph / bulleted_list_item）
    if (m.blocks && m.blocks.length > 0) {
      h += renderBlocks(m.blocks);
      hasContent = true;
    } else {
      // 舊格式：fallback 到 property 渲染（向後相容）
      if (m.fullContent) {
        h += '<div class="section">';
        h += '<div class="section-title">📖 完整重點</div>';
        h += '<div class="section-body">' + escapeHtml(m.fullContent) + '</div>';
        h += '</div>';
        hasContent = true;
      }
      var verses = parseVerses(m.verses);
      if (verses.length > 0) {
        h += '<div class="section">';
        h += '<div class="section-title">✝️ 參考經文</div>';
        verses.forEach(function (v) {
          h += '<div class="verse-card">';
          h += '<div class="verse-ref">' + escapeHtml(v.ref) + '</div>';
          if (v.chinese) h += '<div class="verse-chinese">' + escapeHtml(v.chinese) + '</div>';
          if (v.english) h += '<div class="verse-english">' + escapeHtml(v.english) + '</div>';
          h += '</div>';
        });
        h += '</div>';
        hasContent = true;
      }
    }

    if (!m.info && !m.summary && !hasContent) {
      h += '<div class="empty">此聚會尚未有整理內容</div>';
    }

    return h;
  }

  // 渲染 Notion blocks 為 HTML，把 heading_2 分割成 section 卡片
  function renderBlocks(blocks) {
    var h = '';
    var section = null;        // 當前 section 內容
    var sectionTitle = '';
    var inList = false;
    var simpleHeader = '';

    // 「簡易重點」section 已經從 property 顯示了，body 內若有同名 heading 就跳過
    var skipSimple = true;

    function openSection(title) {
      closeSection();
      sectionTitle = title;
      section = '';
    }
    function closeSection() {
      if (section === null) return;
      closeList();
      var icon = sectionTitle === '完整重點' ? '📖'
              : sectionTitle === '參考經文' ? '✝️'
              : '📄';
      h += '<div class="section">';
      h += '<div class="section-title">' + icon + ' ' + escapeHtml(sectionTitle) + '</div>';
      h += '<div class="section-body">' + section + '</div>';
      h += '</div>';
      section = null;
      sectionTitle = '';
    }
    function openList() {
      if (!inList) { section += '<ul class="md-list">'; inList = true; }
    }
    function closeList() {
      if (inList) { section += '</ul>'; inList = false; }
    }
    function append(html) {
      closeList();
      if (section === null) {
        // 沒進入 section 就直接寫到 h（不太會發生）
        h += html;
      } else {
        section += html;
      }
    }

    blocks.forEach(function (b) {
      if (b.type === 'heading_2') {
        // 一級標題：開新 section
        if (skipSimple && b.text.indexOf('簡易重點') >= 0) {
          // skip，因為已在 property 顯示
          openSection(b.text);
          section = null; sectionTitle = '';  // 標記為「不要實際開」
          return;
        }
        openSection(b.text);
      } else if (b.type === 'heading_3') {
        // 二級標題：在 section 內當小標
        if (section !== null) {
          closeList();
          section += '<div class="md-subhead">' + escapeHtml(b.text) + '</div>';
        }
      } else if (b.type === 'bulleted_list_item') {
        if (section === null) openSection('內容');
        openList();
        section += '<li>' + escapeHtml(b.text) + '</li>';
      } else {
        // paragraph 或其他
        if (section === null) openSection('內容');
        if (b.text.trim()) {
          closeList();
          section += '<p>' + escapeHtml(b.text) + '</p>';
        }
      }
    });
    closeSection();
    return h;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s); }
})();
