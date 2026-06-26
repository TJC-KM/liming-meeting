// Cloudflare Worker：教會聚會紀錄系統 API
//
// 三組功能：
// 1. Notion proxy（既有）：列出聚會、取單一聚會詳細
// 2. Drive 列檔：按年月查詢音檔
// 3. 音檔處理：Drive download → Gemini → Notion 寫入
//
// Secrets（在 Cloudflare Dashboard 設定）：
//   SERVICE_ACCOUNT_KEY    Google Cloud Service Account JSON 完整內容
//   NOTION_TOKEN           Notion Integration Token
//   NOTION_DATABASE_ID     聚會紀錄 Database ID
//   GEMINI_API_KEY         Gemini API Key
//   DRIVE_FOLDER_ID        Drive 錄音資料夾 ID
//   ALLOWED_ORIGIN         (選) 限制 CORS 來源

const NOTION_VERSION = '2022-06-28';
const NOTION_API = 'https://api.notion.com/v1';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // 台北 UTC+8

const TYPE_TIMES = {
  '週二晚間': [19, 30],
  '週三晚間': [19, 30],
  '週五晚間': [19, 30],
  '安息日上午': [9, 30],
  '安息日下午': [19, 30],
  '週日聚會': [10, 0],
};

// =============================================================================
// Worker 入口
// =============================================================================

export default {
  // 每日排程：處理近 2 天上傳、Notion 還沒紀錄的音檔
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyProcess(env));
  },

  async fetch(request, env, ctx) {
    const origin = env.ALLOWED_ORIGIN || '*';

    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }), origin);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');
    const params = url.searchParams;

    try {
      // -- Notion proxy --
      if (path === '/meetings' && request.method === 'GET') {
        return cors(json(await listMeetings(env)), origin);
      }
      const meetingMatch = path.match(/^\/meetings\/([0-9a-f-]{32,36})$/i);
      if (meetingMatch && request.method === 'GET') {
        return cors(json(await getMeeting(env, meetingMatch[1])), origin);
      }

      // -- Drive list --
      if (path === '/drive/list' && request.method === 'GET') {
        const year = parseInt(params.get('year'), 10);
        const month = parseInt(params.get('month'), 10);
        return cors(json(await listDriveFiles(env, year, month)), origin);
      }

      // -- Study list (掃描所有預查文件，回傳估計日期) --
      // 不讀內容，只用 filename + createdTime → 下個週三推估
      if (path === '/study/list' && request.method === 'GET') {
        return cors(json(await handleStudyList(env)), origin);
      }

      // -- Study process (處理單篇預查) --
      // 完整讀取內容、偵測日期、寫入 Notion
      if (path === '/study/process' && (request.method === 'POST' || request.method === 'GET')) {
        const fileId = params.get('fileId');
        if (!fileId) return cors(json({ error: 'fileId required' }, 400), origin);
        const overwrite = params.get('overwrite') === '1';
        const requireContentDate = params.get('requireContentDate') === '1';
        const dateOverride = params.get('date') || null;
        return cors(json(await processSingleStudyDoc(env, fileId, overwrite, requireContentDate, dateOverride)), origin);
      }

      // -- Study sync (批次處理：保留用於初次匯入歷史) --
      if (path === '/study/sync' && (request.method === 'POST' || request.method === 'GET')) {
        const limit = parseInt(params.get('limit') || '8', 10);
        return cors(json(await handleStudySync(env, limit)), origin);
      }

      // -- Study cleanup (掃描並刪除 _temp_study_* 殘留檔) --
      if (path === '/study/cleanup' && (request.method === 'POST' || request.method === 'GET')) {
        return cors(json(await cleanupStudyTempFiles(env)), origin);
      }

      // -- Admin: 封存指定 Notion 頁面（清理重複 / 錯誤條目用）--
      if (path === '/admin/archive' && (request.method === 'POST' || request.method === 'GET')) {
        const pageId = params.get('pageId');
        if (!pageId) return cors(json({ error: 'pageId required' }, 400), origin);
        try {
          await archiveNotionPage(env, pageId);
          return cors(json({ success: true, pageId }), origin);
        } catch (e) {
          return cors(json({ success: false, error: e.message }), origin);
        }
      }

      // -- Audio stream (代理 Drive 錄音檔，給 native <audio> 用，支援 Range seeking) --
      if (path === '/audio' && (request.method === 'GET' || request.method === 'HEAD')) {
        const fileId = params.get('fileId');
        if (!fileId) return cors(json({ error: 'fileId required' }, 400), origin);
        return handleAudioStream(env, fileId, request, origin);
      }

      // -- Admin: 手動觸發 daily process（同步等結果）--
      // ?limit=N 暫時覆寫 QUOTA_PER_RUN
      if (path === '/admin/run-daily' && (request.method === 'POST' || request.method === 'GET')) {
        const limit = params.get('limit');
        const envOverride = limit ? Object.assign({}, env, { QUOTA_PER_RUN: limit }) : env;
        const result = await runDailyProcess(envOverride);
        return cors(json(result || { ok: true }), origin);
      }

      // -- Drive process (Gemini + Notion) --
      // 同步處理：跟 LimingUploader 對齊，client 等到底
      // 若 Gemini 超過 ~30s wall clock 會收到 524；不過 LimingUploader 證明
      // 輸出較短的情況下成功率夠高
      if (path === '/drive/process' && (request.method === 'POST' || request.method === 'GET')) {
        let payload = {
          date: params.get('date'),
          type: params.get('type'),
          fileId: params.get('fileId'),
        };
        if (!payload.date && !payload.fileId && request.method === 'POST') {
          try { payload = await request.json(); } catch (e) { /* 留空 query params */ }
        }
        // === Placeholder pattern ===
        // 1. 同步：resolve fileId → dedup → 建 Notion placeholder（狀態=處理中）
        // 2. 回 notionId 給前端立刻 redirect
        // 3. 背景：跑 processAudio，整路 update 該 page 的狀態（下載中 / AI 分析中 / 整合中 / 寫入內容 / 草稿）
        //    失敗則 markPageFailed 寫入錯誤訊息
        try {
          let fileId = payload.fileId;
          // 沒 fileId 就用 date+type 找
          if (!fileId && payload.date && payload.type) {
            const year = parseInt(payload.date.substring(0, 4), 10);
            const month = parseInt(payload.date.substring(5, 7), 10);
            const list = await listDriveFiles(env, year, month);
            const match = list.files.find(f => f.date === payload.date && f.type === payload.type);
            if (!match) return cors(json({ success: false, error: `找不到對應錄音：${payload.date} ${payload.type}` }, 404), origin);
            fileId = match.id;
            payload.fileId = fileId;
          }
          if (!fileId) return cors(json({ success: false, error: '需要 fileId 或 (date + type)' }, 400), origin);

          // dedup：fileId 已處理過 → 看狀態決定
          //   - '失敗' → 自動 archive，繼續往下建新 placeholder（等於原地重試，使用者不用手動刪）
          //   - 其他狀態 → 回既有 notionId 給前端跳過去
          const existing = await notionFetch(env, `/databases/${env.NOTION_DATABASE_ID}/query`, {
            method: 'POST',
            body: JSON.stringify({ filter: { property: '錄音檔連結', url: { contains: fileId } }, page_size: 5 }),
          }).catch(() => ({ results: [] }));
          if (existing.results && existing.results.length > 0) {
            // 找第一個「非失敗」的 entry → 直接回那個
            const live = existing.results.find(p => (p.properties?.['狀態']?.select?.name) !== '失敗');
            if (live) {
              return cors(json({ success: true, queued: false, notionId: live.id, alreadyDone: true }), origin);
            }
            // 全部都是失敗的 → archive 它們，繼續建新 placeholder（重試）
            for (const failed of existing.results) {
              try { await archiveNotionPage(env, failed.id); console.log(`[retry] archive 失敗 entry ${failed.id.substring(0,8)}`); }
              catch (e) { console.warn(`[retry] archive ${failed.id} 失敗: ${e.message}`); }
            }
          }

          // 解析檔名 → 建 placeholder
          const fileMeta = await getDriveFileMeta(env, fileId);
          const parsed = parseFilename(fileMeta.name, fileMeta.createdTime);
          if (!parsed || !parsed.type) {
            return cors(json({ success: false, error: `檔名格式錯誤或無法判斷類型：${fileMeta.name}` }, 400), origin);
          }
          const audioUrl = `https://drive.google.com/file/d/${fileId}/view`;
          const pageId = await createPlaceholderNotionPage(env, parsed, audioUrl);

          // 背景跑 + 失敗 markPageFailed
          ctx.waitUntil(
            processAudio(env, payload, pageId).catch(async (e) => {
              console.error('[processAudio bg]', e.message);
              await markPageFailed(env, pageId, e.message).catch(() => {});
            })
          );
          return cors(json({ success: true, queued: true, notionId: pageId }), origin);
        } catch (e) {
          console.error('[/drive/process prelude]', e.message);
          return cors(json({ success: false, error: e.message }, 500), origin);
        }
      }

      // -- Root --
      if (path === '' || path === '/') {
        return cors(json({
          name: 'church-meeting-api',
          routes: ['/meetings', '/meetings/:id', '/drive/list?year=&month=', '/drive/process'],
        }), origin);
      }

      return cors(json({ error: 'Not found' }, 404), origin);
    } catch (err) {
      return cors(json({ error: err.message, stack: String(err.stack || '').substring(0, 500) }, 500), origin);
    }
  },
};

// =============================================================================
// 共用工具
// =============================================================================

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function cors(response, origin) {
  const h = new Headers(response.headers);
  h.set('Access-Control-Allow-Origin', origin);
  h.set('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, Range');
  h.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (!h.get('Cache-Control')) h.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, headers: h });
}

function pad2(n) { return String(n).padStart(2, '0'); }

// =============================================================================
// Google Service Account 認證
// =============================================================================

let _tokenCache = null;  // { token, expiresAt }

async function getGoogleAccessToken(env) {
  if (_tokenCache && Date.now() < _tokenCache.expiresAt - 60000) {
    return _tokenCache.token;
  }

  const key = JSON.parse(env.SERVICE_ACCOUNT_KEY);
  const now = Math.floor(Date.now() / 1000);

  const header = b64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64UrlEncode(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));

  const signingInput = `${header}.${payload}`;
  const privateKey = await importPrivateKey(key.private_key);
  const signature = await signJWT(signingInput, privateKey);
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Google Token 失敗：' + JSON.stringify(data));

  _tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return data.access_token;
}

