# X-Really 图标生成器（纯标准库）
# 设计：靛紫渐变圆角方块 + 白色放大镜 + 感叹号（"检查/核查"意象）
# 用法：python tools/generate_icons.py

import math
import os
import struct
import zlib

C1 = (99, 102, 241)  # #6366F1 靛蓝
C2 = (168, 85, 247)  # #A855F7 紫罗兰
SS = 4  # 超采样倍数
AA = 4.0  # 抗锯齿宽度（渲染像素单位）


def clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


def coverage(sdf):
    return clamp(0.5 - sdf / AA, 0.0, 1.0)


def sd_rounded_rect(px, py, cx, cy, hw, hh, r):
    dx = abs(px - cx) - (hw - r)
    dy = abs(py - cy) - (hh - r)
    ax = max(dx, 0.0)
    ay = max(dy, 0.0)
    return math.hypot(ax, ay) + min(max(dx, dy), 0.0) - r


def sd_segment(px, py, ax, ay, bx, by):
    abx, aby = bx - ax, by - ay
    apx, apy = px - ax, py - ay
    denom = abx * abx + aby * aby
    t = 0.0 if denom == 0 else clamp((apx * abx + apy * aby) / denom, 0.0, 1.0)
    return math.hypot(px - (ax + t * abx), py - (ay + t * aby))


def render(S):
    """按目标尺寸的 SS 倍渲染，返回 [ (r,g,b,a) 行 ] * S"""
    px_size = S * SS
    rows = []
    # 几何参数（按渲染尺寸比例）
    bg_h = px_size / 2 - px_size * 0.012
    bg_r = px_size * 0.22
    lens_cx, lens_cy, lens_r = 0.42 * px_size, 0.40 * px_size, 0.185 * px_size
    ring_t = 0.042 * px_size
    h_a = (0.545 * px_size, 0.525 * px_size)
    h_b = (0.75 * px_size, 0.73 * px_size)
    handle_t = 0.036 * px_size
    bar = (0.42 * px_size, 0.355 * px_size, 0.020 * px_size, 0.048 * px_size, 0.019 * px_size)
    dot = (0.42 * px_size, 0.455 * px_size, 0.023 * px_size)

    for y in range(px_size):
        row = []
        for x in range(px_size):
            # 背景：渐变圆角方块
            bg_cov = coverage(
                sd_rounded_rect(x + 0.5, y + 0.5, px_size / 2, px_size / 2, bg_h, bg_h, bg_r)
            )
            t = clamp((x + y) / (2.0 * px_size), 0.0, 1.0)
            gr = C1[0] + (C2[0] - C1[0]) * t
            gg = C1[1] + (C2[1] - C1[1]) * t
            gb = C1[2] + (C2[2] - C1[2]) * t

            # 白色元素：镜环 / 镜柄 / 感叹号
            d = math.hypot(x + 0.5 - lens_cx, y + 0.5 - lens_cy)
            w_cov = coverage(abs(d - lens_r) - ring_t)
            w_cov = max(w_cov, coverage(sd_segment(x + 0.5, y + 0.5, h_a[0], h_a[1], h_b[0], h_b[1]) - handle_t))
            w_cov = max(
                w_cov,
                coverage(
                    sd_rounded_rect(x + 0.5, y + 0.5, bar[0], bar[1], bar[2], bar[3], bar[4])
                ),
            )
            w_cov = max(
                w_cov,
                coverage(math.hypot(x + 0.5 - dot[0], y + 0.5 - dot[1]) - dot[2]),
            )

            # 白色 over 渐变 over 透明
            out_a = w_cov + bg_cov * (1.0 - w_cov)
            if out_a > 0:
                r = (255.0 * w_cov + gr * bg_cov * (1.0 - w_cov)) / out_a
                g = (255.0 * w_cov + gg * bg_cov * (1.0 - w_cov)) / out_a
                b = (255.0 * w_cov + gb * bg_cov * (1.0 - w_cov)) / out_a
                row.append((r, g, b, out_a * 255.0))
            else:
                row.append((0.0, 0.0, 0.0, 0.0))
        rows.append(row)
    return rows


def downsample(rows, size):
    """SS 倍超采样 -> 目标尺寸（SS*SS 盒式滤波）"""
    out = []
    for y in range(size):
        row = []
        for x in range(size):
            r = g = b = a = 0.0
            for dy in range(SS):
                for dx in range(SS):
                    pr, pg, pb, pa = rows[y * SS + dy][x * SS + dx]
                    r += pr
                    g += pg
                    b += pb
                    a += pa
            n = SS * SS
            row.append((r / n, g / n, b / n, a / n))
        out.append(row)
    return out


def write_png(path, size, rows):
    raw = b""
    for row in rows:
        raw += b"\x00" + b"".join(
            struct.pack("BBBB", int(clamp(c[0] + 0.5, 0, 255)),
                        int(clamp(c[1] + 0.5, 0, 255)),
                        int(clamp(c[2] + 0.5, 0, 255)),
                        int(clamp(c[3] + 0.5, 0, 255)))
            for c in row
        )

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    icons_dir = os.path.join(os.path.dirname(here), "icons")
    os.makedirs(icons_dir, exist_ok=True)

    for size in (16, 48, 128):
        rows = downsample(render(size), size)
        path = os.path.join(icons_dir, "icon%d.png" % size)
        write_png(path, size, rows)
        print("生成", path)


if __name__ == "__main__":
    main()
