# -*- coding: utf-8 -*-
"""Rebuild all roadmap outputs from plan.py.

    python3 docs/roadmap/build.py

Writes docs/roadmap.md, docs/roadmap/roadmap.html and
docs/毛公仔打版與量產時間表_草案<FACTORY_VERSION>.xlsx. Older workbook versions are
left in place; delete them by hand once the new one has been sent.
"""
import os, re, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.normpath(os.path.join(HERE, ".."))
sys.path.insert(0, HERE)
from plan import FACTORY_VERSION

xlsx = f"毛公仔打版與量產時間表_草案{FACTORY_VERSION}.xlsx"

subprocess.run([sys.executable, os.path.join(HERE, "build_html.py")], check=True)
subprocess.run([sys.executable, os.path.join(HERE, "build_xlsx.py"), os.path.join(DOCS, xlsx)], check=True)
subprocess.run([sys.executable, os.path.join(HERE, "build_md.py"), xlsx], check=True)
