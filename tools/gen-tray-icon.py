#!/usr/bin/env python3
"""从 assets/kuake-studio-1024.png 生成 64x64 RGBA 托盘图标（Pillow LANCZOS）。

用法：python3 tools/gen-tray-icon.py
产物：assets/tray-icon-64.rgba —— 由 src/tray.rs 的 include_bytes! 编译进二进制，
运行时不依赖任何图片文件 / 解码库。
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
src = ROOT / "assets" / "kuake-studio-1024.png"
dst = ROOT / "assets" / "tray-icon-64.rgba"
im = Image.open(src).convert("RGBA").resize((64, 64), Image.LANCZOS)
dst.write_bytes(im.tobytes())
print(f"{dst.relative_to(ROOT)}: {dst.stat().st_size} bytes")
