# -*- coding: utf-8 -*-
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from plan import FACTORY, FACTORY_TESTS, DATES, FACTORY_VERSION
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side

OUT = sys.argv[1]
FONT = "Microsoft JhengHei"
thin = Side(style="thin", color="C9CED6")
B = Border(left=thin, right=thin, top=thin, bottom=thin)
HEAD = PatternFill("solid", fgColor="17202B")
GATE = PatternFill("solid", fgColor="FFF4C9")
HOL = PatternFill("solid", fgColor="EEF0F3")
WRAP = Alignment(wrap_text=True, vertical="top")
CENTER = Alignment(horizontal="center", vertical="top", wrap_text=True)

KEY = {3: "10/30 第一版修改意見", 5: "11/13 外觀簽樣", 7: "11/27 PP 樣、大貨單",
       9: "12/11 試產通過", 10: "12/14 大貨開始", 12: "12/31 大貨完成", 14: "1/15 出貨"}

wb = Workbook()
ws = wb.active
ws.title = "時間表"
ws["A1"] = "毛公仔打版與量產時間表（草案）"
ws["A1"].font = Font(name=FONT, size=16, bold=True)
ws["A2"] = f"目標：2027 年 1 月 15 日量產完成出貨 · 草案 {FACTORY_VERSION} · 2026-10-12 · 款式 A 共 2,500 隻（兩個造型，各多少 11/20 前確定）／B 500 隻／C 數量另行通知"
ws["A2"].font = Font(name=FONT, size=10, color="5B6474")
ws.merge_cells("A1:G1"); ws.merge_cells("A2:G2")

heads = ["週次", "日期", "關鍵日期", "工廠負責", "我方負責／確認", "本週交付物", "備註"]
widths = [7, 13, 18, 42, 42, 26, 24]
for i, (h, w) in enumerate(zip(heads, widths), start=1):
    c = ws.cell(row=4, column=i, value=h)
    c.font = Font(name=FONT, bold=True, color="FFFFFF")
    c.fill = HEAD; c.alignment = CENTER; c.border = B
    ws.column_dimensions[c.column_letter].width = w

r = 5
for wk, fac, we, deliv, note in FACTORY:
    vals = [f"W{wk}", DATES[wk], KEY.get(wk, ""), fac, we, deliv, note]
    for i, v in enumerate(vals, start=1):
        c = ws.cell(row=r, column=i, value=v)
        c.font = Font(name=FONT, size=10.5, bold=(i == 3))
        c.alignment = CENTER if i <= 2 else WRAP
        c.border = B
        if wk in KEY:
            c.fill = GATE
        elif wk in (11, 12):
            c.fill = HOL
    r += 1

r += 1
notes = [
    "說明：",
    "1. 每個週次由星期一開始，W1 為 2026/10/12 起的一週。",
    "2. 黃色為關鍵日期。關鍵日期延誤，後面的日期會跟著推遲，請提早通知。",
    "3. 樣品寄出前，請按「樣品測試項目」自檢；我方收到後 2 個工作天內回覆意見。",
    "4. 板子由供應商出貨前燒好共用韌體。工廠在裝機芯盒的工位，用我方提供的電腦和腳本完成每台的寫入、自檢和登記，每台約 1.5 分鐘，建議設 2 個工位。",
]
for n in notes:
    c = ws.cell(row=r, column=1, value=n)
    c.font = Font(name=FONT, size=10, color="5B6474", bold=(n == "說明："))
    ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=7)
    r += 1
ws.freeze_panes = "A5"
ws.page_setup.orientation = "landscape"
ws.page_setup.fitToWidth = 1
ws.sheet_properties.pageSetUpPr.fitToPage = True
ws.page_setup.fitToHeight = 0

# Key dates sheet
k = wb.create_sheet("關鍵日期")
for i, (h, w) in enumerate(zip(["日期", "事項", "負責"], [12, 46, 16]), start=1):
    c = k.cell(row=1, column=i, value=h)
    c.font = Font(name=FONT, bold=True, color="FFFFFF"); c.fill = HEAD; c.alignment = CENTER; c.border = B
    k.column_dimensions[c.column_letter].width = w
rows = [
    ("10/16", "機芯規格交工廠；工廠回覆打樣排期", "我方／工廠"),
    ("10/23", "機芯盒 3D 設計 v1、第一版初樣", "工廠"),
    ("10/30", "第一版樣品測試完成，給修改意見", "我方"),
    ("11/6", "機芯盒定稿開模；20 隻內部測試樣品", "工廠"),
    ("11/13", "外觀簽樣（款式 A 兩個造型、B）；長交期物料下單", "我方／工廠"),
    ("11/20", "T1 試模樣品；包裝打樣", "工廠"),
    ("11/20", "款式 A 兩個造型各多少", "我方"),
    ("11/27", "PP 樣簽樣；下大貨單（A 2,500、B 500，C 另行通知）", "我方"),
    ("12/4", "物料、量產板（已燒好共用韌體）到廠；寫入和自檢工位就位", "工廠／我方"),
    ("12/11", "試產 50–100 隻並通過", "工廠／我方"),
    ("12/14", "大貨開始", "工廠"),
    ("12/23 前後", "中期驗貨", "我方"),
    ("12/31", "大貨完成", "工廠"),
    ("1/8", "緩衝週結束；尾期驗貨", "工廠／我方"),
    ("1/15", "包裝出貨；交序號與 MAC 對照表", "工廠"),
]
for j, row in enumerate(rows, start=2):
    for i, v in enumerate(row, start=1):
        c = k.cell(row=j, column=i, value=v)
        c.font = Font(name=FONT, size=10.5, bold=(i == 1)); c.alignment = WRAP; c.border = B

# Sample test sheet
t = wb.create_sheet("樣品測試項目")
th = ["項目", "要求", "第一版 W3", "第二版 W4", "T1 W6", "PP 樣 W7", "試產 W9"]
tw = [14, 50, 11, 11, 11, 11, 11]
for i, (h, w) in enumerate(zip(th, tw), start=1):
    c = t.cell(row=1, column=i, value=h)
    c.font = Font(name=FONT, bold=True, color="FFFFFF"); c.fill = HEAD; c.alignment = CENTER; c.border = B
    t.column_dimensions[c.column_letter].width = w
for j, (item, req) in enumerate(FACTORY_TESTS, start=2):
    for i, v in enumerate([item, req] + [""] * 5, start=1):
        c = t.cell(row=j, column=i, value=v)
        c.font = Font(name=FONT, size=10.5, bold=(i == 1)); c.alignment = WRAP if i <= 2 else CENTER; c.border = B
n = len(FACTORY_TESTS) + 3
c = t.cell(row=n, column=1, value="每一輪填 ✓ 或 ✗，✗ 請在備註寫明問題。認證（EN71、電池、無線）由我方安排送檢。")
c.font = Font(name=FONT, size=10, color="5B6474")
t.merge_cells(start_row=n, start_column=1, end_row=n, end_column=7)

wb.save(OUT)
print("saved", OUT)
