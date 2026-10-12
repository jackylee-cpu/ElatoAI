# -*- coding: utf-8 -*-
import html, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from plan import *

e = html.escape
TL = dict(TRACKS)
OUT = os.path.join(os.path.dirname(__file__), "roadmap.html")

CSS = r"""
:root {
  /* Layout: a production calendar. Dated milestone strip, a 16-week Gantt, then one sheet per week with a lane per track. */
  --bg: #f3f4f6;
  --surface: #ffffff;
  --ink: #17202b;
  --muted: #5b6474;
  --rule: #dce0e7;
  --soft: #eceef2;
  --toy: #b4650f;  --toy-soft: #f6e8d6;
  --fw: #0e7a71;   --fw-soft: #d9efeb;
  --plat: #2a5fc4; --plat-soft: #e0e8f8;
  --app: #8340b5;  --app-soft: #efe3f7;
  --comp: #b8384f; --comp-soft: #f8e0e5;
  --hi: #b8384f; --mid: #a86a12;
  --now: #fff4c9;
  --hatch: rgba(23,32,43,.06);
  --display: "Noto Serif HK", "Songti TC", "PMingLiU", serif;
  --body: "Noto Sans HK", "PingFang HK", "Microsoft JhengHei", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0f131a; --surface: #161b24; --ink: #e6e9ef; --muted: #9ba3b1; --rule: #2a3140; --soft: #1e2430;
    --toy: #e8a456; --toy-soft: #3a2914; --fw: #4ec3b7; --fw-soft: #11302c;
    --plat: #84a6ff; --plat-soft: #1a2746; --app: #c79cf2; --app-soft: #2c1f40;
    --comp: #f28aa0; --comp-soft: #3b1a23; --hi: #f28aa0; --mid: #e8a456;
    --now: #3a3418; --hatch: rgba(230,233,239,.06);
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #0f131a; --surface: #161b24; --ink: #e6e9ef; --muted: #9ba3b1; --rule: #2a3140; --soft: #1e2430;
  --toy: #e8a456; --toy-soft: #3a2914; --fw: #4ec3b7; --fw-soft: #11302c;
  --plat: #84a6ff; --plat-soft: #1a2746; --app: #c79cf2; --app-soft: #2c1f40;
  --comp: #f28aa0; --comp-soft: #3b1a23; --hi: #f28aa0; --mid: #e8a456;
  --now: #3a3418; --hatch: rgba(230,233,239,.06);
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--ink); font-family: var(--body); font-size: 15px; line-height: 1.65; }
.wrap { max-width: 1180px; margin: 0 auto; padding-inline: 20px; padding-block: 36px 72px; display: grid; gap: 56px; }
h1, h2, h3 { font-family: var(--display); text-wrap: balance; margin: 0; line-height: 1.25; }
h1 { font-size: clamp(28px, 4.2vw, 42px); font-weight: 800; letter-spacing: .01em; }
h2 { font-size: 24px; font-weight: 700; }
h3 { font-size: 17px; font-weight: 700; }
p { margin: 0; }
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.eyebrow { font-family: var(--mono); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
.lede { color: var(--muted); max-width: 62ch; font-size: 16px; }
section { display: grid; gap: 18px; min-width: 0; }
.sechead { display: grid; gap: 6px; }

/* header */
header { display: grid; gap: 14px; }
.meta { display: flex; flex-wrap: wrap; gap: 8px 18px; color: var(--muted); font-size: 13px; }
.meta b { color: var(--ink); font-weight: 600; }

/* milestones */
.ms { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0; border-top: 2px solid var(--ink); }
.ms > div { padding: 12px 14px 4px 0; display: grid; gap: 2px; align-content: start; border-right: 1px solid var(--rule); padding-left: 14px; }
.ms > div:first-child { padding-left: 0; }
.ms > div:last-child { border-right: 0; }
.ms .d { font-family: var(--mono); font-size: 22px; font-weight: 500; font-variant-numeric: tabular-nums; }
.ms .wk { font-family: var(--mono); font-size: 11px; color: var(--muted); letter-spacing: .08em; }
.ms .l { font-size: 14px; font-weight: 600; line-height: 1.4; }
.ms .l2 { font-size: 13px; color: var(--muted); line-height: 1.4; }
.ms .final .d { color: var(--hi); }

/* critical path */
.cp { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
.cp > div { background: var(--surface); border: 1px solid var(--rule); border-radius: 6px; padding: 16px 18px; display: grid; gap: 8px; align-content: start; min-width: 0; }
.cp .chain { font-size: 14px; line-height: 1.9; }
.cp .chain span { white-space: nowrap; }
.cp .chain i { font-style: normal; color: var(--muted); padding: 0 4px; }
.cp p { font-size: 14px; color: var(--muted); }

/* legend + chips */
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: var(--muted); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.sw { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }

/* gantt */
.gx { overflow-x: auto; background: var(--surface); border: 1px solid var(--rule); border-radius: 6px; }
.g { display: grid; grid-template-columns: 190px repeat(16, minmax(46px, 1fr)); min-width: 980px; font-size: 13px; position: relative; }
.g .h { padding: 8px 4px 6px; text-align: center; border-bottom: 1px solid var(--rule); font-family: var(--mono); font-variant-numeric: tabular-nums; }
.g .h b { display: block; font-weight: 500; font-size: 12px; }
.g .h small { display: block; color: var(--muted); font-size: 10px; line-height: 1.3; }
.g .corner { border-bottom: 1px solid var(--rule); padding: 8px 12px; color: var(--muted); font-size: 12px; display: flex; align-items: end; }
.g .col { grid-row: 1 / -1; pointer-events: none; border-left: 1px solid var(--soft); }
.g .col.now { background: var(--now); }
.g .col.hol { background-image: repeating-linear-gradient(135deg, var(--hatch) 0 6px, transparent 6px 12px); }
.g .trk { grid-column: 1 / -1; padding: 10px 12px 2px; font-weight: 700; font-size: 13px; display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--rule); position: relative; z-index: 1; }
.g .lab { padding: 2px 12px; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; position: relative; z-index: 1; line-height: 22px; }
.g .bar { height: 14px; align-self: center; border-radius: 3px; margin: 0 3px; position: relative; z-index: 1; }
.g .bar.one { margin: 0 10px; }
.g .msrow { grid-column: 2 / -1; height: 0; }
.g .mk { align-self: center; justify-self: end; width: 11px; height: 11px; transform: rotate(45deg) translateX(-2px); background: var(--ink); position: relative; z-index: 2; margin-right: 2px; }
.g .mklab { font-family: var(--mono); font-size: 10px; color: var(--muted); text-align: right; padding-right: 4px; position: relative; z-index: 1; white-space: nowrap; }
.t-toy { background: var(--toy); } .t-fw { background: var(--fw); } .t-plat { background: var(--plat); } .t-app { background: var(--app); } .t-comp { background: var(--comp); }
.gnote { font-size: 12px; color: var(--muted); }

/* filter */
.filters { display: flex; flex-wrap: wrap; gap: 8px; position: sticky; top: env(safe-area-inset-top, 0px); background: var(--bg); padding-block: 10px; z-index: 5; }
.chip { font: inherit; font-size: 13px; border: 1px solid var(--rule); background: var(--surface); color: var(--ink); border-radius: 999px; padding: 5px 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.chip:hover { border-color: var(--muted); }
.chip[aria-pressed="true"] { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.chip:focus-visible, button:focus-visible { outline: 2px solid var(--plat); outline-offset: 2px; }

/* weeks */
.weeks { display: grid; gap: 14px; }
.week { background: var(--surface); border: 1px solid var(--rule); border-radius: 6px; display: grid; grid-template-columns: 150px 1fr; min-width: 0; }
.week.now { border-color: var(--ink); box-shadow: 0 0 0 1px var(--ink); }
.wh { padding: 16px 16px; border-right: 1px solid var(--rule); display: grid; gap: 4px; align-content: start; }
.wh .wn { font-family: var(--mono); font-size: 28px; font-weight: 500; line-height: 1; }
.wh .wd { font-family: var(--mono); font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
.wh .tag { justify-self: start; font-size: 11px; padding: 1px 8px; border-radius: 999px; background: var(--now); color: var(--ink); margin-top: 6px; font-weight: 600; }
.wh .hol { font-size: 12px; color: var(--muted); margin-top: 6px; }
.wb { padding: 14px 18px 16px; display: grid; gap: 12px; min-width: 0; }
.gates { display: flex; flex-wrap: wrap; gap: 6px; }
.gate { font-size: 13px; font-weight: 600; border: 1.5px solid var(--ink); border-radius: 4px; padding: 1px 9px; display: inline-flex; align-items: center; gap: 7px; }
.gate::before { content: ""; width: 7px; height: 7px; background: var(--ink); transform: rotate(45deg); display: inline-block; }
.lanes { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 12px 22px; }
.lane { min-width: 0; display: grid; gap: 4px; align-content: start; }
.lane h4 { margin: 0; font-size: 12px; font-weight: 700; letter-spacing: .04em; display: flex; align-items: center; gap: 6px; }
.lane ul { margin: 0; padding-left: 18px; display: grid; gap: 3px; font-size: 14px; line-height: 1.6; }
.lane li::marker { color: var(--muted); }
.lane li.f { }
.ftag { font-family: var(--mono); font-size: 10px; border: 1px solid var(--toy); color: var(--toy); border-radius: 3px; padding: 0 4px; margin-left: 4px; vertical-align: 1px; white-space: nowrap; }
.c-toy { color: var(--toy); } .c-fw { color: var(--fw); } .c-plat { color: var(--plat); } .c-app { color: var(--app); } .c-comp { color: var(--comp); }
.empty { color: var(--muted); font-size: 14px; }

/* architecture */
.arch { display: grid; gap: 10px; }
.layer { border: 1px solid var(--rule); background: var(--surface); border-radius: 6px; padding: 14px 16px; display: grid; gap: 10px; min-width: 0; }
.layer .lt { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.layer .lt h3 { font-size: 16px; }
.layer .lt span { font-size: 13px; color: var(--muted); }
.shells { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
.shell { border: 1px dashed var(--rule); border-radius: 5px; padding: 10px 12px; font-size: 13px; display: grid; gap: 4px; background: var(--bg); }
.shell b { font-size: 14px; }
.shell .sub { color: var(--muted); }
.down { text-align: center; color: var(--muted); font-family: var(--mono); font-size: 12px; line-height: 1; }
.pillrow { display: flex; flex-wrap: wrap; gap: 6px; }
.pill { font-size: 12.5px; background: var(--soft); border-radius: 4px; padding: 2px 8px; }
.dec { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px 28px; }
.dec > div { display: grid; gap: 4px; align-content: start; min-width: 0; }
.dec h3 { font-size: 15px; font-family: var(--body); }
.dec p { font-size: 14px; color: var(--muted); }
.rules { width: 100%; border-collapse: collapse; font-size: 14px; }
.rules th, .rules td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--rule); vertical-align: top; }
.rules th { font-size: 12px; color: var(--muted); font-weight: 600; }
.rules td:first-child { font-family: var(--mono); white-space: nowrap; font-size: 13px; }
.tx { overflow-x: auto; background: var(--surface); border: 1px solid var(--rule); border-radius: 6px; }

/* risks */
.risks { display: grid; gap: 0; background: var(--surface); border: 1px solid var(--rule); border-radius: 6px; }
.risk { display: grid; grid-template-columns: 44px 200px 1fr; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--rule); align-items: baseline; }
.risk:last-child { border-bottom: 0; }
.sev { font-size: 12px; font-weight: 700; border-radius: 3px; padding: 0 6px; justify-self: start; }
.sev.hi { color: var(--hi); border: 1px solid var(--hi); }
.sev.mid { color: var(--mid); border: 1px solid var(--mid); }
.risk b { font-size: 14px; }
.risk p { font-size: 14px; color: var(--muted); }

.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 28px; }
ol.q, ul.as { margin: 0; padding-left: 22px; display: grid; gap: 8px; font-size: 14.5px; }
ol.q li::marker { font-family: var(--mono); color: var(--muted); }
footer { font-size: 12px; color: var(--muted); border-top: 1px solid var(--rule); padding-top: 14px; }

@media (max-width: 720px) {
  .week { grid-template-columns: 1fr; }
  .wh { border-right: 0; border-bottom: 1px solid var(--rule); grid-auto-flow: column; justify-content: start; align-items: baseline; gap: 10px; }
  .wh .tag, .wh .hol { margin-top: 0; }
  .risk { grid-template-columns: 40px 1fr; }
  .risk p { grid-column: 2; }
  .ms > div { border-right: 0; padding-left: 0; border-bottom: 1px solid var(--rule); padding-bottom: 10px; }
}
@media (prefers-reduced-motion: no-preference) { .chip { transition: background .15s, color .15s; } }
"""