function b64UrlEncode(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importPrivateKey(pem) {
  const pemContent = pem
    .replace(/-----[^-]+-----/g, '')
    .replace(/\s/g, '');
  const der = Uint8Array.from(atob(pemContent), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function signJWT(input, key) {
  const encoded = new TextEncoder().encode(input);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoded);
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// =============================================================================
// Drive API
// =============================================================================

const AUDIO_EXTS = ['.mp3', '.m4a', '.wav', '.ogg', '.aac'];

// 切割門檻：超過此 byte 數的 MP3 會自動切兩半各跑 Gemini，再合併
// 經驗值：25 MB MP3 ≈ 50-60 分鐘，是 Gemini free tier 的安全上限
// 切割閾值預設 25MB（約 60 分鐘 128kbps mp3），可被 Config Sheet 的 split_threshold_mb 覆寫
const DEFAULT_SPLIT_THRESHOLD_BYTES = 25 * 1024 * 1024;

// 哪些 mime type 可以安全 byte-切（frame-based codec）
// MP3 / AAC 每 frame 獨立可解碼，切點不對齊只丟 ~26ms
// WAV / M4A / OGG 是 container 格式，byte-切會壞
const SPLITTABLE_MIMES = ['audio/mpeg', 'audio/mp3', 'audio/aac'];

function isAudioFile(name) {
  const lower = name.toLowerCase();
  return AUDIO_EXTS.some(ext => lower.endsWith(ext));
}

async function listDriveFiles(env, year, month) {
  if (!year || !month) throw new Error('需要 year 與 month 參數');

  const token = await getGoogleAccessToken(env);
  const prefix = `${year}-${pad2(month)}-`;

  // Drive 搜尋：名稱前綴 + 未刪除
  // Service Account 只能看到分享給它的資料夾樹，所以不需要額外的父資料夾限制
  const q = `name contains '${prefix}' and trashed = false`;
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,size,createdTime,modifiedTime,mimeType)&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Drive list 失敗 ${res.status}: ${txt.substring(0, 300)}`);
  }
  const data = await res.json();

  const files = (data.files || [])
    .filter(f => isAudioFile(f.name))
    .map(f => {
      const parsed = parseFilename(f.name, f.createdTime);
      return {
        id: f.id,
        name: f.name,
        sizeMB: f.size ? +(f.size / 1024 / 1024).toFixed(1) : null,
        modifiedTime: f.modifiedTime,
        createdTime: f.createdTime,
        date: parsed ? parsed.dateStr : null,
        topic: parsed ? parsed.topic : null,
        speaker: parsed ? parsed.speaker : null,
        type: parsed ? parsed.type : null,
        parseable: !!parsed && !!parsed.type,
      };
    });

  return { files, count: files.length };
}

async function downloadDriveFile(env, fileId) {
  const token = await getGoogleAccessToken(env);
  const res = await fetch(
    `${DRIVE_API}/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Drive 下載失敗 ${res.status}: ${txt.substring(0, 300)}`);
  }
  return await res.arrayBuffer();
}

// 區段下載：用 Range header 只抓指定 byte 範圍（避免整顆載入記憶體）
// startByte / endByte 都 inclusive，例如 0~99 = 前 100 bytes
async function downloadDriveFilePart(env, fileId, startByte, endByte) {
  const token = await getGoogleAccessToken(env);
  const res = await fetch(
    `${DRIVE_API}/files/${fileId}?alt=media&supportsAllDrives=true`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Range: `bytes=${startByte}-${endByte}`,
      },
    }
  );
  if (!res.ok && res.status !== 206) {
    const txt = await res.text();
    throw new Error(`Drive Range 下載失敗 ${res.status}: ${txt.substring(0, 300)}`);
  }
  return await res.arrayBuffer();
}

async function getDriveFileMeta(env, fileId) {
  const token = await getGoogleAccessToken(env);
  const res = await fetch(
    `${DRIVE_API}/files/${fileId}?fields=id,name,size,createdTime,mimeType&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Drive meta 失敗 ${res.status}: ${txt.substring(0, 300)}`);
  }
  return await res.json();
}

// =============================================================================
// 檔名解析
// =============================================================================

function parseFilename(name, createdTime) {
  // 講員括號接受半形 () 或全形 （），主題裡若也有半形括號（如 (一)(二)）會 backtrack 處理
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})\s+(.+?)\s*[（(]([^）)]+)[）)]\.(mp3|m4a|wav|ogg|aac)$/i);
  if (!m) return null;

  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const topic = m[4].trim();
  const speaker = m[5].trim();

  const dt = new Date(year, month - 1, day);
  const dow = dt.getDay();
  let type = null;

  if (dow === 2) type = '週二晚間';
  else if (dow === 3) type = '週三晚間';
  else if (dow === 5) type = '週五晚間';
  else if (dow === 6) {
    // 週六：依 Drive createdTime 的台北小時區分上午/晚間
    let hour = 9;
    if (createdTime) {
      const utc = new Date(createdTime);
      const taipei = new Date(utc.getTime() + TZ_OFFSET_MS);
      hour = taipei.getUTCHours();
    }
    type = hour < 14 ? '安息日上午' : '安息日下午';
  }
  else if (dow === 0) type = '週日聚會';

  let isoDate = null;
  if (type) {
    const [hh, mm] = TYPE_TIMES[type];
    // 台北時間 yyyy-MM-ddTHH:mm:ss+08:00
    isoDate = `${year}-${pad2(month)}-${pad2(day)}T${pad2(hh)}:${pad2(mm)}:00+08:00`;
  }

  return {
    year, month, day, topic, speaker, dow, type, isoDate,
    dateStr: `${year}-${pad2(month)}-${pad2(day)}`,
  };
}

// =============================================================================
// Gemini API
// =============================================================================

// === 預設 prompt（fallback；可被 Config Sheet 蓋過）===
const DEFAULT_GEMINI_SYSTEM = '你必須使用繁體中文（台灣）回覆所有內容。即使錄音是英文或其他語言，輸出的整理紀錄也必須完全用繁體中文。不要使用簡體中文、英文或其他語言（除了標註 NKJV 英文經文）。';

// 切割模式下，前/後半段給 Gemini 的特殊 context（已停用，由 3-step pipeline 取代）
// 保留只是向後相容，新的 split 路徑用 DEFAULT_SPLIT_SUMMARY_PROMPT
const DEFAULT_PART1_CONTEXT = '【重要】此音檔為某聚會的「前半段」（共兩半）。請正常產出三個區段（簡易重點 / 完整重點 / 參考經文），不必預測後半段的內容。前 1-2 秒可能因 byte 切割而失真，請忽略開頭幾秒。';

const DEFAULT_PART2_CONTEXT = '【重要】此音檔為某聚會的「後半段」（共兩半），引言與開場已在前半段。請聚焦此處實際聽到的內容：\n' +
  '- 簡易重點：只寫後半段精華\n' +
  '- 完整重點：不必從「一、引言」開始，可直接從「三、第二個論點」之類的點切入；如某段不存在於後半段，可以省略\n' +
  '- 參考經文：只列後半段提到的\n' +
  '前 1-2 秒可能因 byte 切割而失真，請忽略開頭幾秒。';

// === 3-step split pipeline 的兩個 prompt ===
// Step 1+2：對每半段做「半結構 brain dump」，不套最終格式
const DEFAULT_SPLIT_SUMMARY_PROMPT = `你是教會聚會紀錄的「片段理解助手」。請仔細聆聽這段音檔，提取所有要點，**不必套用特定格式**。

【你的任務】
- 列出主要論點（不限段數，講者實際講多少就寫多少）
- 完整保留引用的聖經故事、人物見證、個人經歷、實例
- 列出明確提到的所有經文（含書卷、章節，可只列章節不必抄全文）
- 標註講者切換點（如有多位）
- 用條列或自由段落都可以，重點是內容完整不遺漏

【語言】
- 必須用繁體中文（台灣用語）
- 不可出現簡體中文或英文（經文章節縮寫除外）

【內容範圍 — 重要】
聚會錄音可能包含「非教學」內容，請**完全省略**：
- 司會宣布事項、報告
- 詩歌唱詠（含開會詩、靈交詩、奉獻詩）
- 全體禱告、開會禱告、結束禱告、感恩禱告
- 奉獻、報告退會
- 寒暄招呼
請只整理「講道」「分享」「真理研讀」「見證」「教師講解」等實質教學內容。如果整段都是非教學內容，可以輸出「（此段無實質教學內容）」。

【注意】
- 此為片段，**不必寫引言或結論**，只整理你聽到的內容
- 開頭 1-2 秒可能因切割失真，請忽略
- 內容可能包含國語和台語，統一用書面繁體中文整理
- 直接輸出文字，不要包在 \`\`\`markdown\`\`\` 程式碼塊裡`;

// Step 3：拿兩份 brain dump 整合成最終格式
const DEFAULT_SPLIT_MERGE_PROMPT = `你是教會聚會紀錄的「整合彙整助手」。下方會給你兩份關於同一場聚會「前半段」與「後半段」的要點筆記，請彙整成一份完整、流暢的聚會紀錄。

【輸出格式】（必須完整三段）

# 簡易重點

（約 200 字的核心摘要，涵蓋整場聚會的主旨與呼召）

# 完整重點

一、引言：（300-500 字。包括講者開場、見證、引導入題等）

二、第一個論點：（300-500 字。完整保留講者引用的聖經故事、個人見證、實例與勸勉）

三、第二個論點：（300-500 字）

四、第三個論點：（300-500 字，若有）

結語：（講道末了的呼召與總結）

# 參考經文

（**列出本場聚會實際引用或反覆強調的經文**，每節格式如下。⚠️ 下面只是格式示範，書卷與內容請務必換成本場「真正提到」的經文，絕對不要照抄此範例）

## ＜書卷全名 章:節＞

＜該節中文經文（和合本神版）＞

＜該節英文經文（NKJV，末尾標註 (Book Chapter:Verse NKJV)）＞

（若本場未明確引用任何經文，此段寫「（本場未明確引用經文）」即可。）

【整合要求 — 重要】
- 兩段筆記中間可能有重疊內容（音檔本身有重疊區域），請判斷後**去除重複**，不要寫兩次
- 完整重點應該流暢連貫，**不要看出是兩段拼成的**（不要出現「前半段」「後半段」之類字眼）
- 參考經文必須是兩段筆記中「實際出現」的經文，不要自行補充或照抄範例
- 經文也不要重複列同一節
- 段數依實際內容組織（如果只有兩個論點就寫兩個，不必硬湊四個）

【經文格式】
- 中文經文用和合本神版（不要用上帝版），請從「## 書卷 章:節」開始
- 英文經文用 NKJV，每節末尾標註 (Book Chapter:Verse NKJV)
- 聖經書卷名使用繁體中文全名（如「約翰福音」非「約」）

【語言】
- 必須繁體中文（台灣用語）
- 除 NKJV 英文經文外不可有英文或簡體中文

【教派慣用語】
- 此教會為「真耶穌教會」，週六為「安息日」
- **不要使用「主日」一詞**，請用「週日」

【其他】
- 直接輸出 markdown 文字，不要包在 \`\`\`markdown\`\`\` 程式碼塊裡
- 三個一級標題（# 簡易重點 / # 完整重點 / # 參考經文）必須完整出現，順序如上`;

const DEFAULT_GEMINI_PROMPT = `你是教會聚會紀錄整理助手。請仔細聆聽整段錄音，輸出 markdown 格式的詳盡紀錄。

【語言要求 - 最重要】
- 整份輸出**必須是繁體中文（台灣用語）**
- 除了 NKJV 英文經文段落外，其他不可出現英文或簡體中文

【格式範例】

# 簡易重點

（約 200 字的核心摘要，適合會友快速瀏覽，獨立成段。請涵蓋本次講道的主旨與呼召。）

# 完整重點

一、引言：（300-500 字。包括講者開場、見證、引導入題等）

二、第一個論點：（300-500 字。完整保留講者引用的聖經故事、個人見證、實例與勸勉）

三、第二個論點：（300-500 字）

四、第三個論點：（300-500 字，若有）

結語：（講道末了的呼召與總結）

# 參考經文

（**列出本場講道實際引用或反覆強調的經文**，每節格式如下。⚠️ 下面只是格式示範，書卷與內容請務必換成本場「真正提到」的經文，絕對不要照抄此範例）

## ＜書卷全名 章:節＞

＜該節中文經文（和合本神版）＞

＜該節英文經文（NKJV，末尾標註 (Book Chapter:Verse NKJV)）＞

（若本場未明確引用任何經文，此段寫「（本場未明確引用經文）」即可。）

【注意事項】
- 參考經文必須是講道中「實際出現」的經文，不要自行補充或照抄範例
- 中文經文用和合本神版（不要用上帝版）
- 英文經文用 NKJV，每節末尾必須標註 (Book Chapter:Verse NKJV)
- 聖經書卷名使用繁體中文全名（如「約翰福音」非「約」）
- 完整重點要詳盡，保留講者引用的故事、見證、實例、勸勉，寧可詳細不要遺漏
- 列出講道中明確引用或反覆強調的所有經文，不要遺漏
- 內容可能包含國語和台語（閩南語），統一用書面繁體中文整理
- 【翻譯情境】部分講道採「逐句翻譯」（國語講一句、台語翻一句，或反之）。請判斷為同一內容，整理時合併為一次，避免重複出現同義句
- 不需要產出講題或講員（已從檔名取得）
- 【教派慣用語】此教會為「真耶穌教會」，以「週六」為「安息日」。請使用「安息日」、「週日」等中性詞彙，**不要使用「主日」一詞**
- 直接輸出 markdown 文字，不要包在 \`\`\`markdown\`\`\` 程式碼塊裡
- 三個一級標題（# 簡易重點 / # 完整重點 / # 參考經文）必須完整出現，順序如上`;

// === Config Sheet 載入（5 分鐘快取）===
let _configCache = null;
let _configCacheTime = 0;
const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;

async function loadConfig(env) {
  if (!env.CONFIG_SHEET_ID) return {};
  const now = Date.now();
  if (_configCache && (now - _configCacheTime < CONFIG_CACHE_TTL_MS)) return _configCache;

  try {
    const token = await getGoogleAccessToken(env);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.CONFIG_SHEET_ID}/values/Config!A:B`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      console.warn(`[loadConfig] HTTP ${r.status}`);
      return _configCache || {};
    }
    const data = await r.json();
    const rows = data.values || [];
    const map = {};
    for (let i = 1; i < rows.length; i++) {  // 跳過標題列
      const [k, v] = rows[i];
      if (k) map[String(k).trim()] = v != null ? String(v) : '';
    }
    _configCache = map;
    _configCacheTime = now;
    console.log(`[loadConfig] 讀到 ${Object.keys(map).length} 條設定`);
    return map;
  } catch (e) {
    console.warn(`[loadConfig] error: ${e.message}`);
    return _configCache || {};
  }
}

async function getConfigValue(env, key, fallback) {
  const cfg = await loadConfig(env);
  return (cfg[key] && cfg[key].length > 0) ? cfg[key] : fallback;
}

// 可選參數：
//   extraContext: prepend 到 user prompt 之前（特殊指示）
//   promptOverride: 完全替代從 Config 拿的 gemini_prompt（用於 split brain-dump 步驟）
async function geminiAnalyze(env, audioBytes, mimeType, fileName, extraContext, promptOverride) {
  const apiKey = env.GEMINI_API_KEY;
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  // Config Sheet 可覆寫 prompt / system
  const baseUserPrompt = promptOverride
    || await getConfigValue(env, 'gemini_prompt', DEFAULT_GEMINI_PROMPT);
  const GEMINI_SYSTEM = await getConfigValue(env, 'gemini_system', DEFAULT_GEMINI_SYSTEM);
  const GEMINI_PROMPT = extraContext
    ? extraContext + '\n\n' + baseUserPrompt
    : baseUserPrompt;
  if (!apiKey) throw new Error('未設定 GEMINI_API_KEY');

  // 1. 上傳到 Files API（multipart）
  const boundary = 'gem_' + Date.now();
  const enc = new TextEncoder();
  const meta = JSON.stringify({ file: { display_name: fileName } });
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.byteLength + audioBytes.byteLength + tail.byteLength);
  body.set(head, 0);
  body.set(new Uint8Array(audioBytes), head.byteLength);
  body.set(tail, head.byteLength + audioBytes.byteLength);

  // 注意：Files API 上傳用 /upload/v1beta/files（與 management 的 /v1beta/files 不同）
  const upRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}&uploadType=multipart`,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  const upData = await upRes.json();
  if (!upData.file?.uri) {
    throw new Error('Gemini 上傳失敗：' + JSON.stringify(upData).substring(0, 500));
  }

  // 2. 等待 ACTIVE（free tier 省 subrequest：3 次 polling，每次間隔 2 秒，共 6 秒）
  // 大檔可能撈不到 ACTIVE，整體流程的 retry 機制兜底
  let state = upData.file.state || 'PROCESSING';
  for (let i = 0; i < 3 && state !== 'ACTIVE'; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const chk = await fetch(`${GEMINI_BASE}/${upData.file.name}?key=${apiKey}`);
    const chkData = await chk.json();
    state = chkData.state;
    if (state === 'FAILED') throw new Error('Gemini 檔案處理失敗');
  }
  if (state !== 'ACTIVE') throw new Error('Gemini 檔案 ACTIVE 等待超時，請稍後再試');

  // 3. generateContent — 不重試、不 fallback，失敗就直接拋（讓使用者手動重試）
  const genRes = await fetch(
    `${GEMINI_BASE}/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // 系統指令：強制語言為繁體中文（比 user prompt 權重高）
        system_instruction: { parts: [{ text: GEMINI_SYSTEM }] },
        contents: [{
          parts: [
            { file_data: { mime_type: mimeType, file_uri: upData.file.uri } },
            { text: GEMINI_PROMPT },
          ],
        }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 16384,  // 從 8192 加倍，避免被切斷；Gemini 跑得久一點但 sync mode 撐得住
        },
      }),
    }
  );
  const genData = await genRes.json();

  if (!genData?.candidates) {
    const rawMsg = genData?.error?.message || '無回應';
    if (/high demand|overloaded|unavailable|429|503/i.test(rawMsg)) {
      throw new Error('Gemini AI 目前忙線中，請稍後再試');
    }
    if (/quota|RESOURCE_EXHAUSTED|exceeded/i.test(rawMsg)) {
      throw new Error('Gemini 今日配額用完，請明天再試');
    }
    if (/api key|API_KEY|permission/i.test(rawMsg)) {
      throw new Error('Gemini API Key 無效或權限不足');
    }
    throw new Error('Gemini 生成失敗：' + rawMsg);
  }
  const usedModel = model;

  console.log(`使用模型：${usedModel}`);
  const candidate = genData.candidates[0];
  let text = candidate?.content?.parts?.[0]?.text || '';
  const finishReason = candidate?.finishReason || '';

  if (!text) throw new Error('Gemini 無回傳內容');

  // 移除可能包裹的 markdown code block
  text = text.replace(/^```(?:markdown|md)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  // 截斷時記錄但不報錯（純文字截斷仍可用）
  if (finishReason === 'MAX_TOKENS') {
    console.log('[Gemini] 輸出達到 MAX_TOKENS 上限，內容可能不完整');
  }

  return text;  // 回傳 markdown 字串
}

// 純文字 Gemini 呼叫（無音檔上傳）
// 用於 3-step split pipeline 的 Step 3：拿兩段 brain dump 整合成最終 markdown
// 503/overloaded 自動 retry（最多 3 次，等待 4s / 8s）— 避免前面花 100+ 秒的 brain dump 被最後一刀白費
async function geminiAnalyzeText(env, prompt, textInput, attempt) {
  attempt = attempt || 1;
  const apiKey = env.GEMINI_API_KEY;
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const GEMINI_SYSTEM = await getConfigValue(env, 'gemini_system', DEFAULT_GEMINI_SYSTEM);
  if (!apiKey) throw new Error('未設定 GEMINI_API_KEY');

  console.log(`使用模型：${model} (純文字, attempt ${attempt})`);

  const genRes = await fetch(
    `${GEMINI_BASE}/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: GEMINI_SYSTEM }] },
        contents: [{
          parts: [
            { text: prompt },
            { text: textInput },
          ],
        }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 16384,
        },
      }),
    }
  );
  const genData = await genRes.json();

  if (!genData?.candidates) {
    const rawMsg = genData?.error?.message || '無回應';
    const isTransient = /high demand|overloaded|unavailable|429|503/i.test(rawMsg);
    if (isTransient && attempt < 3) {
      const waitMs = attempt * 4000;  // 4s, 8s
      console.warn(`[Gemini-text] 忙線中（${rawMsg.substring(0,80)}），${waitMs/1000}s 後重試 (attempt ${attempt + 1}/3)`);
      await new Promise(r => setTimeout(r, waitMs));
      return geminiAnalyzeText(env, prompt, textInput, attempt + 1);
    }
    if (isTransient) throw new Error('Gemini AI 目前忙線中，請稍後再試（已重試 3 次）');
    throw new Error(`Gemini 生成失敗：${rawMsg.substring(0, 300)}`);
  }

  const cand = genData.candidates[0];
  const text = cand?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
  if (cand?.finishReason === 'MAX_TOKENS') {
    console.warn('[Gemini] 整合輸出達到 MAX_TOKENS 上限，內容可能不完整');
  }
  if (!text) throw new Error('Gemini 整合未回傳任何內容');
  return text;
}

// 從 markdown 中抽出「# 簡易重點」區段的內文（用於 Notion property）
function extractSummaryFromMarkdown(md) {
  const m = md.match(/^#+\s*簡易重點\s*\n+([\s\S]*?)(?=^#\s|\n##\s|$)/m);
  if (!m) return '';
  return m[1].trim().substring(0, 1900);  // Notion rich_text 單一 element 上限 2000
}

// 把 markdown 拆成三段：{ summary, full, verses }
// 用 # 開頭的標題作為切點，找「簡易重點 / 完整重點 / 參考經文」
function parseMarkdownSections(md) {
  const result = { summary: '', full: '', verses: '', other: '' };
  if (!md) return result;

  // 依 # 標題切（保留標題行屬於下一段）
  const blocks = md.split(/^(?=#\s)/m);
  for (const block of blocks) {
    const titleMatch = block.match(/^#\s+(.+?)\s*\n/);
    const title = titleMatch ? titleMatch[1].trim() : '';
    const body = titleMatch ? block.slice(titleMatch[0].length).trim() : block.trim();
    if (/簡易重點/.test(title)) result.summary = body;
    else if (/完整重點/.test(title)) result.full = body;
    else if (/參考經文/.test(title)) result.verses = body;
    else if (body) result.other += (result.other ? '\n\n' : '') + (title ? `# ${title}\n\n` : '') + body;
  }
  return result;
}

// 合併兩段 markdown（前半 + 後半）成一份完整的紀錄
// 對使用者來說看起來像單一聚會，不暴露「前半/後半」的實作細節
// （prompt-aware context 已經叫 Gemini 在後半不要重複前半結構，所以直接接通常 OK）
function mergeMarkdowns(md1, md2) {
  const a = parseMarkdownSections(md1);
  const b = parseMarkdownSections(md2);

  const parts = [];

  // 簡易重點 — 兩段精華合併成單一段
  if (a.summary || b.summary) {
    parts.push('# 簡易重點\n');
    parts.push([a.summary, b.summary].filter(Boolean).join('\n\n'));
  }

  // 完整重點 — 直接接（Gemini 後半 context 已說明不必從「一、引言」開始）
  if (a.full || b.full) {
    parts.push('# 完整重點\n');
    parts.push([a.full, b.full].filter(Boolean).join('\n\n'));
  }

  // 參考經文 — 直接接（經文一般不會重複）
  if (a.verses || b.verses) {
    parts.push('# 參考經文\n');
    parts.push([a.verses, b.verses].filter(Boolean).join('\n\n'));
  }

  // 其他 section（少見，保險起見）
  if (a.other) parts.push(a.other);
  if (b.other) parts.push(b.other);

  return parts.join('\n\n');
}

// 解析行內 **粗體** → Notion rich_text 陣列
function parseInline(text) {
  const parts = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: 'text', text: { content: text.slice(last, m.index).substring(0, 2000) } });
    parts.push({ type: 'text', text: { content: m[1].substring(0, 2000) }, annotations: { bold: true } });
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ type: 'text', text: { content: text.slice(last).substring(0, 2000) } });
  if (parts.length === 0) parts.push({ type: 'text', text: { content: '' } });
  return parts;
}

