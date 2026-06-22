"""
Kage Trails — trail FX library.
Each effect takes an RGBA trail layer (float: rgb 0..255, a 0..1) and returns a modified one.
These run ONLY on the trail layer, so you can distort/stylize the trails without touching the
live subject or background. Designed to chain: chroma -> crt -> sort, etc.
"""
import numpy as np
from PIL import Image, ImageFilter

ACCENT = (139, 92, 246)

def _luma(rgb):  # rgb 0..255 -> 0..1
    return (0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]) / 255.0

def _smoothstep(a, b, x):
    t = np.clip((x - a) / max(b - a, 1e-6), 0, 1)
    return t * t * (3 - 2 * t)

# ---- chromatic aberration: split R/B horizontally (and optional vertical) ----
def chroma(rgba, amount=4, vertical=0):
    a, v = int(amount), int(vertical)
    out = rgba.copy()
    out[..., 0] = np.roll(np.roll(rgba[..., 0], -a, axis=1), -v, axis=0)
    out[..., 2] = np.roll(np.roll(rgba[..., 2],  a, axis=1),  v, axis=0)
    return out

# ---- CRT: scanlines + subtle RGB aperture + brightness lift ----
def crt(rgba, scan=0.35, aperture=0.12, gain=1.12):
    out = rgba.copy()
    out[..., :3] *= gain
    out[1::2, :, :3] *= (1.0 - scan)                 # darken every other line
    if aperture > 0:                                  # faint vertical RGB mask
        W = rgba.shape[1]; col = np.arange(W) % 3
        m = np.ones((1, W, 3), np.float32)
        for c in range(3): m[0, col == c, c] += aperture; m[0, col != c, c] -= aperture * 0.5
        out[..., :3] *= m
    return np.clip(out, 0, 255)

# ---- luma key: keep the trail only where its brightness is in [lo, hi] ----
def lumakey(rgba, lo=0.12, hi=1.0, soft=0.06):
    L = _luma(rgba[..., :3])
    m = _smoothstep(lo - soft, lo + soft, L) * (1 - _smoothstep(hi - soft, hi + soft, L))
    out = rgba.copy(); out[..., 3] = rgba[..., 3] * m
    return out

# ---- wave / ripple distortion ----
def wave(rgba, amp=7, freq=0.05, axis="x"):
    H, W, _ = rgba.shape
    yy, xx = np.indices((H, W))
    if axis == "x":
        sx = (xx + (amp * np.sin(yy * freq)).astype(np.int32)) % W
        return rgba[yy, sx]
    sy = (yy + (amp * np.sin(xx * freq)).astype(np.int32)) % H
    return rgba[sy, xx]

