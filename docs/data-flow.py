# 產生 liming-meeting 資料流程圖 docs/data-flow.svg
# 用法：python docs/data-flow.py　（改圖請改這支，不要手改 SVG；畫法見 ~/.claude/rules/diagram-dataflow.md）
import os
import sys
from xml.sax.saxutils import escape

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data-flow.svg')
W, H = 1500, 922
TOP = 162  # 方塊從這裡開始；標題區加減行數時調這個
FONT = "'Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif"
BLUE, GREEN, GOLD, GRAY, DARK = '#7c9cc4', '#7fa87f', '#c9a15c', '#8b93a6', '#4a5164'
LINE_H, PAD_TOP, PAD_BOT, HEAD = 19, 14, 10, 30

parts = []
def add(s): parts.append(s)

def box_h(n):
    return HEAD + PAD_TOP + n * LINE_H + PAD_BOT

def box(x, y, w, title, lines, color, bold_first=False):
    h = box_h(len(lines))
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="#ffffff" stroke="{color}" stroke-width="1.6" rx="7"/>')
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{HEAD}" fill="{color}" rx="7"/>')
    add(f'<rect x="{x}" y="{y + HEAD - 8}" width="{w}" height="8" fill="{color}"/>')
    add(f'<text x="{x + 14}" y="{y + 20}" font-size="14.5" font-weight="700" fill="#ffffff">{escape(title)}</text>')
    for i, t in enumerate(lines):
        ty = y + HEAD + PAD_TOP + 4 + i * LINE_H
        weight = ' font-weight="700"' if (bold_first and i == 0) else ''
        fill = '#1a1d24' if (bold_first and i == 0) else '#4a5164'
        add(f'<text x="{x + 14}" y="{ty}" font-size="12.5"{weight} fill="{fill}">{escape(t)}</text>')
    return h

