# -*- coding: utf-8 -*-
"""Factory timeline workbook: one simple weekly table plus the sample test sheet."""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from plan import FACTORY, FACTORY_TESTS, FACTORY_VERSION
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
    return max(1, -(-int(units) // max(1, int(width - 2))))


def font(size=10.5, bold=False, color="17202B"):
    return Font(name=FONT, size=size, bold=bold, color=color)

wb = Workbook()
ws = wb.active
ws.title = "時間表"
ws.sheet_view.showGridLines = False
ws["A1"] = "毛公仔打版與量產時間表（草案）"
ws["A1"].font = font(16, True)
ws["A2"] = (f"目標：2027 年 1 月 15 日量產完成出貨 · 草案 {FACTORY_VERSION} · 2026-10-12 · "
            "款式 A 共 2,500 隻（兩個造型）／B 500 隻／C 數量另行通知")
ws["A2"].font = font(10, color="5B6474")
ws.merge_cells("A1:F1"); ws.merge_cells("A2:F2")

heads = ["週次", "日期", "玩具廠", "我方（電路板、韌體、App）", "關鍵節點", "驗收標準"]
widths = [8, 14, 30, 36, 20, 40]
for i, (h, w) in enumerate(zip(heads, widths), start=1):
    c = ws.cell(row=4, column=i, value=h)
    c.font = font(10.5, True, "FFFFFF"); c.fill = HEAD; c.alignment = CENTER; c.border = B
    ws.column_dimensions[c.column_letter].width = w
ws.row_dimensions[4].height = 22

r = 5
for wk, dates, fac, we, key, accept in FACTORY:
    vals = [wk, dates, fac, we, key, accept]
    for i, v in enumerate(vals, start=1):
        c = ws.cell(row=r, column=i, value=v)
        c.font = font(10.5, bold=(i == 5))
        c.alignment = CENTER if i <= 2 else WRAP
        c.border = B
        if key:
            c.fill = GATE
    ws.row_dimensions[r].height = max(24, 16 * max(lines(v, w) for v, w in zip(vals, widths)) + 8)
    r += 1

r += 1
for n in ["黃色行是關鍵節點：延誤的話，後面的日期會跟著推遲，請提早通知。",
          "樣品寄出前請按「樣品測試項目」自檢；我方收到後 2 個工作天內回覆意見。"]:
    c = ws.cell(row=r, column=1, value=n)
    c.font = font(10, color="5B6474")
    ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=6)
    r += 1

ws.freeze_panes = "A5"
ws.page_setup.orientation = "landscape"
ws.page_setup.paperSize = ws.PAPERSIZE_A4
ws.sheet_properties.pageSetUpPr.fitToPage = True
ws.page_setup.fitToWidth = 1
ws.page_setup.fitToHeight = 0
ws.print_title_rows = "4:4"

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
