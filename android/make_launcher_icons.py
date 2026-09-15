#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 Android 启动图标（零依赖，纯 Python 手写 PNG）

输出到 app/src/main/res/：
  mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png        传统圆角方形图标
  mipmap-{...}/ic_launcher_round.png                            传统圆形图标
  drawable-{...}/ic_launcher_foreground.png                     自适应图标前景（话筒，透明底）
  drawable-{...}/ic_launcher_background.png                     自适应图标背景（渐变铺满）
  mipmap-anydpi-v26/ic_launcher.xml / ic_launcher_round.xml     自适应图标描述

四种模式：
  icon  = 圆角方形背景 + 白色话筒
  round = 圆形背景 + 白色话筒
  fg    = 只有白色话筒，背景透明（自适应前景，内容留在 66dp 安全区内）
  bg    = 渐变铺满，无话筒（自适应背景）
"""

import math
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "app", "src", "main", "res")

C0 = (0x4F, 0x46, 0xE5)   # 渐变起点
C1 = (0x93, 0x33, 0xEA)   # 渐变终点
WHITE = (255, 255, 255)

DENSITIES = {
    "mdpi": 1.0,
    "hdpi": 1.5,
    "xhdpi": 2.0,
    "xxhdpi": 3.0,
    "xxxhdpi": 4.0,
}

LEGACY_DP = 48      # 传统图标基准尺寸
ADAPTIVE_DP = 108   # 自适应图标画布尺寸


# ------------------------------------------------------------ PNG 编码
def write_png(path, w, h, buf):
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    os.makedirs(os.path.dirname(path), exist_ok=True)
    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += buf[y * stride:(y + 1) * stride]

    out = b"\x89PNG\r\n\x1a\n"
    out += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    out += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    out += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(out)


# ------------------------------------------------------------ 渲染
def render(size, mode, ss=2):
    W = size * ss
    buf = bytearray(W * W * 4)
    hypot = math.hypot

    # ---------------- 背景 ----------------
    draw_bg = mode in ("icon", "round", "bg")
    if draw_bg:
        if mode == "round":
            radius = W / 2.0
            r_in = radius - 1.0
            corner = False
        elif mode == "icon":
            radius = 0.2226 * W
            r_in = radius - 1.0
            corner = True
        else:  # bg：铺满，无圆角
            radius = 0.0
            corner = False

        for y in range(W):
            row = y * W * 4
            for x in range(W):
                inside = True
                if radius > 0:
                    if corner:
                        dx = abs(x + 0.5 - W / 2) - (W / 2 - r_in)
                        dy = abs(y + 0.5 - W / 2) - (W / 2 - r_in)
                        if dx > 0 and dy > 0:
                            inside = hypot(dx, dy) <= r_in
                    else:
                        inside = hypot(x + 0.5 - W / 2, y + 0.5 - W / 2) <= r_in
                if not inside:
                    continue

                t = (x + y) / (2.0 * W)
                i = row + x * 4
                buf[i] = int(C0[0] + (C1[0] - C0[0]) * t)
                buf[i + 1] = int(C0[1] + (C1[1] - C0[1]) * t)
                buf[i + 2] = int(C0[2] + (C1[2] - C0[2]) * t)
                buf[i + 3] = 255

    # ---------------- 话筒 ----------------
    if mode != "bg":
        # 自适应图标：画布 108dp，可见安全区 66dp，所以内容要留在中间约 61%
        k = 0.62 if mode == "fg" else 1.0
        GS = 1.16
        kk = k * GS

        def S(v):
            return ((v - 0.5) * kk + 0.5) * W

        cap_cx, cap_cy = S(0.5), S(0.405)
        cap_hw, cap_hh = 0.0775 * W * kk, 0.150 * W * kk
        cap_b = cap_hh - cap_hw

        arc_cx, arc_cy = S(0.5), S(0.500)
        arc_R, arc_t = 0.155 * W * kk, 0.0165 * W * kk

        st_cx = S(0.5)
        st_y0, st_y1 = S(0.655), S(0.755)
        st_hw = 0.0165 * W * kk

        x0 = max(0, int(S(0.5) - 0.24 * W * kk) - 2)
        x1 = min(W, int(S(0.5) + 0.24 * W * kk) + 2)
        y0 = max(0, int(S(0.405) - 0.22 * W * kk) - 2)
        y1 = min(W, int(S(0.755)) + 4)

        for y in range(y0, y1):
            row = y * W * 4
            py = y + 0.5
            for x in range(x0, x1):
                px = x + 0.5
                hit = False

                qx = abs(px - cap_cx)
                qy = abs(py - cap_cy) - cap_b
                ox = qx if qx > 0.0 else 0.0
                oy = qy if qy > 0.0 else 0.0
                m = qx if qx > qy else qy
                if hypot(ox, oy) + (m if m < 0.0 else 0.0) - cap_hw <= 0:
                    hit = True

                if not hit and py >= arc_cy:
                    if abs(hypot(px - arc_cx, py - arc_cy) - arc_R) - arc_t <= 0:
                        hit = True

                if not hit and st_y0 - st_hw <= py <= st_y1 + st_hw:
                    if abs(px - st_cx) <= st_hw:
                        hit = True

                if hit:
                    i = row + x * 4
                    buf[i], buf[i + 1], buf[i + 2], buf[i + 3] = WHITE[0], WHITE[1], WHITE[2], 255

    # ---------------- 降采样 ----------------
    if ss == 1:
        return buf

    OW = size
    out = bytearray(OW * OW * 4)
    inv = 1.0 / (ss * ss)
    for oy in range(OW):
        orow = oy * OW * 4
        for ox in range(OW):
            r = g = b = a = 0
            for sy in range(ss):
                srow = ((oy * ss + sy) * W + ox * ss) * 4
                for sx in range(ss):
                    j = srow + sx * 4
                    av = buf[j + 3]
                    r += buf[j] * av
                    g += buf[j + 1] * av
                    b += buf[j + 2] * av
                    a += av
            oi = orow + ox * 4
            if a == 0:
                continue
            out[oi] = min(255, int(r / a))
            out[oi + 1] = min(255, int(g / a))
            out[oi + 2] = min(255, int(b / a))
            out[oi + 3] = int(a * inv)
    return out


ADAPTIVE_XML = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
"""


def main():
    made = []

    # 传统图标：圆角方形 + 圆形
    for density, scale in DENSITIES.items():
        px = int(LEGACY_DP * scale)
        for mode, name in (("icon", "ic_launcher"), ("round", "ic_launcher_round")):
            path = os.path.join(RES, f"mipmap-{density}", f"{name}.png")
            write_png(path, px, px, render(px, mode))
            made.append((os.path.relpath(path, HERE), px))

    # 自适应图标：前景 + 背景
    for density, scale in DENSITIES.items():
        px = int(ADAPTIVE_DP * scale)
        for mode, name in (("fg", "ic_launcher_foreground"), ("bg", "ic_launcher_background")):
            path = os.path.join(RES, f"drawable-{density}", f"{name}.png")
            write_png(path, px, px, render(px, mode))
            made.append((os.path.relpath(path, HERE), px))

    # 自适应图标描述
    for name in ("ic_launcher", "ic_launcher_round"):
        path = os.path.join(RES, "mipmap-anydpi-v26", f"{name}.xml")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(ADAPTIVE_XML)
        made.append((os.path.relpath(path, HERE), 0))

    for rel, px in made:
        print(f"  ✓ {rel}" + (f"  ({px}x{px})" if px else ""))
    print(f"\n共 {len(made)} 个文件")


if __name__ == "__main__":
    print("生成 Android 启动图标…")
    main()
