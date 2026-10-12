---
name: prod-readiness
description: aibuddy 生產就緒與上市路線圖追蹤。讀寫 docs/production-readiness.xlsx（P0 安全、P1 兒童安全與合規、P2 工程運維、R 產品與上市；按 4 個階段排到 3 個月內出 100–500 台），並回報「目前階段、已完成什麼、測試效果、接下來做什麼」。Use this whenever the user asks about progress or the roadmap (進度、做到哪了、還剩什麼、接下來做什麼、哪些完成了、測試結果如何、現在在哪個階段), says a tracked task is done or wants to start, block, add, re-phase or re-scope one (e.g. 「P0-02 做完了」「開始做 RLS」「選板定了」「加一項任務」), answers or raises an open question (韌體是否閉源、孩子年齡層, or a new one), or right after you finish work that matches a tracked task — Supabase RLS/grants, device tokens/JWT secret, /ws auth, device claiming, admin gating, OTA, secure boot, moderation, PII in logs, data retention, consent/DPA, GPL/LGPL licensing, tests/CI, containers, rate limits, alerting, backups, scaling, cost, board selection, enclosures, Cantonese quality, characters, beta families, factory provisioning, after-sales — even if the user never mentions the spreadsheet.
---

# 生產就緒追蹤

追蹤表 `docs/production-readiness.xlsx` 是唯一的事實來源，裡面有四個工作表：

- **總覽**：每次存檔時自動重建。
- **任務清單**
- **待確認問題**
- **更新記錄**

所有讀寫都經 `scripts/tracker.py` 完成，不要用 openpyxl 或其他方法直接改檔案。原因是腳本會同時做三件事：寫入更新記錄、重建總覽，以及執行「已完成＝測試通過」的規則。繞過腳本，這三者就會對不上。

在 repo 根目錄執行：

```bash
T=.claude/skills/prod-readiness/scripts/tracker.py
python3 $T status            # 進度報告
python3 $T show P0-02        # 單項完整內容：驗收標準、測試方法、歷史（Q 開頭則顯示問題）
python3 $T list [--priority R] [--phase 1] [--status 進行中]
```

## 優先級與階段

每項任務都有兩個維度：
- **優先級**：說明它屬於哪一類。P0 安全、P1 兒童安全與合規、P2 工程與運維、R 產品與上市。
- **階段**：說明它排在路線圖的哪一段。
  1. 止血定案（10/5–10/16）
  2. 內測準備（10/19–10/30）
  3. 封閉內測（11/2–11/27；2026-10-12 起改為內部測試），第 8 週設有關卡決策（R-08）
  4. 量產出貨（11/30–1/15）：1/15 量產完成出廠，1/29 前送達

完整路線圖（三個品牌、每週計劃、玩具廠線、App 架構、已定的決定）在 `docs/roadmap.md`。回答「接下來做什麼」時，先對照它的當週計劃；路線圖裡有些工作（多品牌、快活知識庫、三個 App、玩具廠）還沒加進追蹤表。

「接下來」先按階段排序，同一階段內再按優先級。優先級和階段的定義都寫在 `assets/seed.json`，要改路線圖時改那裡，再執行 `sync`。

## 顯示進度

執行 `status`，把輸出原樣交給用戶。它已經按用戶要的結構排好：

1. 目前階段、總進度、各優先級與各階段進度
2. ✅ 已完成與測試效果
3. ⏭ 接下來，以及同一階段還可以並行開始的任務
4. ⛔ 阻塞、⏳ 等待依賴
5. ❓ 待確認問題

最多再補一兩句你自己的建議，例如「P0-02～P0-05 可以寫在同一個 migration」「R-01 有硬件交期，建議和 P0 並行」。不要把報告改寫成別的格式，用戶每次看到的結構應該一致。

## 完成一項任務

這是最重要的流程。追蹤表只有在「已完成」代表「驗證過」時才有用，所以程式碼改完不等於完成。

1. **先讀要求**：執行 `show <ID>`，看驗收標準和測試方法。
2. **實際跑測試**，逐條對照驗收標準。以下情況先在對話裡問用戶，得到明確同意才做：
   - 測試會碰到線上環境：`elatoai.hkqft.com`、生產伺服器、生產資料庫。
   - 操作不可逆：燒 eFuse、輪換 secret、推到 `mygithub`（推送會觸發部署）。
3. **記錄結果**：
   - 全部通過：
     `update <ID> --status 已完成 --result 通過 --evidence "<跑了什麼 → 看到什麼>" --commit <hash>`
   - 部分通過或失敗：
     `update <ID> --result 失敗 --evidence "..."`（或 `--result 部分通過`）。狀態會保持進行中，然後告訴用戶哪裡沒過。
   - 你沒辦法自己驗證的任務，例如法律審閱、認證、只有用戶能操作的硬件：請用戶告訴你結果，證據寫成「用戶確認：……」，再標記完成。只有真的沒有測試可跑時才用 `--force --note "原因"`。
4. **再執行 `status`**，把報告給用戶。

**證據怎麼寫**：一到兩行，寫出命令和關鍵輸出。完整 log 不要貼進表格。例如：

> `anon GET /rest/v1/conversations → [] (0 行)；pg_policies 無 qual=true；語音對話後新行照常寫入`

**如果測試方法寫得不對**，例如實作方式改了，先用 `update <ID> --test-method "..."` 或 `--accept "..."` 修正，再照新標準測試。不要為了能打勾而放寬標準；真要放寬，先跟用戶說明原因。

## 其他更新

- **開始做**：`start <ID>`
- **卡住了**：`update <ID> --status 阻塞 --note "卡在哪、在等誰"`
- **不再需要**：`update <ID> --status 不適用 --note "原因"`。不要刪行，歷史要留著。
- **發現新問題**：`add --priority P0|P1|P2|R --phase 1-4 --title "..." --category ... --risk ... --where ... --accept ... --test ... --deps "P0-06, Q1"`。驗收標準和測試方法要寫到能照著執行，這是這張表有用的原因。
- **改階段或依賴**：`update <ID> --phase 3` 或 `--deps "R-01, Q1"`。這類修改會自動寫進更新記錄。
- **用戶回答了待確認問題**：`answer Q1 --text "..."`。腳本會列出因此解鎖的任務，順便告訴用戶。回答可能改變任務範圍，例如 Q3 決定開源的話，P1-06 可能變成不適用；需要時跟用戶確認後再更新。
- **出現需要用戶決定的新問題**：`ask --question "..." --why "..." --affects "R-02"`。會卡住任務的問題，也要寫進那些任務的依賴。

## 常見狀況

- **「正在 Excel 裡打開」**：請用戶先關閉 Excel 再更新。否則用戶在 Excel 按保存時，會把你這次的更新蓋掉。
- **「缺少欄位」或 seed.json 改過**：執行 `python3 $T sync`。它會把表升級到最新版面，並加入 seed.json 裡新增的任務和問題；已有的進度與更新記錄一格都不動，舊檔會先備份成 `docs/.production-readiness.<時間>.bak.xlsx`。
- **找不到檔案**：`python3 $T init` 會從 `assets/seed.json` 建一份全新的表。已有檔案時要加 `--force`，這會清掉所有進度，除非用戶明確要求，否則不要這樣做。
- **缺 openpyxl**：`python3 -m pip install openpyxl`
- **依賴規則**：依賴欄裡可以寫任務編號或問題編號。任務要「已完成」或「不適用」、問題要「已回覆」，才算滿足。依賴未滿足的任務不會出現在「接下來」。
