# X-Really 图标构建器（从设计稿位图生成 Chrome 扩展图标集）
#
# 设计稿：icons/source-logo.jpg（蓝底圆角方块 + 推文卡片 + 谣言印章 + AI 放大镜）
# 用法：  python tools/build_icons.py [设计稿路径] [输出目录]
#
# 与 tools/generate_icons.py 的区别：
#   generate_icons.py  纯标准库、程序化绘制（旧盾牌方案，保留作参考）
#   build_icons.py     处理位图设计稿——抠出圆角方形轮廓 + 多尺寸锐化（本方案）
#
# 依赖：Pillow（仅构建图标时需要，扩展本身零依赖，不影响发布包）
#   python -m venv .venv && .venv\Scripts\pip install pillow
#
# 关键处理（为什么需要）：
#   1. 设计稿四周是白底 + 灰色投影。直接缩放会让暗色工具栏出现白角/灰晕，
#      故用「低饱和度泛洪填充」从画布边缘吞掉白色与投影，止于饱和的蓝色边缘，
#      得到透明外角；不靠猜圆角半径，轮廓与原设计完全一致。
#   2. 主体元素多（卡片/头像/X/印章/放大镜/机器人），16px 直接缩放会糊成一团。
#      故小尺寸按系数放大主体（crop 外围留白后放大），16px 用 1.42、32/48px 用 1.16。
#   3. 缩小前后各做一次 UnsharpMask，抵消重采样带来的软化。

import os
import sys
from collections import deque

from PIL import Image, ImageChops, ImageDraw, ImageFilter

# 各尺寸的"主体放大系数"：1.0 = 完整构图（保留四周留白）
PLAN = {16: 1.42, 32: 1.16, 48: 1.16, 128: 1.0}
MASTER = 1024          # 母版尺寸（同时作为 icons/icon.png 源文件）
LOW_SAT_TOL = 28       # 判定"背景"的饱和度阈值（max-min of RGB）
MATTE_BLUR = 0.7       # 抠图边缘柔化半径
SHARPEN = dict(radius=1.6, percent=45, threshold=2)


def is_low_sat(px, tol=LOW_SAT_TOL):
    """低饱和度 = 白底或灰色投影；饱和的蓝色属于图形本体"""
    return max(px) - min(px) <= tol


def is_blue(px):
    return px[2] > px[0] + 25 and px[2] > 100


def cut_out(im):
    """从画布边缘泛洪填充，得到 alpha（外部=透明）。返回 RGBA 图。"""
    w, h = im.size
    px = im.load()
    outside = bytearray(w * h)
    dq = deque()

    def seed(x, y):
        i = y * w + x
        if not outside[i] and is_low_sat(px[x, y]):
            outside[i] = 1
            dq.append((x, y))

    for x in range(w):
        seed(x, 0)
        seed(x, h - 1)
    for y in range(h):
        seed(0, y)
        seed(w - 1, y)

    while dq:
        x, y = dq.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h:
                i = ny * w + nx
                if not outside[i] and is_low_sat(px[nx, ny]):
                    outside[i] = 1
                    dq.append((nx, ny))

    alpha = Image.frombytes("L", (w, h), bytes(0 if v else 255 for v in outside))
    out = im.copy()
    out.putalpha(alpha.filter(ImageFilter.GaussianBlur(MATTE_BLUR)))
    return out


def measure(im):
    """量出蓝色本体的包围盒与圆角半径（用于方形裁切与遮罩）"""
    w, h = im.size
    px = im.load()
    xs, ys = [], []
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            if is_blue(px[x, y]):
                xs.append(x)
                ys.append(y)
    left, right, top, bottom = min(xs), max(xs), min(ys), max(ys)

    radius = 224
    for dy in range(400):
        first = next((x for x in range(left, right + 1) if is_blue(px[x, top + dy])), None)
        if first is not None and first <= left + 1:
            radius = dy
            break

    side = min(right - left + 1, bottom - top + 1)
    cx, cy = (left + right + 1) // 2, (top + bottom + 1) // 2
    box = (cx - side // 2, cy - side // 2, cx + side // 2, cy + side // 2)
    return box, side, radius


def rounded_mask(size, r, ss=4):
    m = Image.new("L", (size * ss, size * ss), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size * ss - 1, size * ss - 1], radius=r * ss, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def build(src, out_dir):
    im = Image.open(src).convert("RGB")
    art = cut_out(im)
    box, side, radius = measure(im)

    # 母版：方形裁切 + 透明圆角
    master = art.crop(box).resize((MASTER, MASTER), Image.LANCZOS).filter(ImageFilter.UnsharpMask(**SHARPEN))
    mr = int(radius / side * MASTER)
    master.putalpha(ImageChops.multiply(master.getchannel("A"), rounded_mask(MASTER, mr)))

    os.makedirs(out_dir, exist_ok=True)
    master.save(os.path.join(out_dir, "icon.png"))
    for size, zoom in PLAN.items():
        if zoom == 1.0:
            img = master.resize((size, size), Image.LANCZOS)
        else:
            # 主体放大：原图与"同源圆角遮罩"同步裁切缩放，轮廓与 128 保持一致
            inset = int(side * (1 - 1 / zoom) / 2)
            rgb = im.crop((box[0] + inset, box[1] + inset, box[2] - inset, box[3] - inset))
            rgb = rgb.filter(ImageFilter.UnsharpMask(radius=1.4, percent=40, threshold=2))
            full = Image.new("L", (side, side), 0)
            ImageDraw.Draw(full).rounded_rectangle([0, 0, side - 1, side - 1], radius=radius, fill=255)
            m = full.crop((inset, inset, side - inset, side - inset))
            img = rgb.convert("RGBA")
            img.putalpha(m.resize(rgb.size, Image.LANCZOS).filter(ImageFilter.GaussianBlur(0.5)))
            img = img.resize((size, size), Image.LANCZOS)
        img.save(os.path.join(out_dir, f"icon{size}.png"))
        print(f"icon{size}.png  (zoom x{zoom})")
    print(f"icon.png  (master {MASTER}, radius {mr})")


if __name__ == "__main__":
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, "icons", "source-logo.jpg")
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(root, "icons")
    build(src, out)