// 帶 rich_text + 可選顏色的 block
function richBlock(type, text, color) {
  const data = { rich_text: parseInline(text) };
  if (color) data.color = color;
  return { object: 'block', type, [type]: data };
}

// 整段套用某個 annotation（如全斜體、全粗體）
function applyAnnotation(block, ann) {
  const key = block.type;
  block[key].rich_text.forEach(r => { r.annotations = Object.assign({}, r.annotations, ann); });
  return block;
}

// 將 markdown 轉為 Notion blocks（rich text：粗體 / 顏色 / 經文樣式 / quote）
function markdownToNotionBlocks(md) {
  const blocks = [];
  const lines = md.split('\n');
  let inVerses = false;  // 是否在「參考經文」區段（影響 ## 與經文的樣式）
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    // 不再 cap：呼叫端會把超過 100 的 children 分批 append（見 notionAppendChildrenBatched）

    if (line.startsWith('# ')) {
      // 一級標題：簡易/完整重點 → 藍；參考經文 → 紫
      const title = line.slice(2).trim();
      inVerses = /參考經文/.test(title);
      blocks.push(richBlock('heading_2', title, inVerses ? 'purple' : 'blue'));
    } else if (line.startsWith('## ')) {
      const title = line.slice(3).trim();
      // 參考經文段的 ## 是「書卷 章:節」→ 橘色強調
      blocks.push(richBlock('heading_3', title, inVerses ? 'orange' : undefined));
    } else if (line.startsWith('### ')) {
      blocks.push(richBlock('heading_3', line.slice(4).trim()));
    } else if (line.startsWith('#### ')) {
      blocks.push(richBlock('heading_3', line.slice(5).trim()));
    } else if (/^[-*•]\s/.test(line)) {
      blocks.push(richBlock('bulleted_list_item', line.replace(/^[-*•]\s+/, '')));
    } else if (inVerses && /NKJV\)\s*$/.test(line)) {
      // NKJV 英文經文 → 斜體灰色
      blocks.push(applyAnnotation(richBlock('paragraph', line, 'gray'), { italic: true }));
    } else if (inVerses) {
      // 參考經文段的中文經文 → quote 引用區塊（左側有條線，較精緻）
      blocks.push({ object: 'block', type: 'quote', quote: { rich_text: parseInline(line) } });
    } else if (/^[一二三四五六七八九十]+、/.test(line)) {
      // 完整重點的「一、引言」「二、第一個論點」等 → 粗體
      blocks.push(applyAnnotation(richBlock('paragraph', line), { bold: true }));
    } else {
      blocks.push(richBlock('paragraph', line));
    }
  }
  return blocks;
}