def bar_rows():
    out = []
    # week header row
    out.append('<div class="corner">工作項</div>')
    for w in range(1, 17):
        out.append(f'<div class="h" style="grid-column:{w+1};grid-row:1"><b>W{w}</b><small>{e(DATES[w].split("–")[0])}</small></div>')
    row = 2
    # milestone row
    out.append(f'<div class="lab" style="grid-column:1;grid-row:{row};color:var(--muted);font-size:12px">關卡</div>')
    for w, d, a, b in MILESTONES:
        out.append(f'<div class="mk" style="grid-column:{w+1};grid-row:{row}" title="{e(d)} {e(a)} {e(b)}"></div>')
    row += 1
    out.append(f'<div style="grid-column:1;grid-row:{row}"></div>')
    for w, d, a, b in MILESTONES:
        out.append(f'<div class="mklab" style="grid-column:{w+1};grid-row:{row}">{e(d)}</div>')
    row += 1
    for key, name in TRACKS:
        out.append(f'<div class="trk" style="grid-row:{row}"><span class="sw t-{key}"></span>{e(name)}</div>')
        row += 1
        for t, label, s, f in BARS:
            if t != key:
                continue
            one = " one" if s == f else ""
            out.append(f'<div class="lab" style="grid-column:1;grid-row:{row}" title="{e(label)}">{e(label)}</div>')
            out.append(f'<div class="bar t-{key}{one}" style="grid-column:{s+1}/{f+2};grid-row:{row}" title="{e(label)}：W{s}–W{f}"></div>')
            row += 1
    cols = []
    for w in range(1, 17):
        cls = "col"
        if w == 1: cls += " now"
        if w in (11, 12): cls += " hol"
        cols.append(f'<div class="{cls}" style="grid-column:{w+1};grid-row:1/{row}"></div>')
    return "".join(cols) + "".join(out)


