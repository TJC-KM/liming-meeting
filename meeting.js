// 詳細頁邏輯
(function () {
  var theme = ThemeManager.get();
  var id = new URLSearchParams(location.search).get('id');

  ColorThemeManager.apply(ColorThemeManager.get());

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

    // 嵌入錄音播放器（Drive preview iframe，可以播放）
    if (m.audioUrl) {
      const driveFileId = (m.audioUrl.match(/\/d\/([^\/]+)/) || [])[1];
      if (driveFileId) {
        h += '<div class="audio-embed">';
        h += '<iframe src="https://drive.google.com/file/d/' + escapeAttr(driveFileId) + '/preview" allow="autoplay" frameborder="0"></iframe>';
        h += '</div>';
      }
    }

    // 操作列
    h += '<div class="actions">';
    if (m.audioUrl) {
      h += '<a class="action-btn" href="' + escapeAttr(m.audioUrl) + '" target="_blank" rel="noopener">';
      h += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
      h += '下載錄音</a>';
    }
    if (m.attachmentUrl) {
      h += '<a class="action-btn" href="' + escapeAttr(m.attachmentUrl) + '" target="_blank" rel="noopener">';
      h += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>';
      h += '附件資料夾</a>';
    }
    if (m.id) {
      const notionUrl = 'https://www.notion.so/' + m.id.replace(/-/g, '');
      h += '<a class="action-btn" href="' + escapeAttr(notionUrl) + '" target="_blank" rel="noopener">';
      h += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
      h += '在 Notion 編輯</a>';
    }
    h += '</div>';

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

    // 完整重點與參考經文：從 Notion page body 的 markdown blocks 渲染
    var hasBody = m.blocks && m.blocks.length > 0;
    if (hasBody) h += renderBlocks(m.blocks);

    if (!m.info && !m.summary && !hasBody) {
      h += '<div class="empty">此聚會尚未有整理內容</div>';
    }

    return h;
  }

  // 把 Notion blocks 渲染成 section 卡片
  // heading_2 = section 標題；heading_3 = subhead；bulleted_list_item = list；其他 = paragraph
  // 「簡易重點」section 整段跳過（標題與內容都跳，已從 property 顯示在最上面）
  function renderBlocks(blocks) {
    var h = '';
    var section = null;
    var sectionTitle = '';
    var inList = false;
    var inSimpleSection = false;  // 是否在「簡易重點」section 內（需要整段跳過）

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

    blocks.forEach(function (b) {
      if (b.type === 'heading_2') {
        // 進入新 section；判斷是否要跳過
        inSimpleSection = b.text.indexOf('簡易重點') >= 0;
        if (inSimpleSection) {
          closeSection();
          return;
        }
        openSection(b.text);
        return;
      }

      // 簡易重點 section 內的所有內容都跳過
      if (inSimpleSection) return;

      if (b.type === 'heading_3') {
        if (section !== null) {
          closeList();
          section += '<div class="md-subhead">' + escapeHtml(b.text) + '</div>';
        }
      } else if (b.type === 'bulleted_list_item') {
        if (section === null) openSection('內容');
        openList();
        section += '<li>' + escapeHtml(b.text) + '</li>';
      } else if (b.text && b.text.trim()) {
        if (section === null) openSection('內容');
        closeList();
        section += '<p>' + escapeHtml(b.text) + '</p>';
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