function makeBlock(type, text) {
  return {
    object: 'block',
    type,
    [type]: {
      rich_text: [{ text: { content: String(text).substring(0, 2000) } }],
    },
  };
}

// =============================================================================
// Notion API
// =============================================================================

async function notionFetch(env, path, init) {
  const opts = init || {};
  const res = await fetch(NOTION_API + path, {
    method: opts.method || 'GET',
    headers: {
      'Authorization': `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: opts.body,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Notion API ${res.status}: ${txt.substring(0, 300)}`);
  }
  return res.json();
}

// 分批 append 超過 100 個 children blocks（Notion 限制：create-page 與 append 每次都 ≤100，但總量無限制）
async function notionAppendChildrenBatched(env, pageId, blocks) {
  if (!blocks || blocks.length === 0) return;
  const batches = Math.ceil(blocks.length / 100);
  for (let i = 0; i < blocks.length; i += 100) {
    const batch = blocks.slice(i, i + 100);
    await notionFetch(env, `/blocks/${pageId}/children`, {
      method: 'PATCH',
      body: JSON.stringify({ children: batch }),
    });
    console.log(`[notion-append] batch ${Math.floor(i/100)+1}/${batches} (${batch.length} blocks) → ${pageId.substring(0,8)}`);
  }
}

// === Placeholder pattern：先建 Notion page、整路 update status，前端可即時看進度 ===

// 建立 placeholder Notion page（屬性都填好，無內文 blocks），回傳 pageId
// status 從 '處理中' 開始，背景任務再 update 到各階段
async function createPlaceholderNotionPage(env, parsed, audioUrl) {
  const properties = {
    '聚會主題': { title: chunkRichText(parsed.topic || '(未命名)') },
    '聚會日期': { date: { start: parsed.isoDate } },
    '聚會類型': { select: { name: parsed.type } },
    '狀態': { select: { name: '處理中' } },
  };
  if (parsed.speaker) properties['講員'] = { rich_text: chunkRichText(parsed.speaker) };
  if (audioUrl) properties['錄音檔連結'] = { url: audioUrl };

  const data = await notionFetch(env, '/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: env.NOTION_DATABASE_ID },
      properties,
    }),
  });
  console.log(`[placeholder] 建立 ${data.id.substring(0,8)} (${parsed.topic})`);
  return data.id;
}

// 更新 page 的「狀態」屬性（背景任務各階段呼叫）
// 失敗不拋（status 更新失敗不該整個流程死掉）
async function updatePageStatus(env, pageId, status) {
  try {
    await notionFetch(env, `/pages/${pageId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        properties: { '狀態': { select: { name: status } } },
      }),
    });
    console.log(`[status] ${pageId.substring(0,8)} → ${status}`);
  } catch (e) {
    console.warn(`[status] ${pageId.substring(0,8)} → ${status} 失敗: ${e.message}`);
  }
}

// 標記失敗：狀態 = '失敗' + 處理錯誤 = 訊息
// 若 schema 沒「處理錯誤」屬性，退而求其次只 update 狀態
async function markPageFailed(env, pageId, errorMsg) {
  const msg = String(errorMsg || '').substring(0, 1500);
  try {
    await notionFetch(env, `/pages/${pageId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        properties: {
          '狀態': { select: { name: '失敗' } },
          '處理錯誤': { rich_text: chunkRichText(msg) },
        },
      }),
    });
    console.log(`[failed] ${pageId.substring(0,8)}: ${msg.substring(0,80)}`);
  } catch (e) {
    // 「處理錯誤」屬性可能不存在 → 退而求其次只更新狀態
    if (/處理錯誤|property is not valid|Could not find property/i.test(e.message)) {
      console.warn(`[failed] 無「處理錯誤」屬性，只更新狀態: ${e.message}`);
      await updatePageStatus(env, pageId, '失敗');
    } else {
      console.warn(`[failed] ${pageId.substring(0,8)} mark 失敗: ${e.message}`);
    }
  }
}

// 補上內文 + 最終屬性（簡易重點、轉檔時間、狀態=草稿），placeholder pattern 的收尾
async function finalizePageWithContent(env, pageId, markdown, processingInfo) {
  const summary = extractSummaryFromMarkdown(markdown);
  const allChildren = markdownToNotionBlocks(markdown);

  // 1. append content blocks 分批
  await notionAppendChildrenBatched(env, pageId, allChildren);

  // 2. update final properties
  const props = {
    '狀態': { select: { name: '草稿' } },
  };
  if (summary) props['簡易重點'] = { rich_text: chunkRichText(summary) };
  if (processingInfo) {
    props['轉檔時間'] = { date: { start: processingInfo.processedAt.toISOString() } };
    props['轉檔耗時'] = { rich_text: chunkRichText(formatDuration(processingInfo.elapsedSec)) };
  }
  try {
    await notionFetch(env, `/pages/${pageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: props }),
    });
  } catch (e) {
    // 若是缺欄位，去掉時間欄位重試
    if (/轉檔時間|轉檔耗時|property is not valid|Could not find property/i.test(e.message)) {
      delete props['轉檔時間'];
      delete props['轉檔耗時'];
      await notionFetch(env, `/pages/${pageId}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: props }),
      });
    } else throw e;
  }
  console.log(`[finalize] ${pageId.substring(0,8)} → 草稿 (${allChildren.length} blocks)`);
}

async function listMeetings(env) {
  const body = { sorts: [{ property: '聚會日期', direction: 'descending' }], page_size: 100 };
  let allResults = [];
  let cursor;
  for (let i = 0; i < 5; i++) {
    if (cursor) body.start_cursor = cursor;
    const r = await notionFetch(env, `/databases/${env.NOTION_DATABASE_ID}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    allResults = allResults.concat(r.results);
    if (!r.has_more) break;
    cursor = r.next_cursor;
  }
  return { meetings: allResults.map(transformPage) };
}

async function getMeeting(env, id) {
  const page = await notionFetch(env, `/pages/${id}`);
  const result = transformPage(page);
  try {
    // Notion /blocks/:id/children 每次最多回 100 → cursor 翻頁直到 has_more=false
    // 安全上限 10 次（=1000 blocks），避免無窮迴圈
    let rawBlocks = [];
    let cursor;
    for (let i = 0; i < 10; i++) {
      const url = `/blocks/${id}/children?page_size=100` + (cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : '');
      const r = await notionFetch(env, url);
      rawBlocks = rawBlocks.concat(r.results || []);
      if (!r.has_more) break;
      cursor = r.next_cursor;
    }
    const blockArr = transformBlocks(rawBlocks);
    if (blockArr.length > 0) {
      result.blocks = blockArr;
      // 向後相容：保留 body 字串版（已棄用但前端舊版本可能還用）
      result.body = blockArr.map(b => b.text).filter(Boolean).join('\n\n');
    }
  } catch (e) { /* page body 失敗不影響主回應 */ }
  return result;
}

// 把 Notion blocks 轉成 { type, text } 陣列，給前端結構化渲染用
function transformBlocks(blocks) {
  return blocks.map(b => {
    const data = b[b.type];
    if (!data?.rich_text) return null;
    const text = data.rich_text.map(x => x.plain_text).join('');
    if (!text.trim()) return null;
    // 保留 rich text 片段（含 bold / italic / 顏色）+ block 級顏色
    const rich = data.rich_text.map(x => ({
      t: x.plain_text,
      b: !!(x.annotations && x.annotations.bold),
      i: !!(x.annotations && x.annotations.italic),
      c: (x.annotations && x.annotations.color && x.annotations.color !== 'default') ? x.annotations.color : null,
    }));
    const color = (data.color && data.color !== 'default') ? data.color : null;
    return { type: b.type, text, rich, color };
  }).filter(Boolean);
}

function transformPage(page) {
  const p = page.properties || {};
  return {
    id: page.id,
    topic: getTitle(p['聚會主題']),
    date: p['聚會日期']?.date?.start || null,
    type: p['聚會類型']?.select?.name || null,
    status: p['狀態']?.select?.name || null,
    speaker: getRichText(p['講員']),
    summary: getRichText(p['簡易重點']),
    fullContent: getRichText(p['完整重點']),
    verses: getRichText(p['參考經文']),
    info: getRichText(p['聚會資訊']),
    audioUrl: p['錄音檔連結']?.url || null,
    studyUrl: p['預查資料連結']?.url || null,
    attachmentUrl: p['附件資料夾']?.url || null,
    processingError: getRichText(p['處理錯誤']),
    createdTime: page.created_time || null,
    lastEditedTime: page.last_edited_time || null,
  };
}

function getTitle(prop) {
  if (!prop?.title) return '';
  return prop.title.map(t => t.plain_text).join('');
}

function getRichText(prop) {
  if (!prop?.rich_text) return '';
  return prop.rich_text.map(t => t.plain_text).join('');
}

function blocksToText(blocks) {
  return blocks.map(b => {
    const data = b[b.type];
    if (!data?.rich_text) return '';
    return data.rich_text.map(x => x.plain_text).join('');
  }).filter(Boolean).join('\n\n');
}

function chunkRichText(text, maxLen) {
  maxLen = maxLen || 2000;
  const s = String(text || '');
  if (!s) return [];
  const chunks = [];
  for (let i = 0; i < s.length; i += maxLen) {
    chunks.push({ text: { content: s.substring(i, i + maxLen) } });
  }
  return chunks;
}

// 錄音 dedup：用 Drive fileId 查 Notion「錄音檔連結」是否已含此 fileId
// （換掉舊的 date+type dedup，避免同日同時段多場活動撞 key，例如安息日下午正式聚會 + 社青團契）
async function isAudioAlreadyProcessed(env, fileId) {
  try {
    const r = await notionFetch(env, `/databases/${env.NOTION_DATABASE_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: { property: '錄音檔連結', url: { contains: fileId } },
        page_size: 1,
      }),
    });
    return (r.results || []).length > 0;
  } catch (e) {
    return false;
  }
}