# ---- ordered (Bayer 4x4) dither / posterize ----
_BAYER = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]], np.float32) / 16.0 - 0.5
def dither(rgba, levels=4, strength=1.0):
    H, W, _ = rgba.shape
    thr = np.tile(_BAYER, (H // 4 + 1, W // 4 + 1))[:H, :W][..., None] * strength
    rgb = rgba[..., :3] / 255.0
    q = np.round(rgb * (levels - 1) + thr) / (levels - 1)
    out = rgba.copy(); out[..., :3] = np.clip(q, 0, 1) * 255.0
    return out

# ---- pixel sorter: sort trail pixels per row/col by brightness ----
def sort(rgba, axis="x", reverse=False):
    out = rgba.copy()
    work = rgba if axis == "x" else np.transpose(rgba, (1, 0, 2))
    res = out if axis == "x" else np.transpose(out, (1, 0, 2))
    L = _luma(work[..., :3]); A = work[..., 3]
    for y in range(work.shape[0]):
        idx = np.where(A[y] > 0.45)[0]
        if idx.size < 2: continue
        order = idx[np.argsort(L[y, idx])]
        if reverse: order = order[::-1]
        res[y, idx, :] = work[y, order, :]
    return out

# ---- glitch: random horizontal block displacement + channel tear ----
def glitch(rgba, intensity=18, slices=9, channel=6, seed=7):
    rng = np.random.RandomState(int(seed)); out = rgba.copy(); H, W, _ = rgba.shape
    ys = np.sort(rng.randint(0, H, size=slices * 2))
    for b in range(0, len(ys) - 1, 2):
        y0, y1 = int(ys[b]), int(ys[b + 1])
        if y1 > y0:
            out[y0:y1] = np.roll(out[y0:y1], int(rng.randint(-intensity, intensity + 1)), axis=1)
    if channel:
        out[..., 0] = np.roll(out[..., 0], int(channel), axis=1)
        out[..., 2] = np.roll(out[..., 2], -int(channel), axis=1)
    return out

# ---- posterize: reduce colour levels (no dithering) ----
def posterize(rgba, levels=5):
    out = rgba.copy(); rgb = rgba[..., :3] / 255.0
    out[..., :3] = np.clip(np.round(rgb * (levels - 1)) / (levels - 1), 0, 1) * 255.0
    return out

# ---- mirror: reflect one half onto the other (kaleidoscope-lite) ----
def mirror(rgba, axis="x", side="left"):
    out = rgba.copy()
    if axis == "x":
        m = rgba.shape[1] // 2; flip = rgba[:, ::-1, :]
        if side == "left": out[:, m:, :] = flip[:, m:, :]
        else:              out[:, :m, :] = flip[:, :m, :]
    else:
        m = rgba.shape[0] // 2; flip = rgba[::-1, :, :]
        if side == "top":  out[m:, :, :] = flip[m:, :, :]
        else:              out[:m, :, :] = flip[:m, :, :]
    return out

# ---- displacement: 2D turbulent warp (different from the single-axis wave) ----
def displace(rgba, amount=10, scale=0.03):
    H, W, _ = rgba.shape; yy, xx = np.indices((H, W))
    nx = np.sin(xx * scale) + np.cos(yy * scale * 1.3)
    ny = np.cos(xx * scale * 1.1) + np.sin(yy * scale)
    sx = np.clip(xx + (nx * amount).astype(np.int32), 0, W - 1)
    sy = np.clip(yy + (ny * amount).astype(np.int32), 0, H - 1)
    return rgba[sy, sx]

# ---- scanline roll: desync / rolling sheared scanlines (broken-CRT vibe) ----
def scanline_roll(rgba, roll=14, period=7.0, scan=0.3, phase=0.0):
    H, W, _ = rgba.shape; yy = np.arange(H)
    shift = (roll * np.sin(yy / period + phase)).astype(np.int32)
    cols = (np.arange(W)[None, :] - shift[:, None]) % W
    out = rgba[yy[:, None], cols].copy()
    out[1::2, :, :3] *= (1 - scan)
    return out

# ---- bloom: blur the bright parts and add them back (soft glow) ----
def bloom(rgba, threshold=0.55, radius=8, strength=1.3):
    rgb = rgba[..., :3] / 255.0
    m = np.clip((_luma(rgba[..., :3]) - threshold) / max(1 - threshold, 1e-6), 0, 1)
    bright = (rgb * m[..., None] * 255).astype(np.uint8)
    bb = np.asarray(Image.fromarray(bright).filter(ImageFilter.GaussianBlur(radius)), np.float32)
    out = rgba.copy(); out[..., :3] = np.clip(rgba[..., :3] + bb * strength, 0, 255)
    return out

# ---- invert ----
def invert(rgba):
    out = rgba.copy(); out[..., :3] = 255 - rgba[..., :3]; return out

# ---- solarize: invert tones above a threshold ----
def solarize(rgba, threshold=0.5):
    rgb = rgba[..., :3] / 255.0
    out = rgba.copy(); out[..., :3] = np.where(rgb > threshold, 1 - rgb, rgb) * 255.0
    return out

# ---- edge glow: glowing outline of the trail ----
def edgeglow(rgba, strength=1.6, radius=3, color=ACCENT):
    L = Image.fromarray((_luma(rgba[..., :3]) * 255).astype(np.uint8))
    e = np.asarray(L.filter(ImageFilter.FIND_EDGES).filter(ImageFilter.GaussianBlur(radius)), np.float32) / 255.0
    glow = np.empty_like(rgba[..., :3]); glow[:] = color
    out = rgba.copy()
    out[..., :3] = np.clip(rgba[..., :3] + glow * e[..., None] * strength, 0, 255)
    out[..., 3] = np.clip(np.maximum(rgba[..., 3], e), 0, 1)
    return out

# ---- zoom blur: radial blur toward a center ----
def zoomblur(rgba, amount=0.07, steps=8, cx=0.5, cy=0.5):
    H, W, _ = rgba.shape; yy, xx = np.indices((H, W))
    ccx, ccy = cx * W, cy * H
    acc = rgba.astype(np.float32).copy()
    for s in range(1, steps + 1):
        sc = 1 + amount * s / steps
        sx = np.clip(((xx - ccx) / sc + ccx).astype(np.int32), 0, W - 1)
        sy = np.clip(((yy - ccy) / sc + ccy).astype(np.int32), 0, H - 1)
        acc += rgba[sy, sx]
    return acc / (steps + 1)

# ---- halftone: dot screen on the trail (dot size by darkness) ----
def halftone(rgba, cell=6):
    H, W, _ = rgba.shape; yy, xx = np.indices((H, W))
    L = _luma(rgba[..., :3])
    cxx = (xx % cell) - (cell - 1) / 2.0; cyy = (yy % cell) - (cell - 1) / 2.0
    d = np.sqrt(cxx * cxx + cyy * cyy) / (cell * 0.62)
    on = ((1.0 - L) >= d).astype(np.float32)
    out = rgba.copy(); out[..., 3] = rgba[..., 3] * on
    return out

# ---- noise / film grain ----
def grain(rgba, amount=16, mono=True, seed=11):
    rng = np.random.RandomState(int(seed)); H, W, _ = rgba.shape
    n = rng.normal(0, amount, (H, W, 1) if mono else (H, W, 3)).astype(np.float32)
    out = rgba.copy(); out[..., :3] = np.clip(rgba[..., :3] + n, 0, 255)
    return out

REGISTRY = {"chroma": chroma, "crt": crt, "lumakey": lumakey, "wave": wave, "dither": dither, "sort": sort,
            "glitch": glitch, "posterize": posterize, "mirror": mirror, "displace": displace, "scanroll": scanline_roll,
            "bloom": bloom, "invert": invert, "solarize": solarize, "edgeglow": edgeglow, "zoomblur": zoomblur,
            "halftone": halftone, "grain": grain}

def apply_chain(rgba, chain):
    """chain: list of effect names (default params) or (name, params-dict) tuples."""
    for item in chain:
        name, params = (item, {}) if isinstance(item, str) else item
        f = REGISTRY.get(name)
        if f: rgba = f(rgba, **params)
    return rgba