def arrow(points, color, dashed=False, label=None, lx=None, ly=None, anchor='middle'):
    d = 'M' + ' L'.join(f'{px} {py}' for px, py in points)
    dash = ' stroke-dasharray="5 4"' if dashed else ''
    mid = {BLUE: 'ab', GREEN: 'ag', GOLD: 'ao', GRAY: 'ay'}[color]
    add(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="1.8"{dash} marker-end="url(#{mid})"/>')
    if label:
        add(f'<text x="{lx}" y="{ly}" font-size="11.5" fill="{color}" font-weight="700" text-anchor="{anchor}">{escape(label)}</text>')

add(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="{FONT}">')
add('  <!-- 聚會紀錄系統的資料流程。由 docs/data-flow.py 產生，改圖請改腳本重新執行，不要手改這個檔。改動資料來源、排程、兩個畫面的區塊時要同步更新。 -->')
add('<defs>')
for mid, c in [('ab', BLUE), ('ag', GREEN), ('ao', GOLD), ('ay', GRAY)]:
    add(f'<marker id="{mid}" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0 0 L8 4.5 L0 9 z" fill="{c}"/></marker>')
add('</defs>')
add(f'<rect x="0" y="0" width="{W}" height="{H}" fill="#fbfbfd" stroke="#d7dae0" rx="8"/>')
add('<text x="30" y="40" font-size="20" font-weight="700" fill="#1a1d24">聚會紀錄系統 liming-meeting：資料流程</text>')
add('<text x="30" y="63" font-size="13" fill="#5c6270">兩個畫面：① 聚會紀錄網站（有日期的聚會紀錄）　② 查經邀請頁 study.liming-tjc.org　｜　藍＝聚會紀錄　綠＝查經　金＝AI　灰＝設定／暫存</text>')
add('<text x="30" y="86" font-size="13" font-weight="700" fill="#4a5164">怎麼看：</text>')
add('<text x="86" y="86" font-size="13" fill="#4a5164"><tspan font-weight="700">順著箭頭看</tspan>（左 → 右）：左邊的檔案、設定經過哪些處理，最後出現在哪個畫面</text>')
add('<text x="86" y="106" font-size="13" fill="#4a5164"><tspan font-weight="700">逆著箭頭看</tspan>（右 → 左）：畫面上某一項是從哪裡來的，不對時要去哪裡改</text>')

# 欄標題
AX, AW = 30, 260
BX, BW = 345, 375
CX, CW = 800, 270
DX, DW = 1170, 300
for x, t in [(AX, '來源'), (BX, '處理'), (CX, '資料'), (DX, '畫面（只讀，經由 Worker）')]:
    add(f'<text x="{x}" y="{TOP - 20}" font-size="14" font-weight="700" fill="#1a1d24">{escape(t)}</text>')

# A 欄：來源
y = TOP
A1y = y; A1h = box(AX, y, AW, '聚會錄音', ['Drive 聚會錄音資料夾', '同工上傳，檔名開頭要有日期', '例：2026-07-25 講題(講員).mp3'], BLUE); y += A1h + 18
A2y = y; A2h = box(AX, y, AW, '預查文件', ['Drive 預查資料夾 → 書卷子資料夾', '主領週三晚上上傳（Word／PDF／PPT）', '經 LINE 小幫手傳的檔名會變成', '　日期_時間_傳送者_原檔名'], GREEN); y += A2h + 18
A3y = y; A3h = box(AX, y, AW, '每月聚會安排表', ['Drive「05安排表」', '<民國年><月>聚會安排表.xlsx', '週三那列：進度、預查、領會'], GREEN); y += A3h + 18
A4y = y; A4h = box(AX, y, AW, '設定試算表（兩本）', ['查經聚會轉檔紀錄 › Config', '　Meet 連結、卡片文字、範本連結', 'LINE 小幫手那本 › Config', '　Gemini 指示、講員清單、略過關鍵字', '改完 1 分鐘生效，不用重新部署'], GRAY)

# B 欄：Worker
BY = TOP - 8
add(f'<rect x="{BX}" y="{BY}" width="{BW}" height="{TOP + 680 - BY}" fill="#f1f3f7" stroke="#b9c2d4" rx="8"/>')
add(f'<text x="{BX + 14}" y="{BY + 22}" font-size="14.5" font-weight="700" fill="#1a1d24">Cloudflare Worker：church-meeting-api</text>')
add(f'<text x="{BX + 14}" y="{BY + 42}" font-size="12" fill="#5c6270">排程每天 06:30 · 12:30 · 16:00 · 21:30，每次處理一份</text>')
IX, IW = BX + 15, BW - 30
y = BY + 58
B1y = y; B1h = box(IX, y, IW, '錄音轉檔', ['順序：手動排隊 → 重試（06:30、16:00）→ 新檔', '略過：婚禮、喪禮、詩班；>150MB 或 <1MB', '下載錄音 → Gemini 整理成', '　簡易重點／完整重點／參考經文', '寫進 Notion（草稿），失敗自動重試 3 次'], BLUE); y += B1h + 12
B2y = y; B2h = box(IX, y, IW, '預查轉檔', ['21:30 處理 14 天內上傳的；06:30 補轉 36 小時內的', '抽出純文字＋產生「完整文件」PDF', '日期：文件前 12 行 → 沒有就用上傳時間推算週三', '寫進 Notion（主題、講員從檔名解析）'], GREEN); y += B2h + 12
B3y = y; B3h = box(IX, y, IW, '抽問題討論（預查轉完接著做）', ['① 規則：取最後一段「問題討論／Q&A／心得分享…」', '② 規則抓不到才請 Gemini，只收原文找得到的題目', '討論日期 ＝ 文件日期 ＋ 7 天'], GREEN); y += B3h + 12
B4y = y; B4h = box(IX, y, IW, '安排表匯入', ['每週一重匯本月與下個週三的月份；缺月份隨時補', '只取週三那列原文，人工修正欄不覆蓋'], GREEN); y += B4h + 12
B5y = y; B5h = box(IX, y, IW, '網頁服務', ['提供兩個畫面的資料；邀請頁整頁在這裡產生'], GRAY)

# C 欄：資料
y = TOP
C0y = y; C0h = box(CX, y, CW, 'Gemini（Google AI）', ['整理錄音：設定檔的 GEMINI_MODEL', '　目前 gemini-flash-latest，每天次數有限', '抽問題討論（規則抓不到時）：', '　gemini-3.5-flash-lite，額度另計'], GOLD); y += C0h + 22
C1y = y; C1h = box(CX, y, CW, 'Notion「聚會紀錄」資料庫', ['唯一正本，也是後台', '聚會日期、類型、主題、講員', '內文：AI 整理或預查文字', '錄音、預查、完整文件連結', '✎ 人工校對、改日期、改講員', '✎ 狀態：草稿→已發布；傳錯→不採用'], DARK, bold_first=True); y += C1h + 18
C2y = y; C2h = box(CX, y, CW, '試算表「查經聚會轉檔紀錄」', ['安排表分頁：系統匯入', '　✎ 人工修正欄有填就用它', '問題討論分頁：討論日期、題目', '　✎ 可直接改題目、刪列、加列'], DARK); y += C2h + 18
C3y = y; C3h = box(CX, y, CW, 'KV（暫存）', ['轉錄排隊：聚會頁按「加入轉錄排隊」', '　寫入，下一輪排程處理', '行事曆快取、安排表備份'], GRAY); y += C3h + 18
C4y = y; C4h = box(CX, y, CW, '心得回饋（另一本試算表，GAS）', ['聚會頁「心得回饋」的留言'], GRAY)

# D 欄：畫面
D1y = TOP
D1h = box(DX, D1y, DW, '① 聚會紀錄網站', ['tjc-km.github.io/liming-meeting', '行事曆（日／週／月）', '　Notion 紀錄＋Drive 還沒轉的檔', '聚會頁', '　AI 整理（每次先顯示聲明）', '　錄音播放、完整文件', '　當晚查經進度 ← 安排表分頁', '　心得回饋；按鈕：轉錄排隊、重試', '讀者：弟兄姊妹（可切大字版）'], BLUE)
D2y = D1y + D1h + 44
D2h = box(DX, D2y, DW, '② 查經邀請頁', ['study.liming-tjc.org（每週貼同一個連結）', '日期：自動算接下來的週三', '加入 Google Meet ← Config', '本週進度・領會 ← 安排表分頁', '預查提供的問題討論 ← 問題討論分頁', '上週預查文件 ← Notion', '　13 天內最近一筆，跳過「不採用」', '純文字大字版 → 聚會頁', 'LINE 卡片、預查範本 ← Config', '讀者：LINE 群組裡點連結的人'], GREEN)

def mid(y, h): return y + h // 2

# A → B
arrow([(AX + AW, A1y + 75), (IX, A1y + 75)], BLUE)
arrow([(AX + AW, A2y + 75), (IX, A2y + 75)], GREEN)
a3y = mid(A3y, A3h); b4y = mid(B4y, B4h)
arrow([(AX + AW, a3y), (318, a3y), (318, b4y), (IX, b4y)], GREEN)
a4y = A4y + A4h - 18
arrow([(AX + AW, a4y), (BX, a4y)], GRAY, label='設定', lx=314, ly=a4y + 16)

# B → C
arrow([(IX + IW, B1y + 52), (CX, B1y + 52)], GOLD, label='整理錄音', lx=(IX + IW + CX) // 2, ly=B1y + 46)
arrow([(IX + IW, C1y + 40), (CX, C1y + 40)], BLUE, label='寫紀錄', lx=(IX + IW + CX) // 2, ly=C1y + 34)
arrow([(IX + IW, B2y + 70), (CX, B2y + 70)], GREEN, label='寫紀錄', lx=(IX + IW + CX) // 2, ly=B2y + 64)
arrow([(IX + IW, mid(B3y, B3h)), (CX, mid(B3y, B3h))], GREEN, label='題目', lx=(IX + IW + CX) // 2, ly=mid(B3y, B3h) - 6)
arrow([(IX + IW, B4y + 22), (CX, C2y + C2h - 22)], GREEN, label='進度', lx=(IX + IW + CX) // 2 + 6, ly=B4y + 6)
arrow([(IX + IW, B4y + B4h - 18), (CX, C3y + 40)], GRAY, dashed=True, label='備份', lx=(IX + IW + CX) // 2, ly=B4y + B4h - 4)

# C → D：三條水平線，各標傳的是什麼
gx = (CX + CW + DX) // 2
y1 = C1y + 30
arrow([(CX + CW, y1), (DX, y1)], BLUE, label='紀錄、內文', lx=gx, ly=y1 - 6)
y2 = C1y + C1h - 22
arrow([(CX + CW, y2), (DX, y2)], GREEN, label='上週預查文件', lx=gx, ly=y2 - 6)
y3 = C2y + 50
arrow([(CX + CW, y3), (DX, y3)], GREEN, label='進度、題目', lx=gx, ly=y3 - 6)
# 邀請頁 → 聚會頁（大字版）
arrow([(DX + DW - 40, D2y), (DX + DW - 40, D1y + D1h)], GREEN, dashed=True, label='純文字大字版', lx=DX + DW - 46, ly=D2y - 14, anchor='end')

# 圖例
ly = H - 32
add(f'<text x="30" y="{ly}" font-size="12" fill="#5c6270">實線＝系統自動流動　虛線＝人按按鈕、備份或連結　✎＝管理同工可以直接改的地方　機敏值（試算表／資料夾 ID、金鑰）不在圖上，見 wrangler.toml 與 Cloudflare secrets</text>')
add('</svg>')
open(OUT, 'w', encoding='utf-8').write('\n'.join(parts) + '\n')
print('wrote', OUT)