// 預查 dedup：同概念，查「預查資料連結」是否已含此 fileId
// 給 handleStudySync（批次）用，比 date+type 更精準（同 fileId 重複處理避免）
async function isStudyAlreadyProcessed(env, fileId) {
  try {
    const r = await notionFetch(env, `/databases/${env.NOTION_DATABASE_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: { property: '預查資料連結', url: { contains: fileId } },
        page_size: 1,
      }),
    });
    return (r.results || []).length > 0;
  } catch (e) {
    return false;
  }
}

// 用 Notion filter 精準查詢「該日期+類型是否已有紀錄」（一次 subrequest）
// 仍用於預查 path（每週三只會有一場，date+type 對它是夠唯一的）
async function isNotionAlreadyProcessed(env, dateStr, type) {
  try {
    const r = await notionFetch(env, `/databases/${env.NOTION_DATABASE_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: {
          and: [
            { property: '聚會日期', date: { equals: dateStr } },
            { property: '聚會類型', select: { equals: type } },
          ],
        },
        page_size: 1,
      }),
    });
    return (r.results || []).length > 0;
  } catch (e) {
    return false;
  }
}

// 找出符合 date+type 的既有頁面 ID（用於 overwrite 模式封存）
async function findNotionPageIds(env, dateStr, type) {
  try {
    const r = await notionFetch(env, `/databases/${env.NOTION_DATABASE_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: {
          and: [
            { property: '聚會日期', date: { equals: dateStr } },
            { property: '聚會類型', select: { equals: type } },
          ],
        },
        page_size: 10,
      }),
    });
    return (r.results || []).map(p => p.id);
  } catch (e) {
    return [];
  }
}

// 封存（軟刪除）Notion 頁面
async function archiveNotionPage(env, pageId) {
  await notionFetch(env, `/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ archived: true }),
  });
}

// 寫入新 schema：properties 只放短欄位 + summary；長內容寫入 page body 為 markdown blocks
// processingInfo 可選：{ processedAt: Date, elapsedSec: number }
//   - 寫入 Notion 的「轉檔時間」+「轉檔耗時」欄位
//   - 欄位若不存在於 DB schema，Notion API 會回 400；此時靜默 fallback（不帶這兩欄）
async function createNotionPage(env, markdown, parsed, audioUrl, processingInfo) {
  const summary = extractSummaryFromMarkdown(markdown);

  const properties = {
    '聚會主題': { title: chunkRichText(parsed.topic || '(未命名)') },
    '聚會日期': { date: { start: parsed.isoDate } },
    '聚會類型': { select: { name: parsed.type } },
    '狀態': { select: { name: '草稿' } },
  };
  if (parsed.speaker) properties['講員'] = { rich_text: chunkRichText(parsed.speaker) };
  if (summary) properties['簡易重點'] = { rich_text: chunkRichText(summary) };
  if (audioUrl) properties['錄音檔連結'] = { url: audioUrl };
  if (processingInfo) {
    properties['轉檔時間'] = { date: { start: processingInfo.processedAt.toISOString() } };
    properties['轉檔耗時'] = { rich_text: chunkRichText(formatDuration(processingInfo.elapsedSec)) };
  }

  const children = markdownToNotionBlocks(markdown);
  const initialChildren = children.slice(0, 100);
  const restChildren = children.slice(100);

  async function createAndAppend(props) {
    const data = await notionFetch(env, '/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { database_id: env.NOTION_DATABASE_ID },
        properties: props,
        children: initialChildren,
      }),
    });
    if (restChildren.length > 0) {
      console.log(`[createNotionPage] 主體 100 已寫，附加 ${restChildren.length} blocks`);
      await notionAppendChildrenBatched(env, data.id, restChildren);
    }
    return data.id;
  }

  try {
    return await createAndAppend(properties);
  } catch (e) {
    // 若是「轉檔時間 / 轉檔耗時」這兩欄不存在的 schema 錯誤 → 拿掉重試一次
    // 避免使用者忘記在 Notion DB 加欄位整個壞掉
    const isSchemaErr = /轉檔時間|轉檔耗時|property is not valid|Could not find property/i.test(e.message);
    if (processingInfo && isSchemaErr) {
      console.warn(`[createNotionPage] schema 缺欄位，移除時間欄位重試：${e.message}`);
      delete properties['轉檔時間'];
      delete properties['轉檔耗時'];
      return await createAndAppend(properties);
    }
    throw e;
  }
}

// 把秒數格式化為「Nm Ns」中文：例如 95 → 「1分35秒」、45 → 「45秒」
function formatDuration(sec) {
  if (sec == null || isNaN(sec)) return '';
  if (sec < 60) return `${sec}秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}分${s}秒` : `${m}分`;
}

// =============================================================================
// 預查文件同步（Drive 預查資料夾 → Notion 週三晚間紀錄）
// =============================================================================

const STUDY_EXTS = ['.docx', '.pdf', '.doc'];
const STUDY_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/msword', // .doc
  'application/pdf', // .pdf
];
const SPEAKER_TITLES = ['弟兄', '姊妹', '執事', '傳道', '神學生'];

function isStudyFile(name, mimeType) {
  if (mimeType && STUDY_MIME_TYPES.indexOf(mimeType) >= 0) return true;
  const lower = (name || '').toLowerCase();
  return STUDY_EXTS.some(ext => lower.endsWith(ext));
}

// 讀已知講員清單（優先 Config Sheet，fallback 環境變數；逗號 / 分號 / 換行分隔）
async function getKnownSpeakers(env) {
  const raw = await getConfigValue(env, 'KNOWN_SPEAKERS', env.KNOWN_SPEAKERS || '');
  return raw.split(/[,，;；\n]/).map(s => s.trim()).filter(Boolean);
}

function parseStudyFilename(name, knownSpeakers) {
  knownSpeakers = knownSpeakers || [];
  const base = name.replace(/\.(docx|pdf|doc)$/i, '').trim();
  const titlePattern = SPEAKER_TITLES.join('|');

  // 0. 優先匹配已知講員（最長優先，例如「黃以諾執事」優先於「黃以諾」）
  if (knownSpeakers.length) {
    const sorted = [...knownSpeakers].sort((a, b) => b.length - a.length);
    for (const sp of sorted) {
      if (base.endsWith(sp)) {
        const topic = base.substring(0, base.length - sp.length).replace(/[_\-\s—–]+$/, '');
        if (topic.length > 0) return { topic, speaker: sp };
      }
    }
  }

  // 1. 用 _ 或 -- 明確分隔，最後一段是 2-8 字純中文 → speaker
  const sepParts = base.split(/_+|--+/);
  if (sepParts.length > 1) {
    const last = sepParts[sepParts.length - 1].trim();
    if (last.length >= 2 && last.length <= 8 && /^[一-龥]+$/.test(last)) {
      return {
        topic: sepParts.slice(0, -1).join('_').replace(/[\-\s—–]+$/, ''),
        speaker: last,
      };
    }
  }

  // 2. 結尾「N 字中文 + 職稱」（先試 3 字 = 最常見 → 2 → 4）
  for (const n of [3, 2, 4]) {
    const re = new RegExp(`([\\u4e00-\\u9fa5]{${n}}(?:${titlePattern}))$`);
    const m = base.match(re);
    if (m) {
      const speaker = m[1];
      const topic = base.substring(0, base.length - speaker.length).replace(/[_\-\s—–]+$/, '');
      if (topic.length > 0) return { topic, speaker };
    }
  }

  // 3. 結尾「預查 + 2-4 字中文」(沒職稱的版本，例如「徒二預查-信得」變體)
  const m3 = base.match(/預查([一-龥]{2,4})$/);
  if (m3) {
    const speaker = m3[1];
    return { topic: base.substring(0, base.length - speaker.length), speaker };
  }

  // 4. 都沒匹配 → 整個檔名當 topic
  return { topic: base, speaker: '' };
}

function parseDateFromText(text) {
  if (!text) return null;
  // 西元年：2026/04/15、2026-04-15、2026.4.15、2026年4月15日
  let m = text.match(/(\d{4})[\/\-\.年](\d{1,2})[\/\-\.月](\d{1,2})/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (y >= 2018 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)
      return `${y}-${pad2(mo)}-${pad2(d)}`;
  }
  // 緊湊：20260415
  m = text.match(/(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (y >= 2018 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)
      return `${y}-${pad2(mo)}-${pad2(d)}`;
  }
  // 民國年：115.5.20、115/5/20、115年5月20日、民國115年5月20日
  m = text.match(/(?:民國)?(\d{2,3})[\/\-\.年](\d{1,2})[\/\-\.月](\d{1,2})/);
  if (m) {
    const roc = +m[1], mo = +m[2], d = +m[3];
    if (roc >= 100 && roc <= 200 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)
      return `${roc + 1911}-${pad2(mo)}-${pad2(d)}`;
  }
  // 2 位西元短年：26/05/27、26-5-27 → 2026-05-27（前後不接其他數字，避免誤抓）
  m = text.match(/(?<!\d)(\d{2})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})(?!\d)/);
  if (m) {
    const yy = +m[1], mo = +m[2], d = +m[3];
    if (yy >= 20 && yy <= 99 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)
      return `${2000 + yy}-${pad2(mo)}-${pad2(d)}`;
  }
  return null;
}

// createdTime → 「下一個週三」(包含當天) 台北時間
function getNextWednesdayTaipei(isoTime) {
  const utc = new Date(isoTime);
  const taipei = new Date(utc.getTime() + 8 * 60 * 60 * 1000);
  const dow = taipei.getUTCDay();
  const daysToAdd = (3 - dow + 7) % 7;
  taipei.setUTCDate(taipei.getUTCDate() + daysToAdd);
  return `${taipei.getUTCFullYear()}-${pad2(taipei.getUTCMonth() + 1)}-${pad2(taipei.getUTCDate())}`;
}