def week_html(wk):
    wn = wk["w"]
    is_now = wk.get("now")
    parts = [f'<article class="week{" now" if is_now else ""}" data-week="{wn}">']
    parts.append('<div class="wh">')
    parts.append(f'<div class="wn">W{e(str(wn))}</div><div class="wd">{e(wk["dates"])}</div>')
    if is_now:
        parts.append('<div class="tag">本週</div>')
    if wk.get("holiday"):
        parts.append(f'<div class="hol">{e(wk["holiday"])}</div>')
    parts.append('</div><div class="wb">')
    if wk.get("gates"):
        parts.append('<div class="gates">' + "".join(f'<span class="gate">{e(g)}</span>' for g in wk["gates"]) + '</div>')
    parts.append('<div class="lanes">')
    for key, name in TRACKS:
        items = wk.get(key) or []
        if not items:
            continue
        lis = []
        for it in items:
            f = it.startswith("F|")
            txt = it[2:] if f else it
            attr = ' class="f" data-f="1"' if f else ""
            tag = '<span class="ftag">工廠</span>' if f else ""
            lis.append(f'<li{attr}>{e(txt)}{tag}</li>')
        parts.append(f'<div class="lane" data-track="{key}"><h4 class="c-{key}"><span class="sw t-{key}"></span>{e(name)}</h4><ul>{"".join(lis)}</ul></div>')
    parts.append('</div></div></article>')
    return "".join(parts)


