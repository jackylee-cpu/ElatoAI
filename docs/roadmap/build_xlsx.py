# -*- coding: utf-8 -*-
"""Factory timeline workbook: one simple weekly table plus the sample test sheet."""
import math, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from plan import FACTORY, FACTORY_TESTS, FACTORY_VERSION, SOFTWARE_PLAN, PEOPLE
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side

OUT = sys.argv[1]
FONT = "Microsoft JhengHei"
thin = Side(style="thin", color="C9CED6")
B = Border(left=thin, right=thin, top=thin, bottom=thin)
HEAD = PatternFill("solid", fgColor="17202B")
GATE = PatternFill("solid", fgColor="FFF4C9")
WRAP = Alignment(wrap_text=True, vertical="center")
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)

def lines(text, width):
    """Wrapped line count: a CJK character takes about 2.2 width units at 10.5pt, ASCII about 1.1."""
    units = sum(2.2 if ord(ch) > 0x2E80 else 1.1 for ch in text)
    return max(1, math.ceil(units / max(1, width - 4)))


def font(size=10.5, bold=False, color="17202B"):
    return Font(name=FONT, size=size, bold=bold, color=color)

wb = Workbook()
ws = wb.active
ws.title = "時間表"
ws.sheet_view.showGridLines = False
ws["A1"] = "毛公仔打版與量產時間表（草案）"
ws["A1"].font = font(16, True)
ws["A2"] = (f"目標：2027 年 1 月 15 日量產完成出貨 · 草案 {FACTORY_VERSION} · 2026-10-13 · "
            "款式 A 共 2,500 隻（兩個造型）／B 500 隻；AI Buddy 款 1/15 後另行安排")
ws["A2"].font = font(10, color="5B6474")
ws.merge_cells("A1:G1"); ws.merge_cells("A2:G2")

heads = ["週次", "日期", "關鍵節點", "玩具廠", "驗收標準（玩具廠）", "我方（電路板、韌體、App）", "驗收標準（我方）"]
widths = [8, 14, 18, 24, 30, 30, 36]
HIGHLIGHT = (3, 5, 7)  # milestone and the two acceptance columns
for i, (h, w) in enumerate(zip(heads, widths), start=1):
    c = ws.cell(row=4, column=i, value=h)
    c.font = font(10.5, True, "FFFFFF"); c.fill = HEAD; c.alignment = CENTER; c.border = B
    ws.column_dimensions[c.column_letter].width = w
ws.row_dimensions[4].height = 22

r = 5
for vals in FACTORY:
    for i, v in enumerate(vals, start=1):
        c = ws.cell(row=r, column=i, value=v)
        c.font = font(10.5, bold=(i == 3))
        c.alignment = CENTER if i <= 2 else WRAP
        c.border = B
        if v and i in HIGHLIGHT:
            c.fill = GATE
    ws.row_dimensions[r].height = max(24, 16 * max(lines(v, w) for v, w in zip(vals, widths)) + 8)
    r += 1

r += 1
for n in ["黃色格是關鍵節點和驗收標準。關鍵節點延誤的話，後面的日期會跟著推遲，請提早通知。",
          "樣品寄出前請按「樣品測試項目」自檢；我方收到後 2 個工作天內回覆意見。"]:
    c = ws.cell(row=r, column=1, value=n)
    c.font = font(10, color="5B6474")
    ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=7)
    r += 1

r += 1
ws.cell(row=r, column=1, value="參與人").font = font(12, True)
r += 1
for col, (c1, c2, h) in enumerate([(1, 2, "姓名"), (3, 3, "角色"), (4, 7, "負責")]):
    c = ws.cell(row=r, column=c1, value=h)
    c.font = font(10.5, True, "FFFFFF"); c.fill = HEAD; c.alignment = CENTER
    for cc in range(c1, c2 + 1):
        ws.cell(row=r, column=cc).fill = HEAD; ws.cell(row=r, column=cc).border = B
    if c2 > c1:
        ws.merge_cells(start_row=r, start_column=c1, end_row=r, end_column=c2)
for name, role, duty in PEOPLE:
    r += 1
    for c1, c2, v, bold, al in [(1, 2, name, True, CENTER), (3, 3, role, False, CENTER), (4, 7, duty, False, WRAP)]:
        c = ws.cell(row=r, column=c1, value=v)
        c.font = font(10.5, bold); c.alignment = al
        for cc in range(c1, c2 + 1):
            ws.cell(row=r, column=cc).border = B
        if c2 > c1:
            ws.merge_cells(start_row=r, start_column=c1, end_row=r, end_column=c2)
    ws.row_dimensions[r].height = max(24, 16 * lines(duty, sum(widths[3:7])) + 8)