function detectStudyDate(content, description, createdTime) {
  // 第一優先：內文前 ~10 行
  const firstLines = (content || '').split('\n').slice(0, 12).join('\n');
  let d = parseDateFromText(firstLines);
  if (d) return { date: d, source: 'content' };
  // 第二優先：Drive description
  d = parseDateFromText(description || '');
  if (d) return { date: d, source: 'description' };
  // 第三優先：createdTime → 下個週三
  return { date: getNextWednesdayTaipei(createdTime), source: 'createdTime' };
}

// 掃描預查父資料夾下的「子資料夾」（每本書一個資料夾）
// 父層直接放的檔案不處理（通常是無法分類的主題講座）
async function listStudyDocs(env) {
  const folderId = env.DRIVE_STUDY_FOLDER_ID;
  if (!folderId) throw new Error('未設定 DRIVE_STUDY_FOLDER_ID');
  const token = await getGoogleAccessToken(env);

  // 先列出父層所有「子資料夾」
  const q = `'${folderId}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`;
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`列子資料夾失敗 ${res.status}`);
  const data = await res.json();

  // 對每個子資料夾遞迴掃描音檔/文件
  const results = [];
  for (const folder of (data.files || [])) {
    await scanStudyFolder(token, folder.id, results);
  }
  return results;
}

async function scanStudyFolder(token, folderId, results) {
  const q = `'${folderId}' in parents and trashed = false`;
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,size,createdTime,modifiedTime,mimeType,description,parents)&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return;
  const data = await res.json();
  for (const f of (data.files || [])) {
    if (f.mimeType === 'application/vnd.google-apps.folder') {
      await scanStudyFolder(token, f.id, results);
    } else if (isStudyFile(f.name, f.mimeType)) {
      results.push(f);
    }
  }
}

// 把 .docx/.pdf 轉成 Google Doc 再 export 純文字
async function extractDocText(env, file) {
  const token = await getGoogleAccessToken(env);
  // Step 1: copy 成 Google Doc 格式
  const copyRes = await fetch(
    `${DRIVE_API}/files/${file.id}/copy?supportsAllDrives=true`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `_temp_study_${Date.now()}`,
        mimeType: 'application/vnd.google-apps.document',
      }),
    }
  );
  if (!copyRes.ok) {
    throw new Error(`Drive copy 失敗 ${copyRes.status}: ${(await copyRes.text()).substring(0, 200)}`);
  }
  const { id: tempId } = await copyRes.json();

  let text;
  try {
    // Step 2: export plain text
    const exportRes = await fetch(
      `${DRIVE_API}/files/${tempId}/export?mimeType=text/plain`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!exportRes.ok) {
      throw new Error(`Drive export 失敗 ${exportRes.status}: ${(await exportRes.text()).substring(0, 200)}`);
    }
    text = await exportRes.text();
  } finally {
    // Step 3: 移到垃圾桶（用 PATCH trashed:true，比 DELETE 永久刪除更可靠 —
    // SA 對共用 Drive 內的檔案常沒有永久刪除權限，DELETE 會回 404）
    try {
      const trashRes = await fetch(`${DRIVE_API}/files/${tempId}?supportsAllDrives=true`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      });
      if (!trashRes.ok) {
        console.warn(`[extractDocText] 移除暫存失敗 ${trashRes.status}: tempId=${tempId}, body=${(await trashRes.text()).substring(0, 200)}`);
      }
    } catch (e) {
      console.warn(`[extractDocText] 移除暫存錯誤: ${e.message}, tempId=${tempId}`);
    }
  }
  return text;
}

// 清理殘留的 _temp_study_* 暫存檔（給手動觸發或日後 cron 用）
//
// 安全保護（每一筆檔案都要全部通過才會被處理）：
//   1. 檔名 regex 必須完全符合 /^_temp_study_\d{10,16}$/（無副檔名，純 timestamp）
//   2. mimeType 必須是 application/vnd.google-apps.document（Google Doc）
//   3. 擁有者必須是當前 Service Account（我們建的才能刪）
//   4. 不用永久刪除，改用 PATCH trashed:true 移到垃圾桶（30 天內可救回）
//
// 任何一項不符 → 略過該檔，記到 skipped。
const TEMP_NAME_RE = /^_temp_study_\d{10,16}$/;
const GDOC_MIME = 'application/vnd.google-apps.document';

// 代理 Drive 錄音檔（解決 native <audio> 拿不到公開連結的問題）
// 透傳 Range header 讓瀏覽器可以拖曳定位
async function handleAudioStream(env, fileId, request, origin) {
  let token;
  try { token = await getGoogleAccessToken(env); }
  catch (e) { return new Response('Auth failed: ' + e.message, { status: 500 }); }

  const driveUrl = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const fwd = { Authorization: `Bearer ${token}` };
  const range = request.headers.get('Range');
  if (range) fwd.Range = range;

  const driveRes = await fetch(driveUrl, { headers: fwd });
  if (!driveRes.ok && driveRes.status !== 206) {
    return new Response('Drive fetch failed: ' + driveRes.status, { status: driveRes.status });
  }

  const out = new Headers();
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = driveRes.headers.get(h);
    if (v) out.set(h, v);
  }
  if (!out.get('Accept-Ranges')) out.set('Accept-Ranges', 'bytes');
  if (!out.get('Content-Type')) out.set('Content-Type', 'audio/mpeg');
  out.set('Access-Control-Allow-Origin', origin);
  out.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  out.set('Cache-Control', 'public, max-age=3600');

  if (request.method === 'HEAD') {
    return new Response(null, { status: driveRes.status, headers: out });
  }
  return new Response(driveRes.body, { status: driveRes.status, headers: out });
}

async function cleanupStudyTempFiles(env) {
  const token = await getGoogleAccessToken(env);

  // 取得當前 SA email（用來比對檔案擁有者）
  const saEmail = (env.SERVICE_ACCOUNT_KEY && JSON.parse(env.SERVICE_ACCOUNT_KEY).client_email) || '';

  // 即使 query 有 'name contains'，後面還會逐筆嚴格比對，所以 query 寬鬆無妨
  const query = encodeURIComponent("name contains '_temp_study_' and trashed = false");
  const listRes = await fetch(
    `${DRIVE_API}/files?q=${query}&fields=files(id,name,mimeType,owners)&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!listRes.ok) {
    throw new Error(`掃描失敗 ${listRes.status}: ${(await listRes.text()).substring(0, 200)}`);
  }
  const { files = [] } = await listRes.json();

  const result = { found: files.length, deleted: [], skipped: [], failed: [], saEmail };

  for (const f of files) {
    const ownerEmail = (f.owners && f.owners[0] && f.owners[0].emailAddress) || '';

    // 安全檢查 1：檔名 regex
    if (!TEMP_NAME_RE.test(f.name)) {
      result.skipped.push({ id: f.id, name: f.name, reason: 'name not matching /^_temp_study_\\d+$/' });
      continue;
    }
    // 安全檢查 2：mimeType
    if (f.mimeType !== GDOC_MIME) {
      result.skipped.push({ id: f.id, name: f.name, reason: `mimeType is ${f.mimeType}, not Google Doc` });
      continue;
    }
    // 安全檢查 3：擁有者 — 只擋「明確有 owner 且不是 SA」的檔
    // 共用雲端硬碟的檔案 owner 為空白，配合 name regex + Google Doc mimeType 兩道檢查已足夠安全
    if (ownerEmail && saEmail && ownerEmail !== saEmail) {
      result.skipped.push({ id: f.id, name: f.name, reason: `owner is ${ownerEmail}, not SA ${saEmail}` });
      continue;
    }

    // 三項都通過，移到垃圾桶（非永久刪除）
    try {
      const trashRes = await fetch(`${DRIVE_API}/files/${f.id}?supportsAllDrives=true`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      });
      if (trashRes.ok) {
        result.deleted.push({ id: f.id, name: f.name, owner: ownerEmail });
      } else {
        const errText = (await trashRes.text()).substring(0, 200);
        result.failed.push({ id: f.id, name: f.name, owner: ownerEmail, status: trashRes.status, error: errText });
      }
    } catch (e) {
      result.failed.push({ id: f.id, name: f.name, owner: ownerEmail, error: e.message });
    }
  }

  console.log(`[cleanup] 掃到 ${result.found}，符合條件移除 ${result.deleted.length}，略過 ${result.skipped.length}，失敗 ${result.failed.length}`);
  return result;
}

// 純文字啟發式 → Notion blocks（保留段落結構）
function textToNotionBlocks(text) {
  const blocks = [];
  const lines = text.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // 不再 cap：呼叫端會把超過 100 的 children 分批 append（見 notionAppendChildrenBatched）

    // # / ## / ### 標題
    if (line.match(/^#+\s+/)) {
      const level = (line.match(/^(#+)/) || ['', ''])[1].length;
      const content = line.replace(/^#+\s+/, '');
      blocks.push(makeBlock(level <= 1 ? 'heading_2' : 'heading_3', content));
    }
    // 中文標號當小標：「一、」「二、」... (但要夠短，避免長段落被誤判)
    else if (line.match(/^[一二三四五六七八九十]+、/) && line.length < 60) {
      blocks.push(makeBlock('heading_3', line));
    }
    // bullet
    else if (line.match(/^[-•*●]\s+/)) {
      blocks.push(makeBlock('bulleted_list_item', line.replace(/^[-•*●]\s+/, '')));
    }
    // 一般段落
    else {
      blocks.push(makeBlock('paragraph', line));
    }
  }
  return blocks;
}

// 列出所有預查文件（快速，不讀內容，純用 createdTime → 下個週三估計日期）
async function handleStudyList(env) {
  const docs = await listStudyDocs(env);
  const knownSpeakers = await getKnownSpeakers(env);
  return {
    docs: docs.map(doc => {
      const { topic, speaker } = parseStudyFilename(doc.name, knownSpeakers);
      const estimatedDate = getNextWednesdayTaipei(doc.createdTime);
      return {
        id: doc.id,
        name: doc.name,
        topic,
        speaker,
        estimatedDate,
        url: `https://drive.google.com/file/d/${doc.id}/view`,
        sizeMB: doc.size ? +(doc.size / 1024 / 1024).toFixed(1) : null,
        createdTime: doc.createdTime,
      };
    }),
    count: docs.length,
  };
}