ARCH = """
<div class="arch">
  <div class="layer">
    <div class="lt"><h3>原生殼</h3><span>同事負責。建議一個專案、三個 build flavor；每個品牌各自的名稱、圖示、bundle id、開發者帳號</span></div>
    <div class="shells">
      <div class="shell"><b>品牌 A · 馬會快活</b><span class="sub">成人會員；粵／普／英 · 賽馬日版、新春版共 2,500 隻</span></div>
      <div class="shell"><b>品牌 B · 政協青年聯會版</b><span class="sub">成人會員 · 500 隻</span></div>
      <div class="shell"><b>品牌 C · AI Buddy</b><span class="sub">兒童陪伴（3–6 歲）· 自有 IP · 數量未定 · 用我們自己的開發者帳號</span></div>
    </div>
    <div class="pillrow"><span class="pill">配網：加入 AIBuddy-XXXX 熱點</span><span class="pill">推送通知</span><span class="pill">麥克風權限</span><span class="pill">原生 Google／Apple 登入 → signInWithIdToken</span><span class="pill">App 內刪除帳號</span><span class="pill">深層連結</span></div>
  </div>
  <div class="down">▼ 每個殼打開自己品牌的網址</div>
  <div class="layer">
    <div class="lt"><h3>網頁（現有 Next.js，一套）</h3><span>按網址判斷品牌，載入該品牌的設定</span></div>
    <div class="pillrow"><span class="pill">主題 token：顏色、字體、圓角、圖示</span><span class="pill">文案與語言</span><span class="pill">功能開關</span><span class="pill">少數頁面的品牌版本：首頁、上手流程、角色頁</span></div>
  </div>
  <div class="down">▼ 同一個後端</div>
  <div class="layer">
    <div class="lt"><h3>共用平台</h3><span>新增 brands 表；設備出廠時寫入 brand_key</span></div>
    <div class="pillrow"><span class="pill">Supabase：帳號、資料、RLS 按品牌分開</span><span class="pill">語音伺服器（pipecat）</span><span class="pill">IP Pack：角色、聲線、安全規則</span><span class="pill">OTA</span><span class="pill">管理後台</span></div>
  </div>
</div>
"""