ws.freeze_panes = "A5"
ws.page_setup.orientation = "landscape"
ws.page_setup.paperSize = ws.PAPERSIZE_A4
ws.sheet_properties.pageSetUpPr.fitToPage = True
ws.page_setup.fitToWidth = 1
ws.page_setup.fitToHeight = 0
ws.print_title_rows = "4:4"

a = wb.create_sheet("軟件開發與測試")
a.sheet_view.showGridLines = False
a["A1"] = "軟件開發與測試：網頁、App、Tool call、RAG、後台、測試、UAT"
a["A1"].font = font(14, True)
a["A2"] = "網頁統一開發一套，三個品牌是三套外觀，包在原生殼裡；1/15 上架快活和政協青年聯會兩個 App（AI Buddy 隨玩具延後）。殼由 Neo 負責；設計、角色和 App 圖由 Navy 負責；網頁、後台、語音系統和韌體由 Jacky 負責。殼過審後，網頁畫面可以繼續更新，不用重新送審。"
a["A2"].font = font(10, color="5B6474")
a.merge_cells("A1:F1"); a.merge_cells("A2:F2")
a["A2"].alignment = Alignment(wrap_text=True, vertical="top")
a.row_dimensions[2].height = 30
ah = ["工作線", "週次", "完成日期", "負責", "內容", "驗收標準（全部做到才算完成）"]
aw = [16, 10, 10, 16, 28, 60]
for i, (h, w) in enumerate(zip(ah, aw), start=1):
    c = a.cell(row=4, column=i, value=h)
    c.font = font(10.5, True, "FFFFFF"); c.fill = HEAD; c.alignment = CENTER; c.border = B
    a.column_dimensions[c.column_letter].width = w
ar = 5
group_start, group_name = 5, None
def close_group(end):
    if group_name and end > group_start:
        a.merge_cells(start_row=group_start, start_column=1, end_row=end, end_column=1)
for stream, weeks, finish, content, accept, _ids, owner in SOFTWARE_PLAN:
    if stream != group_name:
        close_group(ar - 1)
        group_start, group_name = ar, stream
    vals = [stream, weeks, finish, owner, content, accept]
    for i, v in enumerate(vals, start=1):
        c = a.cell(row=ar, column=i, value=v)
        c.font = font(10.5, bold=(i in (1, 3)))
        c.alignment = CENTER if i <= 4 else WRAP
        c.border = B
        if i == 6:
            c.fill = GATE
    a.row_dimensions[ar].height = max(24, 16 * max(lines(owner, aw[3]), lines(content, aw[4]), lines(accept, aw[5])) + 8)
    ar += 1
close_group(ar - 1)
a.freeze_panes = "A5"
a.page_setup.orientation = "landscape"
a.page_setup.paperSize = a.PAPERSIZE_A4
a.sheet_properties.pageSetUpPr.fitToPage = True
a.page_setup.fitToWidth = 1
a.page_setup.fitToHeight = 0
a.print_title_rows = "4:4"

t = wb.create_sheet("樣品測試項目")
t.sheet_view.showGridLines = False
th = ["項目", "要求", "第一版 W3", "第二版 W4", "T1 W6", "產前樣 W7", "試產 W9"]
tw = [14, 50, 11, 11, 11, 11, 11]
for i, (h, w) in enumerate(zip(th, tw), start=1):
    c = t.cell(row=1, column=i, value=h)
    c.font = font(10.5, True, "FFFFFF"); c.fill = HEAD; c.alignment = CENTER; c.border = B
    t.column_dimensions[c.column_letter].width = w
for j, (item, req) in enumerate(FACTORY_TESTS, start=2):
    for i, v in enumerate([item, req] + [""] * 5, start=1):
        c = t.cell(row=j, column=i, value=v)
        c.font = font(10.5, bold=(i == 1)); c.alignment = WRAP if i <= 2 else CENTER; c.border = B
n = len(FACTORY_TESTS) + 3
c = t.cell(row=n, column=1, value="每一輪填 ✓ 或 ✗，✗ 請寫明問題。認證（玩具安全、無線、電池）由我方安排送檢。")
c.font = font(10, color="5B6474")
t.merge_cells(start_row=n, start_column=1, end_row=n, end_column=7)
t.page_setup.orientation = "landscape"
t.page_setup.paperSize = t.PAPERSIZE_A4
t.sheet_properties.pageSetUpPr.fitToPage = True
t.page_setup.fitToWidth = 1
t.page_setup.fitToHeight = 0

wb.save(OUT)
print("saved", OUT)