// 處理單篇預查（從前端點擊觸發）
// overwrite=true：找到同 date+type 的舊紀錄先封存，再建新的（用於重跑覆蓋）
// requireContentDate=true：日期只能從 createdTime 取得時拒絕寫入（避免搬檔後 createdTime 全相同造成誤撞）
// dateOverride（YYYY-MM-DD）：直接指定日期，跳過偵測（用於人工推算補寫）
async function processSingleStudyDoc(env, fileId, overwrite, requireContentDate, dateOverride) {
  const t0 = Date.now();
  const token = await getGoogleAccessToken(env);
  const metaRes = await fetch(
    `${DRIVE_API}/files/${fileId}?fields=id,name,size,createdTime,description,mimeType&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!metaRes.ok) {
    return { success: false, error: `Drive meta 失敗 ${metaRes.status}` };
  }
  const file = await metaRes.json();

  const { topic, speaker } = parseStudyFilename(file.name, await getKnownSpeakers(env));
  console.log(`[study/process] ${file.name}${overwrite ? ' (overwrite)' : ''}`);

  let text;
  try {
    text = await extractDocText(env, file);
  } catch (e) {
    return { success: false, error: '抽取內文失敗：' + e.message };
  }

  // 日期：優先用人工指定的 dateOverride，否則自動偵測
  let dateStr, dateSrc;
  if (dateOverride && /^\d{4}-\d{2}-\d{2}$/.test(dateOverride)) {
    dateStr = dateOverride;
    dateSrc = 'override';
  } else {
    const dateInfo = detectStudyDate(text, file.description, file.createdTime);
    dateStr = dateInfo.date;
    dateSrc = dateInfo.source;
  }
  const type = '週三晚間';

  // 防護：日期只能靠 createdTime 時拒絕（搬檔後 createdTime 全部相同，會誤撞）
  if (requireContentDate && dateSrc === 'createdTime') {
    console.warn(`[study/process] ✗ ${file.name} 無內文/description 日期，拒絕寫入（避免 createdTime 誤撞）`);
    return {
      success: false,
      error: '無法從內文或 description 取得日期（createdTime 不可信），已跳過，需手動指定日期',
      topic, speaker,
      date: null,
      dateSource: 'rejected',
    };
  }

  // 重複處理：overwrite → 封存舊紀錄；否則跳過
  let archived = 0;
  if (overwrite) {
    const ids = await findNotionPageIds(env, dateStr, type);
    for (const pid of ids) {
      try { await archiveNotionPage(env, pid); archived++; }
      catch (e) { console.warn(`[study/process] 封存 ${pid} 失敗: ${e.message}`); }
    }
    if (archived) console.log(`[study/process] 封存 ${archived} 筆舊紀錄 (${dateStr} ${type})`);
  } else if (await isNotionAlreadyProcessed(env, dateStr, type)) {
    return { success: false, error: `Notion 已有 ${dateStr} ${type} 的紀錄` };
  }

  const elapsedSec = Math.round((Date.now() - t0) / 1000);
  const properties = {
    '聚會主題': { title: chunkRichText(topic) },
    '聚會日期': { date: { start: `${dateStr}T19:30:00+08:00` } },
    '聚會類型': { select: { name: type } },
    '狀態': { select: { name: '草稿' } },
    '預查資料連結': { url: `https://drive.google.com/file/d/${file.id}/view` },
    '轉檔時間': { date: { start: new Date().toISOString() } },
    '轉檔耗時': { rich_text: chunkRichText(formatDuration(elapsedSec)) },
  };
  if (speaker) properties['講員'] = { rich_text: chunkRichText(speaker) };
  // 預查不寫「簡易重點」(C 方案：留空，校稿時自填)

  try {
    const allChildren = textToNotionBlocks(text);
    const data = await notionFetch(env, '/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { database_id: env.NOTION_DATABASE_ID },
        properties,
        children: allChildren.slice(0, 100),
      }),
    });
    if (allChildren.length > 100) {
      console.log(`[study/process] 主體 100 已寫，附加 ${allChildren.length - 100} blocks`);
      await notionAppendChildrenBatched(env, data.id, allChildren.slice(100));
    }
    return {
      success: true,
      notionId: data.id,
      topic, speaker,
      date: dateStr,
      dateSource: dateSrc,
      archived,
      elapsedSec,
      blocks: allChildren.length,
    };
  } catch (e) {
    return { success: false, error: 'Notion 寫入失敗：' + e.message };
  }
}

// 主處理流程（批次）
async function handleStudySync(env, limit) {
  const docs = await listStudyDocs(env);
  console.log(`[study] 掃描到 ${docs.length} 個預查檔案`);

  const knownSpeakers = await getKnownSpeakers(env);
  const result = {
    total: docs.length,
    limit,
    processed: [],
    skipped: [],
    failed: [],
  };

  let count = 0;
  for (const doc of docs) {
    if (count >= limit) {
      result.remaining = docs.length - result.processed.length - result.skipped.length - result.failed.length;
      break;
    }

    const { topic, speaker } = parseStudyFilename(doc.name, knownSpeakers);
    try {
      console.log(`[study] 處理 ${doc.name}`);

      // dedup 提前：用 fileId 查「預查資料連結」，已存在就跳過、不浪費 docx 下載+解析
      if (await isStudyAlreadyProcessed(env, doc.id)) {
        result.skipped.push({ name: doc.name, reason: 'Notion 已有此檔案的紀錄' });
        count++;
        continue;
      }

      // 讀內容（用於日期偵測 + Notion body）
      const text = await extractDocText(env, doc);

      const dateInfo = detectStudyDate(text, doc.description, doc.createdTime);
      const dateStr = dateInfo.date;
      const type = '週三晚間';

      // 組裝 properties
      const properties = {
        '聚會主題': { title: chunkRichText(topic) },
        '聚會日期': { date: { start: `${dateStr}T19:30:00+08:00` } },
        '聚會類型': { select: { name: type } },
        '狀態': { select: { name: '草稿' } },
        '預查資料連結': { url: `https://drive.google.com/file/d/${doc.id}/view` },
      };
      if (speaker) properties['講員'] = { rich_text: chunkRichText(speaker) };
      // 預查不寫「簡易重點」

      // 寫入 Notion（分批：先 100，超過的 append）
      const allChildren = textToNotionBlocks(text);
      const data = await notionFetch(env, '/pages', {
        method: 'POST',
        body: JSON.stringify({
          parent: { database_id: env.NOTION_DATABASE_ID },
          properties,
          children: allChildren.slice(0, 100),
        }),
      });
      if (allChildren.length > 100) {
        await notionAppendChildrenBatched(env, data.id, allChildren.slice(100));
      }

      result.processed.push({
        name: doc.name,
        date: dateStr,
        dateSource: dateInfo.source,
        topic,
        speaker,
        notionId: data.id,
      });
      count++;
    } catch (e) {
      console.error(`[study] ${doc.name} 失敗: ${e.message}`);
      result.failed.push({ name: doc.name, topic, speaker, error: e.message });
      count++;
    }
  }

  if (!result.remaining) {
    result.remaining = docs.length - result.processed.length - result.skipped.length - result.failed.length;
  }
  return result;
}

// =============================================================================
// 主處理流程
// =============================================================================

// 每日排程：找近期上傳的音檔，逐一處理
// 排程處理：
// - 每次 cron 最多處理 QUOTA_PER_RUN 筆（env 預設 5；free tier subrequest 限 50）
// - 優先順序：今天 createdTime > 今天 0:00 的檔 → 其他依檔名（日期）desc
// - 已存在於 Notion 的（date+type 對應）自動跳過
// - 失敗不算進 quota，下次 cron 會再試
async function runDailyProcess(env) {
  const QUOTA = parseInt(env.QUOTA_PER_RUN || '5', 10);
  console.log(`[daily] start at ${new Date().toISOString()}, quota=${QUOTA}`);

  let candidates;
  try {
    candidates = await listAllAudioCandidates(env);
  } catch (e) {
    console.error('[daily] 列檔失敗:', e.message);
    return;
  }

  // 建已處理 set（一次 Notion 查詢，避免逐筆查詢）
  // 用 audioUrl 解出 fileId，每個音檔 = 一筆紀錄，避免 date+type 撞 key
  let processedFileIds = new Set();
  try {
    const { meetings } = await listMeetings(env);
    meetings.forEach(m => {
      const au = m.audioUrl || '';
      const fm = au.match(/\/d\/([^/]+)/);
      if (fm) processedFileIds.add(fm[1]);
    });
  } catch (e) {
    console.warn('[daily] listMeetings 失敗，去重將回退到逐筆檢查:', e.message);
  }

  // 過濾未處理 + 排序（今天上傳的優先，其他依檔名 desc）
  const unprocessed = candidates
    .filter(f => !processedFileIds.has(f.id))
    .sort((a, b) => {
      if (a.uploadedToday !== b.uploadedToday) return a.uploadedToday ? -1 : 1;
      return b.name.localeCompare(a.name);
    });

  console.log(`[daily] 候選 ${candidates.length} 個，未處理 ${unprocessed.length} 個`);

  let processed = 0;
  const results = [];
  for (const file of unprocessed) {
    if (processed >= QUOTA) break;
    console.log(`[daily] [${processed + 1}/${QUOTA}] 處理 ${file.name}${file.uploadedToday ? ' (今天上傳)' : ''}`);
    try {
      const r = await processAudio(env, { fileId: file.id });
      if (r.success) {
        console.log(`[daily] ✓ ${file.name} → ${r.notionId}`);
        results.push({ name: file.name, ok: true, notionId: r.notionId });
        processed++;
      } else {
        console.log(`[daily] skip ${file.name}: ${r.error}`);
        results.push({ name: file.name, ok: false, error: r.error });
        // 失敗不算進 quota，繼續下一筆（避免被同一個壞檔卡住整批）
      }
    } catch (e) {
      console.error(`[daily] error ${file.name}: ${e.message}`);
      results.push({ name: file.name, ok: false, error: e.message });
    }
  }

  console.log(`[daily] done, processed=${processed}/${QUOTA}, remaining=${unprocessed.length - processed}`);
  return { quota: QUOTA, processed, remaining: unprocessed.length - processed, results };
}

// 列出所有候選音檔（已解析檔名 + 今天上傳旗標）
//
// 改用「副檔名 OR」當 Drive query 篩選，不用 'folder in parents'
// 因為錄音檔可能在子資料夾裡（按年份/月份分），parent 直查抓不到。
// SA 本身只看得到分享過來的資料夾樹，所以不會撈到外面的檔案。
async function listAllAudioCandidates(env) {
  const token = await getGoogleAccessToken(env);

  // Drive query 支援 OR：篩出所有副檔名屬於音檔的
  const extQ = AUDIO_EXTS.map(ext => `name contains '${ext}'`).join(' or ');
  const q = `(${extQ}) and trashed = false`;
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,size,createdTime,mimeType,parents)&pageSize=500&supportsAllDrives=true&includeItemsFromAllDrives=true&orderBy=name desc`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Drive list ${res.status}: ${(await res.text()).substring(0, 200)}`);
  }
  const data = await res.json();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const all = data.files || [];
  console.log(`[daily] Drive 回傳 ${all.length} 個音檔（副檔名篩選）`);

  const candidates = all
    .filter(f => isAudioFile(f.name))   // 再次保險（避免 Drive query 誤判）
    .map(f => {
      const parsed = parseFilename(f.name, f.createdTime);
      return {
        id: f.id,
        name: f.name,
        size: f.size,
        createdTime: f.createdTime,
        parsed,
        uploadedToday: new Date(f.createdTime) >= todayStart,
      };
    })
    .filter(f => f.parsed && f.parsed.type);  // 只留檔名可解析的

  console.log(`[daily] 檔名可解析 ${candidates.length} 個`);
  return candidates;
}