DECISIONS = [
    ("一套程式碼，三份品牌設定", "不做三份程式碼。品牌之間的差別放在設定裡：主題 token、文案、功能開關、允許的 IP，再加上少數幾頁的品牌版本。修一個 bug，三個 App 一起修好。"),
    ("「不同 UI」做到哪一層", "顏色、字體、圖示、插畫、文案全部可換。版面只有首頁、上手流程、角色頁按品牌各寫一版，其餘頁面共用。如果某個客戶要完全不同的流程，再按頁加品牌版本。"),
    ("品牌從設備來", "設備出廠時寫入 brand_key。一個品牌的 App 只能認領自己品牌的設備；快活的設備鎖定快活 IP（多 IP 設計第一期跳過的「固定 IP」要補上）。"),
    ("帳號共用，資料按品牌分開", "Supabase 只有一個帳號池。同一個人如果有兩個品牌的玩具，用同一個 email 登入，每個 App 只顯示自己品牌的設備和記憶。"),
    ("各品牌的安全規則不同", "AI Buddy 兒童版用 3–6 歲尺度，並有家長鎖、家長同意、每日上限。快活和政協青年聯會版是成人：會員本人同意，記憶過濾敏感號碼；快活另外不提供貼士、只按知識庫回答。資料保留期按品牌設定（提案寫明「資料規則由馬會話事」）。"),
    ("網頁和殼之間有一份橋接清單", "殼由同事做，我們不控制殼的程式碼。網頁需要殼提供的能力（配網、原生登入、推送、麥克風、刪除帳號入口）寫成一份清單和 JS 介面，雙方按清單開發，三個品牌共用同一份。"),
    ("殼過審之後，介面隨時可改", "畫面在網頁裡，改介面不用重新送審。所以殼 1.0 在 12/11 前過審就行，網頁可以一直改到交付。"),
]

