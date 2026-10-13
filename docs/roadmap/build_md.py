# -*- coding: utf-8 -*-
"""Render docs/roadmap.md from plan.py (the version other sessions read)."""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from plan import *
from build_html import DECISIONS, RULES

OUT = os.path.join(HERE, "..", "roadmap.md")
ARTIFACT = "https://claude.ai/artifact/YAnTFphfm5YGNokm2JZZM9"
TL = dict(TRACKS)


def cell(s):
    return str(s).replace("|", "／").replace("\n", " ")


def build(xlsx_name):
    L = []
    a = L.append
    a("# AI Buddy 項目路線圖：2027-01-15 量產出廠")
    a("")
    a(f"> {VERSION}。**本檔由 `docs/roadmap/plan.py` 生成，請不要直接改。** 要改內容就改 plan.py，再執行 "
      "`python3 docs/roadmap/build.py`，會同時更新本檔、網頁版 `docs/roadmap/roadmap.html` 和給玩具廠的 Excel。")
    a(f"> 網頁版已發佈為 {ARTIFACT}（私人）。更新後用 Artifact 工具把 roadmap.html 以這個 url 重新發佈。")
    a("> 三份文件的分工：本檔是計劃；`docs/project-schedule.xlsx` 每週一個里程碑，用來跟進時間；"
      "任務細項和測試記錄在 `docs/production-readiness.xlsx`（prod-readiness skill），本檔的任務編號（P0-12、R-07…）對應那張表。")
    a("")
    a("## 概要")
    a("")
    a("1/15 量產完成出廠，1/29 前送到客戶手上（農曆新年 2/6 前）。由 2026-10-12 起共 14 週，W1 = 10/12–10/16。"
      "兩條線同步：玩具打版和量產（Spotpear 板、毛公仔、機芯盒），以及軟件平台和三個品牌 App。")
    a("")
    a("決定能否準時出廠的是毛公仔和板子，不是軟件。出廠後韌體可以 OTA、App 介面是網頁可以隨時改，"
      "所以軟件只有三項會卡出廠：分區表和加密 11/13 凍結、共用出廠韌體 11/27 交 Spotpear、App 殼 12/11 前過審。")
    a("")
    a("## 三個品牌")
    a("")
    a("| 品牌 | 名稱 | 用戶 | 首批數量 | App 上架帳號 | 內容規則 |")
    a("|---|---|---|---|---|---|")
    for b in BRANDS:
        a("| " + " | ".join(cell(x) for x in b) + " |")
    a("")
    a("## 關鍵日期")
    a("")
    a("| 週 | 日期 | 關卡 |")
    a("|---|---|---|")
    for w, d, x, y in MILESTONES:
        a(f"| W{w} | {d} | {cell('；'.join(t for t in (x, y) if t))} |")
    a("")
    a("## 關鍵路徑")
    a("")
    a("- **毛公仔**：外觀簽樣 11/13 → 訂面料 2–3 週 → PP 樣 11/27 → 試產 12/7 → 大貨 12/14–12/31 → 緩衝 1/4–1/8 → 出廠 1/15。"
      "任何一個品牌 11/13 前未簽外觀，該品牌就趕不上 1/15。")
    a("- **量產板**：R-17 結論 10/23 → 定板 10/30 → 落單 3,000 台加備品 11/6 → 共用韌體交 Spotpear 11/27 → 到廠 12/4。要改板的話到貨推到 W9–W10。")
    a("- **軟件**：分區表和加密凍結 11/13 → 共用出廠韌體 11/27 → 首次開機 OTA 版本 12/11；App 殼 12/11 前過審。")
    a("")
    a("## 已定的決定")
    a("")
    for d, t in DECISION_LOG:
        a(f"- **{d}**：{t}")
    a("")
    a("## 每週計劃")
    a("")
    a("標 〔工廠〕 的項目會放進給玩具廠的 Excel。")
    a("")
    for wk in WEEKS:
        title = f"### W{wk['w']} · {wk['dates']}"
        if wk.get("now"):
            title += "（2026-10-12 當週）"
        a(title)
        a("")
        if wk.get("holiday"):
            a(f"*{wk['holiday']}*")
            a("")
        if wk.get("gates"):
            a("**關卡：** " + "；".join(wk["gates"]))
            a("")
        for key, name in TRACKS:
            items = wk.get(key) or []
            if not items:
                continue
            a(f"**{name}**")
            a("")
            for it in items:
                if it.startswith("F|"):
                    a(f"- {it[2:]} 〔工廠〕")
                else:
                    a(f"- {it}")
            a("")
    a("## 三個 App 的架構（10/12 已定）")
    a("")
    a("一套程式碼部署三次：每個品牌一套獨立的資料庫、網頁和語音伺服器，用同一組映像和同一個版本，只差設定（R-34）。")
    a("")
    a("- **原生殼**：同事負責，我們不改殼的程式碼。建議一個專案、三個 build flavor，每個品牌各自的名稱、圖示、bundle id、開發者帳號。"
      "殼提供：藍牙配網與綁定（R-21）、原生 Google／Apple 登入後經 signInWithIdToken 交給網頁、推送、麥克風、刪除帳號、深層連結。")
    a("- **每個品牌一套後端**（三套先放同一台伺服器）：網頁和管理後台（Next.js）、語音伺服器（pipecat）、Supabase（資料庫、帳號、儲存），各自的子網域和密鑰，OTA 各自提供。"
      "網頁由環境變數選品牌，載入主題 token、文案、功能開關；首頁、上手流程、角色頁按品牌各一版。")
    a("- **三套共用**：同一份程式碼和映像、同一個韌體（出廠寫入品牌和網址，R-35）、AI 供應商（同一個帳號，每個品牌一把 key）、部署腳本、監控和備份工具。不共用任何客戶資料。")
    a("")
    for t, d in DECISIONS:
        a(f"- **{t}**：{d}")
    a("")
    a("軟件開發與測試（網頁、App、Tool call、RAG、後台、測試、UAT；也在工廠 Excel 的「軟件開發與測試」工作表）：")
    a("")
    a("負責：「我方軟件」是用戶加 Claude；原生 App 殼由同事 Neo 負責。")
    a("")
    a("| 工作線 | 週次 | 完成 | 負責 | 內容 | 驗收標準 | 任務 |")
    a("|---|---|---|---|---|---|---|")
    for stream, weeks, finish, content, accept, ids, owner in SOFTWARE_PLAN:
        a(f"| {cell(stream)} | {weeks} | {finish} | {cell(owner)} | {cell(content)} | {cell(accept)} | {ids} |")
    a("")
    a("上架規則：")
    a("")
    a("| 規則 | 內容 | 影響 |")
    a("|---|---|---|")
    for r in RULES:
        a("| " + " | ".join(cell(x) for x in r) + " |")
    a("")
    a("## 燒錄和出廠自檢（10/12 已定，Q10）")
    a("")
    a("- **Spotpear**：出貨前燒所有品牌共用、不含密鑰的出廠韌體（最終 bootloader、分區表、Secure Boot），附每片 MAC 清單。")
    a("- **玩具廠裝機芯盒工位**：我方電腦和腳本經序列埠寫入設備密鑰、選品牌和款式、自檢（喇叭、麥克風、按鍵、燈、Wi-Fi、電池），再經 HTTPS 登記。每台約 1.5 分鐘，建議 2 個工位。")
    a("- **注意**：Spotpear 出貨測試第一次通電就會開啟 Secure Boot 和 Flash 加密，之後 bootloader 和分區表不能改。11/27 交 Spotpear 的映像必須是最終版；app 之後經 OTA 更新。")
    a("")
    a("## 風險")
    a("")
    a("| 程度 | 風險 | 說明 |")
    a("|---|---|---|")
    for s_, t, d in RISKS:
        a(f"| {s_} | {cell(t)} | {cell(d)} |")
    a("")
    a("## 待確認問題")
    a("")
    for i, q in enumerate(QUESTIONS, 1):
        a(f"{i}. {q}")
    a("")
    a("## 前提")
    a("")
    for x in ASSUMPTIONS:
        a(f"- {x}")
    a("")
    a("## 和進度表的對應")
    a("")
    a("| 進度表階段 | 路線圖週次 | 備註 |")
    a("|---|---|---|")
    for p in PHASE_MAP:
        a("| " + " | ".join(cell(x) for x in p) + " |")
    a("")
    a("以下工作在本路線圖裡，但**尚未加入進度表**（等路線圖定案後再加）：")
    a("")
    for x in NOT_IN_TRACKER:
        a(f"- {x}")
    a("")
    a("## 相關檔案")
    a("")
    a("- 每週里程碑跟進：`docs/project-schedule.xlsx`（每週一個里程碑，用戶在 Excel 手動更新狀態和實際完成日期；不要用腳本重建覆蓋）")
    a(f"- 給玩具廠的時間表：`docs/{xlsx_name}`（內地打不開 claude.ai，工廠只能用檔案）")
    a(f"- 網頁版：`docs/roadmap/roadmap.html`，發佈在 {ARTIFACT}")
    a("- 任務與測試記錄：`docs/production-readiness.xlsx`")
    a("- 馬會提案：`~/Desktop/快活_香港賽馬會AI會員伴侶提案.pptx`（對馬會的文字不要寫「趕及新春」）")
    a("")
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write("\n".join(L))
    print("wrote", os.path.normpath(OUT))


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else "factory.xlsx")