// pageId（optional）：placeholder pattern — 若給，全程 update 該 page 的狀態，最後 finalizePageWithContent；
//   未給：legacy 模式，最後 createNotionPage 建新 page（給 cron 等沒走 placeholder 的呼叫者）
async function processAudio(env, payload, pageId) {
  const t0 = Date.now();
  let fileId = payload.fileId;
  let fileMeta;
  const setStatus = async (s) => { if (pageId) await updatePageStatus(env, pageId, s); };

  // 短檔案 ID 當 log 前綴，方便多筆並行時對齊
  const mark = (id) => `[${(id || '?').substring(0, 8)}]`;

  // 用 (date, type) 找檔案
  if (!fileId && payload.date && payload.type) {
    console.log(`${mark()} 用 date+type 找檔案：${payload.date} ${payload.type}`);
    const year = parseInt(payload.date.substring(0, 4), 10);
    const month = parseInt(payload.date.substring(5, 7), 10);
    const list = await listDriveFiles(env, year, month);
    const match = list.files.find(f => f.date === payload.date && f.type === payload.type);
    if (!match) {
      console.warn(`${mark()} ✗ 找不到對應錄音：${payload.date} ${payload.type}`);
      return { success: false, error: `找不到對應錄音：${payload.date} ${payload.type}` };
    }
    fileId = match.id;
  }

  if (!fileId) {
    return { success: false, error: '需要 fileId 或 (date + type)' };
  }

  const m = mark(fileId);
  const stepTimes = {};

  try {
    // === Step 1: Drive metadata ===
    let stepStart = Date.now();
    fileMeta = await getDriveFileMeta(env, fileId);
    stepTimes.meta = Date.now() - stepStart;
    const sizeMB = fileMeta.size ? +(fileMeta.size / 1024 / 1024).toFixed(1) : null;
    console.log(`${m} 1. metadata OK：${fileMeta.name} (${sizeMB}MB) — ${stepTimes.meta}ms`);

    const parsed = parseFilename(fileMeta.name, fileMeta.createdTime);
    if (!parsed) throw new Error(`檔名格式錯誤：${fileMeta.name}`);
    if (!parsed.type) throw new Error(`無法判斷聚會類型：${parsed.dateStr}`);

    // 聚會資訊 context — prepend 到 Gemini prompt，讓它知道聚會類型（修「安息日誤判」）
    const DOW_CN = ['日', '一', '二', '三', '四', '五', '六'];
    const meetingInfo = `【聚會資訊】（系統提供，請務必據此判斷聚會性質，不要自行臆測）
- 聚會類型：${parsed.type}
- 日期：${parsed.dateStr}（星期${DOW_CN[parsed.dow]}）
- 講員：${parsed.speaker || '（未提供）'}
- 主題：${parsed.topic || '（未提供）'}`;

    // === Step 2: Notion dedup check（用 fileId，不再用 date+type）===
    // 注意：placeholder pattern 下 caller (route) 已經做過 dedup 才建 placeholder，這邊 skip 避免自撞
    // （placeholder 內已填「錄音檔連結」，再 query 一次會撞到自己）
    stepStart = Date.now();
    if (!pageId && await isAudioAlreadyProcessed(env, fileId)) {
      stepTimes.dedup = Date.now() - stepStart;
      console.log(`${m} ⏭ Notion 已有此 fileId 的紀錄 — skip`);
      return { success: false, error: 'Notion 已有此錄音的紀錄', topic: parsed.topic };
    }
    stepTimes.dedup = Date.now() - stepStart;
    console.log(`${m} 2. dedup check ${pageId ? '已由 caller 完成' : 'OK'} — ${stepTimes.dedup}ms`);

    // === Step 3: 決定切割策略（依 metadata size 判斷，先不下載）===
    const mimeType = fileMeta.mimeType || 'audio/mpeg';
    const fileSize = parseInt(fileMeta.size, 10) || 0;

    // 切割閾值從 Config Sheet 讀（MB），預設 25
    const thresholdMB = parseFloat(await getConfigValue(env, 'split_threshold_mb', '25'));
    const thresholdBytes = isNaN(thresholdMB) ? DEFAULT_SPLIT_THRESHOLD_BYTES : thresholdMB * 1024 * 1024;
    const needSplit = fileSize > thresholdBytes
                   && SPLITTABLE_MIMES.indexOf(mimeType) >= 0;

    let markdown;
    if (needSplit) {
      // === 3-step pipeline with overlap ===
      // 用 Range 各自下載「前半」「後半」，避免整顆灌進 128MB worker 記憶體
      const overlapPct = parseFloat(await getConfigValue(env, 'split_overlap_pct', '10'));
      const validOverlap = (isNaN(overlapPct) || overlapPct < 0 || overlapPct > 40) ? 10 : overlapPct;
      // 每半段佔 (50 + overlap/2)%。例：overlap=10 → 每半 55%，前 0~55%、後 45~100%
      const halfBytes = Math.floor(fileSize * (50 + validOverlap / 2) / 100);

      console.log(`${m} 3-4. 大檔策略 (檔案 ${(fileSize/1024/1024).toFixed(1)}MB > 閾值 ${thresholdMB}MB, 重疊 ${validOverlap}%): 各半 ~${(halfBytes/1024/1024).toFixed(1)}MB`);

      // 前/後段各自的 prompt（Config Sheet 個別指定），向後相容：沒設就 fallback 到 split_summary
      const summaryFallback = await getConfigValue(env, 'gemini_split_summary_prompt', DEFAULT_SPLIT_SUMMARY_PROMPT);
      const FRONT_PROMPT = await getConfigValue(env, 'gemini_split_front_prompt', summaryFallback);
      const BACK_PROMPT = await getConfigValue(env, 'gemini_split_back_prompt', summaryFallback);
      const MERGE_PROMPT = await getConfigValue(env, 'gemini_split_merge_prompt', DEFAULT_SPLIT_MERGE_PROMPT);

      // Step 1: 前半 Range download + brain dump（用 block 限縮 scope，讓 part1 在 Gemini call 後可 GC）
      let brain1;
      stepStart = Date.now();
      {
        await setStatus('AI 分析中（前半）');
        console.log(`${m} 4a. 下載前半 0~${halfBytes-1} (${(halfBytes/1024/1024).toFixed(1)}MB)...`);
        const t1d = Date.now();
        const part1 = await downloadDriveFilePart(env, fileId, 0, halfBytes - 1);
        console.log(`${m} 4a. 前半下載 ${(part1.byteLength/1024/1024).toFixed(1)}MB — ${((Date.now()-t1d)/1000).toFixed(1)}s`);
        const t1g = Date.now();
        console.log(`${m} 4a. Gemini 理解前半（front prompt）...`);
        brain1 = await geminiAnalyze(env, part1, mimeType, fileMeta.name + ' (前半段)', meetingInfo, FRONT_PROMPT);
        stepTimes.gemini_part1 = Date.now() - t1g;
        console.log(`${m} 4a. 前半 brain dump OK：${brain1.length} 字 — ${(stepTimes.gemini_part1/1000).toFixed(1)}s`);
      }

      // Step 2: 後半 Range download + brain dump
      let brain2;
      {
        await setStatus('AI 分析中（後半）');
        const startByte = fileSize - halfBytes;
        console.log(`${m} 4b. 下載後半 ${startByte}~${fileSize-1} (${(halfBytes/1024/1024).toFixed(1)}MB)...`);
        const t2d = Date.now();
        const part2 = await downloadDriveFilePart(env, fileId, startByte, fileSize - 1);
        console.log(`${m} 4b. 後半下載 ${(part2.byteLength/1024/1024).toFixed(1)}MB — ${((Date.now()-t2d)/1000).toFixed(1)}s`);
        const t2g = Date.now();
        console.log(`${m} 4b. Gemini 理解後半（back prompt）...`);
        brain2 = await geminiAnalyze(env, part2, mimeType, fileMeta.name + ' (後半段)', meetingInfo, BACK_PROMPT);
        stepTimes.gemini_part2 = Date.now() - t2g;
        console.log(`${m} 4b. 後半 brain dump OK：${brain2.length} 字 — ${(stepTimes.gemini_part2/1000).toFixed(1)}s`);
      }

      // Step 3: 純文字整合（meetingInfo 也帶進去，讓整合階段知道聚會性質）
      await setStatus('整合中');
      const t3 = Date.now();
      console.log(`${m} 4c. Gemini 整合兩段為最終格式（純文字）...`);
      const combinedInput = `${meetingInfo}\n\n【前半段要點】\n\n${brain1}\n\n---\n\n【後半段要點】\n\n${brain2}`;
      markdown = await geminiAnalyzeText(env, MERGE_PROMPT, combinedInput);
      stepTimes.gemini_merge = Date.now() - t3;
      console.log(`${m} 4c. 整合完成：${markdown.length} 字 — ${(stepTimes.gemini_merge/1000).toFixed(1)}s`);

      stepTimes.gemini = Date.now() - stepStart;
      console.log(`${m} 4. 切割流程總耗時 ${(stepTimes.gemini/1000).toFixed(1)}s (含 3 次 Gemini call)`);
    } else {
      // 小檔：整顆下載
      await setStatus('下載中');
      stepStart = Date.now();
      console.log(`${m} 3. 小檔，整顆下載中...`);
      const audioBytes = await downloadDriveFile(env, fileId);
      stepTimes.download = Date.now() - stepStart;
      console.log(`${m} 3. 下載完成 ${(audioBytes.byteLength / 1024 / 1024).toFixed(1)}MB — ${(stepTimes.download / 1000).toFixed(1)}s`);

      await setStatus('AI 分析中');
      stepStart = Date.now();
      console.log(`${m} 4. 呼叫 Gemini...`);
      markdown = await geminiAnalyze(env, audioBytes, mimeType, fileMeta.name, meetingInfo);
      stepTimes.gemini = Date.now() - stepStart;
      console.log(`${m} 4. Gemini OK：${markdown.length} 字 — ${(stepTimes.gemini / 1000).toFixed(1)}s`);
    }

    // === Step 5: 寫入 Notion ===
    await setStatus('寫入內容');
    stepStart = Date.now();
    console.log(`${m} 5. 寫入 Notion...`);
    const audioUrl = `https://drive.google.com/file/d/${fileId}/view`;
    const totalMs = Date.now() - t0;
    const processingInfo = { processedAt: new Date(), elapsedSec: Math.round(totalMs / 1000) };

    let finalNotionId;
    if (pageId) {
      // placeholder pattern：補上內文 + 最終屬性，狀態設為「草稿」
      await finalizePageWithContent(env, pageId, markdown, processingInfo);
      finalNotionId = pageId;
    } else {
      // legacy：建立新 page（例如 cron path 沒走 placeholder）
      finalNotionId = await createNotionPage(env, markdown, parsed, audioUrl, processingInfo);
    }
    stepTimes.notion = Date.now() - stepStart;
    console.log(`${m} 5. Notion ${pageId ? '更新' : '建立'}：${finalNotionId} — ${stepTimes.notion}ms`);

    const totalSec = Math.round(totalMs / 1000);
    console.log(`${m} ✓ 完成 ${fileMeta.name} | 總耗時 ${totalSec}s | 步驟ms: ${JSON.stringify(stepTimes)}`);

    return {
      success: true,
      notionId: finalNotionId,
      topic: parsed.topic,
      speaker: parsed.speaker,
      date: parsed.isoDate,
      type: parsed.type,
      sizeMB,
      elapsedSec: totalSec,
    };
  } catch (e) {
    // 失敗時印出在哪一步、累積跑了多久（最重要的除錯資訊）
    const totalSec = Math.round((Date.now() - t0) / 1000);
    const lastStep = Object.keys(stepTimes).pop() || '(尚未開始)';
    console.error(`${m} ✗ 失敗於 [${lastStep}] 之後 | 累積 ${totalSec}s | 已完成步驟ms: ${JSON.stringify(stepTimes)} | error: ${e.message}`);
    // 將時間資訊塞進 error 讓 caller 看到
    return {
      success: false,
      error: e.message,
      failedAfter: lastStep,
      elapsedSec: totalSec,
    };
  }
}
