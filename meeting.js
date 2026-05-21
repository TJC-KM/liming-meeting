// 詳細頁邏輯
(function () {
  var theme = ThemeManager.get();
  var device = DeviceManager.get();
  var params = new URLSearchParams(location.search);
  var id = params.get('id');
  var qDate = params.get('date');
  var qType = params.get('type');
  var qTopic = params.get('topic') || '';
  var qSpeaker = params.get('speaker') || '';
  var qSizeMB = params.get('sizeMB') || '';
  var qStudyFileId = params.get('studyFileId') || '';
  var qAudioFileId = params.get('audioFileId') || '';
  var processing = params.get('processing') === '1';
  var processingStartedAt = Date.now();

  ColorThemeManager.apply(ColorThemeManager.get());

  document.getElementById('themeSlot').innerHTML = renderThemeSwitcher(theme, null, device);
  ThemeManager.apply(theme, 'app');
  DeviceManager.apply(device, 'app');
  bindThemeSwitcher('app', function (change) {
    if (change.size) theme = change.size;
    if (change.device) device = change.device;
  });

  if (id) {
    loadById(id);
  } else if (qDate && qType) {
    // 等待模式：Worker 還在處理，poll Notion 直到出現
    // 但 player / download / 心得 是 Notion 寫入前就能用，所以一次性 render skeleton
    renderProcessingSkeleton();
    startPolling();
  } else {
    document.getElementById('root').innerHTML = '<div class="empty">缺少聚會 ID 或 date+type</div>';
  }

  function loadById(theId) {
    api.getMeeting(theId)
      .then(function (m) {
        document.title = (m.topic || '聚會紀錄') + ' - 教會聚會紀錄';
        document.getElementById('root').innerHTML = renderMeeting(m);
        bindActionButtons(m);
      })
      .catch(function (err) {
        document.getElementById('root').innerHTML = '<div class="empty">載入失敗：' + err.message + '</div>';
      });
  }

  // === 分享 + 心得 ===

  // 抽出 Drive 檔案 ID 當留言識別（錄音優先，否則用預查文件）
  function getRecordingId(m) {
    const url = m.audioUrl || m.studyUrl;
    if (!url) return null;
    const match = url.match(/\/d\/([^\/]+)/);
    return match ? match[1] : null;
  }

  // 留言的「類別」欄位：「2026-05-15 葡萄樹與枝子」
  function formatCommentCategory(m) {
    const date = m.date ? m.date.substring(0, 10) : '';
    const topic = m.topic || '';
    return date && topic ? date + ' ' + topic : (date || topic);
  }

  // 這篇 meeting 頁的乾淨分享 URL
  function getMeetingShareUrl(m) {
    return location.origin + location.pathname + (m.id ? '?id=' + encodeURIComponent(m.id) : '');
  }

  function bindActionButtons(m) {
    const shareBtn = document.getElementById('shareBtn');
    if (shareBtn) shareBtn.addEventListener('click', shareLink);

    const recId = getRecordingId(m);
    const commentsBtn = document.getElementById('commentsBtn');
    if (commentsBtn && recId) {
      commentsBtn.addEventListener('click', function () { openComments(m); });
    } else if (commentsBtn) {
      // 沒有錄音 ID（不太可能但保險）→ 隱藏按鈕
      commentsBtn.style.display = 'none';
    }

    const cpClose = document.getElementById('cpClose');
    if (cpClose) cpClose.addEventListener('click', closeComments);

    const cpSubmit = document.getElementById('cpSubmit');
    if (cpSubmit) cpSubmit.addEventListener('click', function () { submitComment(m); });
  }

  function shareLink() {
    // 分享乾淨的 URL（沒有 processing 等臨時參數）
    const u = new URL(location.href);
    const cleanParams = new URLSearchParams();
    if (u.searchParams.get('id')) cleanParams.set('id', u.searchParams.get('id'));
    if (u.searchParams.get('theme')) cleanParams.set('theme', u.searchParams.get('theme'));
    const shareUrl = u.origin + u.pathname + (cleanParams.toString() ? '?' + cleanParams.toString() : '');

    if (navigator.clipboard) {
      navigator.clipboard.writeText(shareUrl).then(showShareToast).catch(() => fallbackCopy(shareUrl));
    } else {
      fallbackCopy(shareUrl);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showShareToast();
    } catch (e) {
      showShareToast('複製失敗，請手動複製：' + text, true);
    }
    document.body.removeChild(ta);
  }

  function showShareToast(msg, isError) {
    const t = document.getElementById('shareToast');
    if (!t) return;
    t.textContent = msg || '🔗 連結已複製！';
    t.classList.toggle('error', !!isError);
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2500);
  }

  function openComments(m) {
    document.getElementById('cpFolderName').textContent = formatCommentCategory(m);
    document.getElementById('commentPanel').classList.add('on');
    loadComments(getRecordingId(m));
  }

  function closeComments() {
    document.getElementById('commentPanel').classList.remove('on');
  }

  async function loadComments(recordingId) {
    const list = document.getElementById('cpList');
    list.innerHTML = '<div class="cp-loading">載入中…</div>';
    try {
      const url = `${CONFIG.COMMENTS_GAS_URL}?mode=getComments&folderId=${encodeURIComponent(recordingId)}`;
      const r = await fetch(url);
      const data = await r.json();
      const comments = data.comments || [];
      if (comments.length === 0) {
        list.innerHTML = '<div class="cp-empty">還沒有心得，成為第一個留言的人吧！✨</div>';
        return;
      }
      list.innerHTML = comments.map(c => `
        <div class="comment-item">
          <div class="ci-top">
            <span class="ci-name">${escapeHtml(c.name || '匿名')}</span>
            <span class="ci-date">${escapeHtml(c.date || '')}</span>
          </div>
          <div class="ci-text">${escapeHtml(c.text || '')}</div>
        </div>
      `).join('');
    } catch (e) {
      list.innerHTML = '<div class="cp-empty">載入失敗，請稍後再試</div>';
    }
  }

  async function submitComment(m) {
    const name = document.getElementById('cpName').value.trim();
    const text = document.getElementById('cpText').value.trim();
    if (!text) { alert('請輸入心得內容'); return; }

    const recId = getRecordingId(m);
    const category = formatCommentCategory(m);
    const meetingUrl = getMeetingShareUrl(m);

    const btn = document.getElementById('cpSubmit');
    btn.disabled = true;
    btn.textContent = '送出中…';

    try {
      const url = `${CONFIG.COMMENTS_GAS_URL}?mode=addComment`
        + `&folderId=${encodeURIComponent(recId)}`
        + `&folderName=${encodeURIComponent(category)}`
        + `&name=${encodeURIComponent(name)}`
        + `&text=${encodeURIComponent(text)}`
        + `&meetingUrl=${encodeURIComponent(meetingUrl)}`;
      const r = await fetch(url);
      const data = await r.json();
      if (data.status === 'success') {
        document.getElementById('cpName').value = '';
        document.getElementById('cpText').value = '';
        loadComments(recId);
      } else {
        alert('送出失敗：' + (data.message || '未知錯誤'));
      }
    } catch (e) {
      alert('網路錯誤，請稍後再試');
    } finally {
      btn.disabled = false;
      btn.textContent = '送出心得';
    }
  }

  // 拼一個「處理中聚會」的合成物件，餵給心得 / 下載按鈕邏輯
  function buildProcessingMeeting() {
    return {
      topic: qTopic,
      type: qType,
      date: qDate,
      speaker: qSpeaker,
      audioUrl: qAudioFileId ? 'https://drive.google.com/file/d/' + qAudioFileId + '/view' : null,
      studyUrl: qStudyFileId ? 'https://drive.google.com/file/d/' + qStudyFileId + '/view' : null,
    };
  }

  // 處理中：一次性 render 完整骨架（header + player + actions + AI skeleton）
  // 不再有計時器，避免引導客戶注意「為什麼這麼久」
  function renderProcessingSkeleton() {
    document.title = (qTopic || '處理中') + ' - 教會聚會紀錄';
    var m = buildProcessingMeeting();

    var h = '';
    // Header
    h += '<div class="meeting-header">';
    h += '<div class="meeting-title">' + escapeHtml(qTopic || '(處理中)') + '</div>';
    h += '<div class="meeting-meta">';
    h += '<span class="type-tag">' + escapeHtml(qType) + '</span>';
    h += '<span class="badge badge-processing">處理中</span>';
    h += '<span>📅 ' + escapeHtml(qDate) + '</span>';
    if (qSpeaker) h += '<span>🎤 ' + escapeHtml(qSpeaker) + '</span>';
    h += '</div></div>';

    // === 右側 aside：播放器 + 按鈕 + 處理中提示 ===
    h += '<aside class="meeting-aside">';

    if (qAudioFileId) {
      h += '<div class="audio-embed">';
      h += '<iframe src="https://drive.google.com/file/d/' + escapeAttr(qAudioFileId) + '/preview" allow="autoplay" frameborder="0"></iframe>';
      h += '</div>';
    }

    h += '<div class="actions">';
    if (m.audioUrl) {
      h += '<a class="action-btn" href="' + escapeAttr(m.audioUrl) + '" target="_blank" rel="noopener">';
      h += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
      h += '下載錄音</a>';
    }
    if (m.studyUrl) {
      h += '<a class="action-btn" href="' + escapeAttr(m.studyUrl) + '" target="_blank" rel="noopener">';
      h += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
      h += '下載預查文件</a>';
    }
    h += '<button class="action-btn" disabled title="處理完成後可分享">';
    h += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';
    h += '分享連結</button>';
    if (m.audioUrl || m.studyUrl) {
      h += '<button class="action-btn" id="commentsBtn">';
      h += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>';
      h += '心得回饋</button>';
    }
    h += '</div>';

    h += '<div class="processing-hint">';
    h += '<span class="ph-icon">📝</span>';
    h += '<div class="ph-text">';
    h += '<div class="ph-title">此聚會的重點整理正在準備中</div>';
    h += '<div class="ph-sub">您可以先' + (qAudioFileId ? '聽錄音、' : '') + '留下心得感想，整理完成後再回來查看</div>';
    h += '</div></div>';

    h += '</aside>';

    // === 左側 main：三段 skeleton（重點內容會出現的位置）===
    h += '<main class="meeting-main">';

    h += '<div class="section section-skeleton">';
    h += '<div class="section-title">📝 簡易重點</div>';
    h += '<div class="section-body">';
    h += '<div class="skeleton-line" style="width:90%"></div>';
    h += '<div class="skeleton-line" style="width:75%"></div>';
    h += '<div class="skeleton-line" style="width:85%"></div>';
    h += '</div></div>';

    h += '<div class="section section-skeleton">';
    h += '<div class="section-title">📖 完整重點</div>';
    h += '<div class="section-body">';
    h += '<div class="skeleton-line" style="width:95%"></div>';
    h += '<div class="skeleton-line" style="width:88%"></div>';
    h += '<div class="skeleton-line" style="width:92%"></div>';
    h += '<div class="skeleton-line" style="width:70%"></div>';
    h += '</div></div>';

    h += '<div class="section section-skeleton">';
    h += '<div class="section-title">✝️ 參考經文</div>';
    h += '<div class="section-body">';
    h += '<div class="skeleton-line" style="width:60%"></div>';
    h += '<div class="skeleton-line" style="width:90%"></div>';
    h += '</div></div>';

    h += '</main>';

    document.getElementById('root').innerHTML = h;

    // 綁定心得 / 留言面板按鈕（一次性）
    const commentsBtn = document.getElementById('commentsBtn');
    if (commentsBtn) commentsBtn.addEventListener('click', function () { openComments(m); });
    const cpClose = document.getElementById('cpClose');
    if (cpClose) cpClose.addEventListener('click', closeComments);
    const cpSubmit = document.getElementById('cpSubmit');
    if (cpSubmit) cpSubmit.addEventListener('click', function () { submitComment(m); });
  }

  function startPolling() {
    var POLL_INTERVAL_MS = 10000;  // 每 10 秒
    var MAX_POLL_MS = 12 * 60 * 1000;  // 12 分鐘上限

    var poll = setInterval(async function () {
      if (Date.now() - processingStartedAt > MAX_POLL_MS) {
        clearInterval(poll);
        // 超時：靜默放棄 polling，使用者畫面保持原樣（播放器、心得仍可用）
        // 不顯示錯誤訊息，因為 worker 端可能還在處理；下次重新整理就會看到
        console.warn('[poll] 超過 12 分鐘未見 Notion 紀錄，停止輪詢');
        return;
      }
      try {
        const result = await api.listMeetings();
        // 預查處理時用 studyUrl 比對 fileId（真實日期可能與估計不同）
        // 一般錄音則用 date + type
        const found = (result.meetings || []).find(m => {
          if (qStudyFileId && m.studyUrl) {
            return m.studyUrl.indexOf(qStudyFileId) >= 0;
          }
          const d = m.date ? m.date.substring(0, 10) : '';
          return d === qDate && m.type === qType;
        });
        if (found) {
          clearInterval(poll);
          loadById(found.id);
        }
      } catch (e) {
        console.warn('[poll] 失敗（會重試）:', e.message);
      }
    }, POLL_INTERVAL_MS);
  }

  function renderMeeting(m) {
    var d = formatDate(m.date);
    var bc = m.status === '已發布' ? 'badge-pub' : m.status === '預告' ? 'badge-up' : 'badge-draft';

    var h = '';
    // Header（電腦版會放在 grid 頂端 full-width，手機版正常 flow）
    h += '<div class="meeting-header">';
    h += '<div class="meeting-title">' + escapeHtml(m.topic || '(未命名)') + '</div>';
    h += '<div class="meeting-meta">';
    h += '<span class="type-tag">' + escapeHtml(m.type || '') + '</span>';
    h += '<span class="badge ' + bc + '">' + escapeHtml(m.status || '') + '</span>';
    if (d.full) h += '<span>📅 ' + d.full + '</span>';
    if (m.speaker) h += '<span>🎤 ' + escapeHtml(m.speaker) + '</span>';
    h += '</div></div>';

    // === 右側 aside：播放器 + 按鈕 === （手機版正常 flow 在 header 之下）
    h += '<aside class="meeting-aside">';

    if (m.audioUrl) {
      const driveFileId = (m.audioUrl.match(/\/d\/([^\/]+)/) || [])[1];
      if (driveFileId) {
        h += '<div class="audio-embed">';
        h += '<iframe src="https://drive.google.com/file/d/' + escapeAttr(driveFileId) + '/preview" allow="autoplay" frameborder="0"></iframe>';
        h += '</div>';
      }
    }

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
    if (m.studyUrl) {
      h += '<a class="action-btn" href="' + escapeAttr(m.studyUrl) + '" target="_blank" rel="noopener">';
      h += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
      h += '下載預查文件</a>';
    }
    if (m.id) {
      const notionUrl = 'https://www.notion.so/' + m.id.replace(/-/g, '');
      h += '<a class="action-btn" href="' + escapeAttr(notionUrl) + '" target="_blank" rel="noopener">';
      h += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
      h += '在 Notion 編輯</a>';
    }
    h += '<button class="action-btn" id="shareBtn">';
    h += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';
    h += '分享連結</button>';
    if (m.id) {
      h += '<button class="action-btn" id="commentsBtn">';
      h += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>';
      h += '心得回饋</button>';
    }
    h += '</div>';

    h += '</aside>';

    // === 左側 main：重點內容（電腦版的視覺主角）===
    h += '<main class="meeting-main">';

    if (m.info) {
      h += '<div class="section">';
      h += '<div class="section-title">📢 聚會資訊</div>';
      h += '<div class="section-body">' + escapeHtml(m.info) + '</div>';
      h += '</div>';
    }

    if (m.summary) {
      h += '<div class="section">';
      h += '<div class="section-title">📝 簡易重點</div>';
      h += '<div class="summary-box">' + escapeHtml(m.summary) + '</div>';
      h += '</div>';
    }

    var hasBody = m.blocks && m.blocks.length > 0;
    if (hasBody) h += renderBlocks(m.blocks);

    if (!m.info && !m.summary && !hasBody) {
      h += '<div class="empty">此聚會尚未有整理內容</div>';
    }

    h += '</main>';

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