RULES = [
    ("Apple 4.2", "最低功能", "純網頁殼會被拒。殼要有原生功能：配網、推送。"),
    ("Apple 4.2.6、4.3", "模板 App", "同一套模板做的 App，要由各品牌用自己的開發者帳號上架。AI Buddy 是我們自己的品牌，用我們的帳號；馬會和政協青年聯會要用他們自己的。"),
    ("Apple 4.8", "登入", "有 Google 登入，就要同時提供一個同等的私隱登入，最簡單是 Sign in with Apple。另外 Google 不讓 WebView 內做 OAuth，所以社交登入要在殼裡原生完成。"),
    ("Apple 5.1.1(v)", "刪除帳號", "能在 App 內註冊，就要能在 App 內刪除帳號。"),
    ("Apple 1.3", "兒童分類", "兒童版是家長用的 App，不要放進 Kids 分類；私隱標籤照實填寫。"),
    ("Google Play", "機構帳號", "機構帳號要 D-U-N-S。新的個人帳號要 12 人封閉測試 14 天，用機構帳號就不用。"),
]


def build():
    ms = []
    for w, d, a, b in MILESTONES:
        final = " final" if d == "1/15" else ""
        ms.append(f'<div class="{final.strip()}"><span class="wk">W{w}</span><span class="d">{e(d)}</span><span class="l">{e(a)}</span>{f"<span class=l2>{e(b)}</span>" if b else ""}</div>')

    legend = "".join(f'<span><i class="sw t-{k}"></i>{e(n)}</span>' for k, n in TRACKS)
    legend += '<span><i class="sw" style="background:var(--now);border:1px solid var(--rule)"></i>本週</span>'
    legend += '<span><i class="sw" style="background-image:repeating-linear-gradient(135deg,var(--muted) 0 2px,transparent 2px 5px)"></i>假期週</span>'

    chips = ['<button class="chip" id="f-all" data-filter="all" aria-pressed="true">全部</button>']
    for k, n in TRACKS:
        chips.append(f'<button class="chip" id="f-{k}" data-filter="{k}" aria-pressed="false"><span class="sw t-{k}"></span>{e(n)}</button>')
    chips.append('<button class="chip" id="f-factory" data-filter="factory" aria-pressed="false">只看工廠要知道的</button>')

    risks = "".join(
        f'<div class="risk"><span class="sev {"hi" if s=="高" else "mid"}">{e(s)}</span><b>{e(t)}</b><p>{e(d)}</p></div>'
        for s, t, d in RISKS)
    decs = "".join(f'<div><h3>{e(t)}</h3><p>{e(d)}</p></div>' for t, d in DECISIONS)
    rules = "".join(f'<tr><td>{e(a)}</td><td>{e(b)}</td><td>{e(c)}</td></tr>' for a, b, c in RULES)
    qs = "".join(f'<li>{e(q)}</li>' for q in QUESTIONS)
    asm = "".join(f'<li>{e(a)}</li>' for a in ASSUMPTIONS)

    page = f"""<title>AI Buddy 量產時間表</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Noto+Sans+HK:wght@400;500;700&family=Noto+Serif+HK:wght@700;800&display=swap">
<style>{CSS}</style>
<div class="wrap">
<header>
  <span class="eyebrow">AI Buddy · 馬會快活、政協青年聯會版、AI Buddy 自有 IP</span>
  <h1>1 月 15 日量產出廠：14 週時間表</h1>
  <p class="lede">兩條線同步進行：玩具打版和量產（Spotpear 板、毛公仔、機芯盒），以及軟件平台和三個品牌 App。以下按週列出每條線要做的事，和每個關卡要決定的事。</p>
  <div class="meta"><span><b>{e(VERSION)}</b></span><span>W1 = 10/12 起的一週</span><span>1/15 出廠，1/29 前送達</span><span>任務編號對應 production-readiness.xlsx</span></div>
</header>

<section aria-labelledby="s-ms">
  <div class="sechead"><span class="eyebrow">關卡</span><h2 id="s-ms">七個日期</h2></div>
  <div class="ms">{"".join(ms)}</div>
</section>

<section aria-labelledby="s-cp">
  <div class="sechead"><span class="eyebrow">關鍵路徑</span><h2 id="s-cp">決定 1/15 能否出廠的三條線</h2></div>
  <div class="cp">
    <div><h3 class="c-toy">毛公仔</h3>
      <div class="chain"><span>外觀簽樣 11/13</span><i>→</i><span>訂面料 2–3 週</span><i>→</i><span>PP 樣 11/27</span><i>→</i><span>試產 12/7</span><i>→</i><span>大貨 12/14–12/31</span><i>→</i><span>緩衝 1/4–1/8</span><i>→</i><span>出廠 1/15</span></div>
      <p>任何一個品牌在 11/13 前未簽外觀，該品牌就趕不上 1/15。</p></div>
    <div><h3 class="c-toy">量產板</h3>
      <div class="chain"><span>R-17 結論 10/23</span><i>→</i><span>定板 10/30</span><i>→</i><span>落單 3,000 台 11/6</span><i>→</i><span>到廠 12/4</span></div>
      <p>A、B 的數量已定，C 未定就先不計，談好加單交期。要改板的話，到貨會推到 W9–W10。</p></div>
    <div><h3 class="c-app">軟件</h3>
      <div class="chain"><span>分區表和加密凍結 11/13</span><i>→</i><span>韌體定版 12/11</span><i>→</i><span>App 殼過審 12/11</span></div>
      <p>出廠後韌體可以 OTA、介面可以改網頁，所以軟件只有這三項會卡住出廠。其餘功能可以在交付前繼續做。</p></div>
  </div>
</section>

<section aria-labelledby="s-g">
  <div class="sechead"><span class="eyebrow">總覽</span><h2 id="s-g">16 週甘特圖</h2></div>
  <div class="legend">{legend}</div>
  <div class="gx"><div class="g">{bar_rows()}</div></div>
  <p class="gnote">W15–W16 是運送和簽收。窄螢幕可以左右捲動。</p>
</section>

<section aria-labelledby="s-w">
  <div class="sechead"><span class="eyebrow">每週計劃</span><h2 id="s-w">每週做什麼</h2>
    <p class="lede">標了「工廠」的項目，就是給玩具廠那份 Excel 的內容。</p></div>
  <div class="filters" role="toolbar" aria-label="篩選工作線">{"".join(chips)}</div>
  <div class="weeks" id="weeks">{"".join(week_html(w) for w in WEEKS)}</div>
  <p class="empty" id="noitems" hidden>這條線沒有項目。</p>
</section>

<section aria-labelledby="s-a">
  <div class="sechead"><span class="eyebrow">討論</span><h2 id="s-a">三個 App 的架構</h2>
    <p class="lede">建議做法：一套網頁、一個原生殼專案，三個品牌只是三份設定。三個客戶看到的是三個不同的 App，後面全部共用。</p></div>
  {ARCH}
  <div class="dec">{decs}</div>
  <h3>上架規則：會影響架構和時間的幾條</h3>
  <div class="tx"><table class="rules"><thead><tr><th>規則</th><th>內容</th><th>對我們的影響</th></tr></thead><tbody>{rules}</tbody></table></div>
</section>

<section aria-labelledby="s-burn">
  <div class="sechead"><span class="eyebrow">已定 · 10/12</span><h2 id="s-burn">燒錄和出廠自檢</h2>
    <p class="lede">分兩步做。Spotpear 出貨前燒一個所有品牌共用、不含密鑰的出廠韌體；到玩具廠裝機芯盒的工位，再用我們提供的電腦和腳本做每台設備的步驟。</p></div>
  <div class="dec">
    <div><h3>Spotpear：燒共用韌體</h3><p>他們出貨前本來就要燒小智韌體，換成我們的映像不增加工序。映像不含密鑰，也不分品牌，交給供應商沒有洩漏風險。出貨附每片的 MAC 清單，伺服器可以先登記為白名單。</p></div>
    <div><h3>玩具廠工位：每台設備的步驟</h3><p>經序列埠寫入設備密鑰、選品牌和款式、自檢（喇叭、麥克風、按鍵、燈、Wi-Fi、電池），再經 HTTPS 登記到伺服器。每台約 1.5 分鐘，3,000 台分 15 個工作天，2 個工位很寬鬆。品牌和款式按工單選，所以快活兩款的數量可以晚一點才定。</p></div>
    <div><h3>要注意的一點</h3><p>Spotpear 出貨測試時第一次通電，就會開啟 Secure Boot 和 Flash 加密，之後 bootloader 和分區表都不能改。所以 11/27 交給 Spotpear 的映像必須是最終版；app 部分之後經 OTA 更新，用戶第一次連網就升級。</p></div>
  </div>
</section>

<section aria-labelledby="s-r">
  <div class="sechead"><span class="eyebrow">風險</span><h2 id="s-r">會讓 1/15 出不了廠的事</h2></div>
  <div class="risks">{risks}</div>
</section>

<section aria-labelledby="s-q">
  <div class="two">
    <div style="display:grid;gap:12px;align-content:start"><span class="eyebrow">待確認</span><h2 id="s-q">要你決定的問題</h2><ol class="q">{qs}</ol></div>
    <div style="display:grid;gap:12px;align-content:start"><span class="eyebrow">假設</span><h2>這版時間表的前提</h2><ul class="as">{asm}</ul></div>
  </div>
</section>

<footer>{e(VERSION)}。數量、品牌和燒錄地點確定後會更新。</footer>
</div>
<script>
(function () {{
  var chips = document.querySelectorAll('.chip');
  var weeks = document.querySelectorAll('.week');
  var none = document.getElementById('noitems');
  function apply(f) {{
    var anyWeek = false;
    weeks.forEach(function (w) {{
      var lanes = w.querySelectorAll('.lane');
      var shown = 0;
      lanes.forEach(function (l) {{
        var lis = l.querySelectorAll('li');
        var vis = 0;
        lis.forEach(function (li) {{
          var ok = f === 'all' || f === l.dataset.track || (f === 'factory' && li.dataset.f === '1');
          li.hidden = !ok; if (ok) vis++;
        }});
        l.hidden = vis === 0; if (vis) shown++;
      }});
      var g = w.querySelector('.gates');
      if (g) g.hidden = !(f === 'all' || f === 'factory');
      w.hidden = shown === 0;
      if (shown) anyWeek = true;
    }});
    none.hidden = anyWeek;
    chips.forEach(function (c) {{ c.setAttribute('aria-pressed', c.dataset.filter === f ? 'true' : 'false'); }});
    try {{ localStorage.setItem('tl-filter', f); }} catch (e) {{}}
  }}
  chips.forEach(function (c) {{ c.addEventListener('click', function () {{ apply(c.dataset.filter); }}); }});
  var saved = null;
  try {{ saved = localStorage.getItem('tl-filter'); }} catch (e) {{}}
  if (saved && document.querySelector('.chip[data-filter="' + saved + '"]')) apply(saved);
}})();
</script>
"""
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(page)
    print(OUT, len(page))

if __name__ == "__main__":
    build()
