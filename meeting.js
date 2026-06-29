// 詳細頁邏輯
(function () {
  var theme = ThemeManager.get();
  var view = ViewManager.get();   // 跟 index 同一個 localStorage 來源
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

  document.getElementById('themeSlot').innerHTML = renderThemeSwitcher(theme, null, view);
  ThemeManager.apply(theme, 'app');
  ViewManager.apply(view, 'app');
  // view 改變只影響佈局（窄/寬），不需要重打 API
  bindThemeSwitcher('app', function (change) {
    if (change.size) theme = change.size;
    if (change.view) view = change.view;
  });

  if (id) {
    loadById(id);
  } else if (qAudioFileId && !processing) {
    // 待轉檔模式：有音檔但尚未觸發轉錄，讓使用者決定是否排隊
    renderPendingAudio();
  } else if (qDate && qType) {
    // 等待模式：Worker 還在處理，poll Notion 直到出現
    // 但 player / download / 心得 是 Notion 寫入前就能用，所以一次性 render skeleton
    renderProcessingSkeleton();
    startPolling();
  } else {
    document.getElementById('root').innerHTML = '<div class="empty">缺少聚會 ID 或 date+type</div>';
  }

  // 狀態屬於「處理中」的字串（worker 各階段會 update）→ 需 5 秒快輪詢
  var PROCESSING_STATUSES = ['處理中', '下載中', 'AI 分析中', 'AI 分析中（前半）', 'AI 分析中（後半）', '整合中', '寫入內容'];
  var _statusPoll = null;
  function isProcessingStatus(s) { return s && PROCESSING_STATUSES.indexOf(s) >= 0; }
  // 「待重試 N/3」→ cron 之後才會重跑（最多 6 小時），用 60 秒慢輪詢
  function isRetryStatus(s) { return /^待重試\s*\d+\/\d+/.test(String(s || '')); }

  function loadById(theId) {
    api.getMeeting(theId)
      .then(function (m) {
        document.title = (m.topic || '聚會紀錄') + ' - 教會聚會紀錄';
        document.getElementById('root').innerHTML = renderMeeting(m);
        bindActionButtons(m);
        // 處理中 → 5 秒快輪詢；待重試 → 60 秒慢輪詢；其他（草稿/失敗）→ 停止
        if (isProcessingStatus(m.status)) startStatusPolling(theId, 5000);
        else if (isRetryStatus(m.status)) startStatusPolling(theId, 60000);
        else stopStatusPolling();
      })
      .catch(function (err) {
        document.getElementById('root').innerHTML = '<div class="empty">載入失敗：' + err.message + '</div>';
      });
  }

  function startStatusPolling(theId, intervalMs) {
    stopStatusPolling();
    _statusPoll = setInterval(function () { loadById(theId); }, intervalMs || 5000);
  }
  function stopStatusPolling() {
    if (_statusPoll) { clearInterval(_statusPoll); _statusPoll = null; }
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

    // 失敗 banner 的重試按鈕：自動 archive 此筆 + 重建 placeholder + 跳新頁
    const retryBtn = document.getElementById('retryBtn');
    if (retryBtn) {
      retryBtn.addEventListener('click', async function () {
        const fid = retryBtn.dataset.fileid;
        const dateStr = retryBtn.dataset.date;
        const type = retryBtn.dataset.type;
        retryBtn.disabled = true;
        retryBtn.textContent = '處理中…';
        try {
          const r = await api.process(dateStr, type, fid);
          if (r && r.notionId) {
            location.href = 'meeting.html?id=' + encodeURIComponent(r.notionId);
            return;
          }
          alert('重試失敗：worker 未回 notionId');
          retryBtn.disabled = false;
          retryBtn.textContent = '🔁 重試';
        } catch (e) {
          alert('重試失敗：' + e.message);
          retryBtn.disabled = false;
          retryBtn.textContent = '🔁 重試';
        }
      });
    }

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

  // 待轉檔：有音檔但尚未觸發，讓使用者決定是否加入排隊
  function renderPendingAudio() {
    document.title = (qTopic || '待轉檔') + ' - 教會聚會紀錄';
    var h = '';

    h += '<div class="meeting-header">';
    h += '<div class="meeting-title">' + escapeHtml(qTopic || '(未命名)') + '</div>';
    h += '<div class="meeting-meta">';
    h += '<span class="type-tag">' + escapeHtml(qType) + '</span>';
    h += '<span class="badge badge-pending">待轉錄</span>';
    if (qDate) h += '<span>📅 ' + escapeHtml(qDate) + '</span>';
    if (qSpeaker) h += '<span>🎤 ' + escapeHtml(qSpeaker) + '</span>';
    h += '</div></div>';

    h += '<aside class="meeting-aside">';
    h += audioPlayerHTML(qAudioFileId);
    h += '<div class="actions">';
    h += '<button type="button" class="action-btn" id="btnQueue">📋 加入轉錄排隊</button>';
    h += '</div>';
    if (qSizeMB) h += '<p class="meeting-info-note">檔案大小：' + escapeHtml(qSizeMB) + ' MB</p>';
    h += '<p class="meeting-info-note">排隊後將於下次排程時間（每天 06:30、12:30、15:30、21:30）自動轉錄。</p>';
    h += '</aside>';

    h += '<div class="meeting-body"></div>';
    document.getElementById('root').innerHTML = h;

    var btn = document.getElementById('btnQueue');
    if (btn) {
      btn.addEventListener('click', function () {
        btn.disabled = true;
        btn.textContent = '排隊中...';
        gasApi.queue(qAudioFileId)
          .then(function (r) {
            var nextTime = getNextScheduleTime(r.position || 0);
            btn.textContent = '✓ 已加入排隊，約 ' + nextTime + ' 處理';
            btn.classList.add('btn-success');
          })
          .catch(function (e) {
            btn.disabled = false;
            btn.textContent = '📋 加入轉錄排隊';
            alert('排隊失敗：' + e.message);
          });
      });
    }
  }

  function getNextScheduleTime(skip) {
    var slots = [6*60+30, 9*60, 12*60+30, 16*60, 18*60+30, 21*60+30];
    var now = new Date();
    var taipeiMin = ((now.getUTCHours() + 8) % 24) * 60 + now.getUTCMinutes();
    var found = 0;
    for (var i = 0; i < slots.length * 2; i++) {
      var s = slots[i % slots.length];
      if (s > taipeiMin || i >= slots.length) {
        if (found >= skip) {
          var h = Math.floor(s / 60), m = s % 60;
          return h + ':' + (m < 10 ? '0' : '') + m;
        }
        found++;
        taipeiMin = s;
      }
    }
    return '下次排程';
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
      h += audioPlayerHTML(qAudioFileId);
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
        // fileId 比對為主（每個檔唯一 → 同日同時段多場活動不會撞）
        // 沒 fileId 才回退到 date+type
        const found = (result.meetings || []).find(m => {
          if (qStudyFileId && m.studyUrl) {
            return m.studyUrl.indexOf(qStudyFileId) >= 0;
          }
          if (qAudioFileId && m.audioUrl) {
            return m.audioUrl.indexOf(qAudioFileId) >= 0;
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
    var bc = m.status === '已發布' ? 'badge-pub' : m.status === '預告' ? 'badge-up' : m.status === '失敗' ? 'badge-failed' : 'badge-draft';

    var h = '';

    // 處理中 banner：藍色，旋轉 icon + 當前階段
    if (isProcessingStatus(m.status)) {
      h += '<div class="proc-banner proc-banner-running">';
      h += '<div class="proc-spinner"></div>';
      h += '<div class="proc-body">';
      h += '<div class="proc-title">📡 處理中：' + escapeHtml(m.status) + '</div>';
      h += '<div class="proc-sub">頁面 5 秒自動更新一次，請稍候（大檔可能 2-3 分鐘）</div>';
      h += '</div></div>';
    }
    // 待重試 banner：橘色，告訴使用者系統會自動重試、可關頁
    else if (isRetryStatus(m.status)) {
      h += '<div class="proc-banner proc-banner-retry">';
      h += '<div class="proc-icon">⏳</div>';
      h += '<div class="proc-body">';
      h += '<div class="proc-title">已排入自動重試佇列（' + escapeHtml(m.status) + '）</div>';
      h += '<div class="proc-sub">AI 服務當下忙線，系統會在背景自動再試（最晚數小時內）。<strong>你可以關閉此頁</strong>，稍後再回來看，或按下方立即重試。</div>';
      if (m.processingError) h += '<div class="proc-err">' + escapeHtml(m.processingError) + '</div>';
      var rfid = '';
      if (m.audioUrl) { var rm = m.audioUrl.match(/\/d\/([^\/]+)/); if (rm) rfid = rm[1]; }
      if (rfid) {
        var rdate = (m.date || '').substring(0, 10);
        h += '<button type="button" id="retryBtn" class="proc-retry-btn" data-fileid="' + escapeAttr(rfid) + '" data-date="' + escapeAttr(rdate) + '" data-type="' + escapeAttr(m.type || '') + '">🔁 立即重試</button>';
      }
      h += '</div></div>';
    }
    // 失敗 banner：紅色，顯示錯誤訊息 + 重試按鈕
    else if (m.status === '失敗') {
      var retryFid = '';
      if (m.audioUrl) {
        var mm = m.audioUrl.match(/\/d\/([^\/]+)/);
        if (mm) retryFid = mm[1];
      }
      h += '<div class="proc-banner proc-banner-failed">';
      h += '<div class="proc-icon">⚠️</div>';
      h += '<div class="proc-body">';
      h += '<div class="proc-title">轉檔失敗</div>';
      if (m.processingError) h += '<div class="proc-err">' + escapeHtml(m.processingError) + '</div>';
      if (retryFid) {
        var dateStr = (m.date || '').substring(0, 10);
        h += '<button type="button" id="retryBtn" class="proc-retry-btn" data-fileid="' + escapeAttr(retryFid) + '" data-date="' + escapeAttr(dateStr) + '" data-type="' + escapeAttr(m.type || '') + '">🔁 重試</button>';
        h += '<div class="proc-sub">按下會自動封存這筆 → 重新建立 placeholder → 重跑 AI</div>';
      } else {
        h += '<div class="proc-sub">這筆沒有錄音連結，無法自動重試</div>';
      }
      h += '</div></div>';
    }

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
        h += audioPlayerHTML(driveFileId);
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

    // AI 筆記聲明：錄音轉檔的頁面，每次進來都要先確認才能看內容（教會謹慎方針）
    var hasBody = m.blocks && m.blocks.length > 0;
    var hasContent = m.info || m.summary || hasBody;
    var gated = !!m.audioUrl && hasContent;
    if (gated) h += aiDisclaimerHTML(m);

    h += '<div class="meeting-content"' + (gated ? ' id="meetingContent" hidden' : '') + '>';

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

    if (hasBody) h += renderBlocks(m.blocks);

    if (!hasContent) {
      h += '<div class="empty">此聚會尚未有整理內容</div>';
    }

    h += '</div>';  // .meeting-content
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
          section += '<div class="md-subhead' + colorCls(b) + '">' + renderRich(b) + '</div>';
        }
      } else if (b.type === 'quote') {
        if (section === null) openSection('內容');
        closeList();
        section += '<blockquote class="md-quote">' + renderRich(b) + '</blockquote>';
      } else if (b.type === 'bulleted_list_item') {
        if (section === null) openSection('內容');
        openList();
        section += '<li>' + renderRich(b) + '</li>';
      } else if (b.text && b.text.trim()) {
        if (section === null) openSection('內容');
        closeList();
        section += '<p' + (colorCls(b) ? ' class="' + colorCls(b).trim() + '"' : '') + '>' + renderRich(b) + '</p>';
      }
    });
    closeSection();
    return h;
  }

  // block 級顏色 → class（前面帶空格方便串接）
  function colorCls(b) {
    return b.color ? ' tx-' + String(b.color).replace('_background', '-bg') : '';
  }

  // 把 rich 片段（bold/italic/color）渲染成帶樣式的 HTML；沒有 rich 就退回純文字
  function renderRich(b) {
    if (!b.rich || !b.rich.length) return escapeHtml(b.text || '');
    return b.rich.map(function (seg) {
      var c = escapeHtml(seg.t);
      if (!c) return '';
      if (seg.c) c = '<span class="tx-' + String(seg.c).replace('_background', '-bg') + '">' + c + '</span>';
      if (seg.i) c = '<em>' + c + '</em>';
      if (seg.b) c = '<strong>' + c + '</strong>';
      return c;
    }).join('');
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // AI 筆記聲明卡（錄音轉檔頁面開啟時擋在內容前面，按按鈕才解鎖）
  function aiDisclaimerHTML(m) {
    var status = m.status || '草稿';
    var h = '<div class="ai-disclaimer" data-id="' + escapeAttr(m.id || '') + '">';
    h += '<div class="ai-disclaimer-head">';
    h += '<div class="ai-disclaimer-icon">⚠️</div>';
    h += '<div>';
    h += '<div class="ai-disclaimer-title">AI 筆記｜請先閱讀聲明</div>';
    h += '<div class="ai-disclaimer-sub">本頁目前狀態：<strong>' + escapeHtml(status) + '</strong></div>';
    h += '</div></div>';
    h += '<p class="ai-disclaimer-body">本頁面下方的「<strong>簡易重點</strong>」與「<strong>完整重點</strong>」皆由 <strong>AI 從錄音檔自動辨識</strong>整理而成，<strong>尚未經人工逐字校對</strong>。</p>';
    h += '<p class="ai-disclaimer-body">可能存在下列情況：</p>';
    h += '<ul class="ai-disclaimer-list">';
    h += '<li>經文書卷、章節、節數辨識錯誤</li>';
    h += '<li>講者用詞、見證內容、聖經引用轉寫不準</li>';
    h += '<li>段落結構偏離講道原意，或漏掉重要內容</li>';
    h += '</ul>';
    h += '<div class="ai-disclaimer-warn">本頁僅供 <strong>個人靈修複習</strong> 之輔助參考。<br>請勿轉發、引用，或作為信仰教義之依據。<br>正式內容請以<strong>錄音檔</strong>，或經傳道核閱後之版本為準。</div>';
    h += '<button type="button" id="aiAckBtn" class="ai-ack-btn">我已了解，繼續閱讀 AI 筆記</button>';
    h += '</div>';
    return h;
  }

  // 公開錄音檔播放器：native <audio> + 加速按鈕 + 跳秒
  function audioPlayerHTML(fileId) {
    // 走 worker 代理（用 SA 抓 Drive 檔，支援 Range seeking + 任意權限的檔）
    var src = 'https://church-meeting-api.c3012312.workers.dev/audio?fileId=' + encodeURIComponent(fileId);
    var h = '<div class="audio-embed" data-file-id="' + escapeAttr(fileId) + '">';
    h += '<audio controls preload="metadata" src="' + escapeAttr(src) + '"></audio>';
    h += '<div class="audio-ctrls">';
    h += '<button type="button" class="audio-skip" data-skip="-15" title="退 15 秒">⏪ 15s</button>';
    h += '<div class="audio-speed">';
    h += '<button type="button" data-rate="1" class="active">1x</button>';
    h += '<button type="button" data-rate="1.25">1.25</button>';
    h += '<button type="button" data-rate="1.5">1.5</button>';
    h += '<button type="button" data-rate="1.75">1.75</button>';
    h += '<button type="button" data-rate="2">2x</button>';
    h += '</div>';
    h += '<button type="button" class="audio-skip" data-skip="15" title="快轉 15 秒">15s ⏩</button>';
    h += '</div>';
    h += '</div>';
    return h;
  }

  // 加速 + 跳秒按鈕事件委派（一次性綁定）+ 載入失敗時 fallback 到 iframe preview
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.matches) return;
    if (t.matches('.audio-speed button')) {
      var box = t.closest('.audio-embed');
      var au = box && box.querySelector('audio');
      if (!au) return;
      au.playbackRate = parseFloat(t.dataset.rate) || 1;
      box.querySelectorAll('.audio-speed button').forEach(function (b) {
        b.classList.toggle('active', b === t);
      });
    } else if (t.matches('.audio-skip')) {
      var box2 = t.closest('.audio-embed');
      var au2 = box2 && box2.querySelector('audio');
      if (!au2 || !isFinite(au2.duration)) return;
      au2.currentTime = Math.max(0, Math.min(au2.duration, au2.currentTime + (parseFloat(t.dataset.skip) || 0)));
    } else if (t.id === 'aiAckBtn' || (t.closest && t.closest('#aiAckBtn'))) {
      // AI 聲明確認 → 隱藏卡片、顯示內容（不記憶，下次進來照樣提醒）
      var ackBtn = t.id === 'aiAckBtn' ? t : t.closest('#aiAckBtn');
      var card = ackBtn.closest('.ai-disclaimer');
      if (card) card.remove();
      var content = document.getElementById('meetingContent');
      if (content) { content.hidden = false; content.removeAttribute('id'); }
    }
  });
  // 播放器載入失敗 → 換成 Drive 直連（保留倍速按鈕，不需登入）
  document.addEventListener('error', function (e) {
    var au = e.target;
    if (!au || au.tagName !== 'AUDIO') return;
    if (au.dataset.fallback) return;
    var box = au.closest('.audio-embed');
    if (!box) return;
    var fileId = box.getAttribute('data-file-id');
    if (!fileId) return;
    au.dataset.fallback = '1';
    au.src = 'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(fileId);
    au.load();
  }, true);
})();
