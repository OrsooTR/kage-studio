"""
Kage Trails — engine prototype.
Leaves fading silhouettes of the moving subject along its path (shadow / accent / RGB echo / custom),
composited behind (or in front of) the live subject.

Pipeline use (later):  frames/ + mattes/  ->  out/
    python trails.py --frames F --mattes M --out O [params]
Look validation (now):
    python trails.py --demo --cover path/to/cover.jpg --out _demo_out
"""
import argparse, os, glob
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
import fx as trailfx

ACCENT = (139, 92, 246)

def _rgb(p): return np.asarray(Image.open(p).convert("RGB"), dtype=np.float32)
def _a(p):   return np.asarray(Image.open(p).convert("L"),   dtype=np.float32) / 255.0

def _over(bg, fg_rgb, fg_a):
    a = fg_a[..., None]
    return bg * (1 - a) + fg_rgb * a

def _over_rgba(dst, src_rgb, src_a):
    """Straight-alpha 'over' onto an RGBA layer (dst rgb 0..255, a 0..1)."""
    da = dst[..., 3]; sa = src_a
    oa = sa + da * (1 - sa)
    g = np.maximum(oa, 1e-6)
    orgb = (src_rgb * sa[..., None] + dst[..., :3] * (da * (1 - sa))[..., None]) / g[..., None]
    out = dst.copy(); out[..., :3] = orgb; out[..., 3] = oa
    return out

def _ghost_rgb(frame, mode, custom):
    h, w, _ = frame.shape
    if mode == "rgb":    return frame.copy()
    if mode == "accent": c = ACCENT
    elif mode == "custom": c = custom
    else:                c = (0, 0, 0)            # shadow
    out = np.empty((h, w, 3), np.float32); out[:] = c
    return out

def process(frames, mattes, length=14, decay=0.80, spacing=1, opacity=0.75,
            mode="shadow", blur=2.0, position="behind", custom=ACCENT, fx_chain=None):
    """frames: list[HxWx3 float], mattes: list[HxW float 0..1] -> list[HxWx3 uint8].
    Builds a separate trail RGBA layer, runs the FX chain on it, then composites."""
    n = len(frames); out_frames = []
    H, W = mattes[0].shape
    soft = []
    for m in mattes:
        if blur > 0:
            mi = Image.fromarray((np.clip(m, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(blur))
            soft.append(np.asarray(mi, np.float32) / 255.0)
        else:
            soft.append(m)
    for i in range(n):
        # 1) build the trail layer (RGBA), oldest -> newest
        trail = np.zeros((H, W, 4), np.float32)
        for k in range(length, 0, -1):
            j = i - k * spacing
            if j < 0: continue
            wgt = (decay ** k) * opacity
            if wgt < 0.012: continue
            trail = _over_rgba(trail, _ghost_rgb(frames[j], mode, custom), soft[j] * wgt)
        # 2) run the FX chain on the trails only
        if fx_chain:
            trail = trailfx.apply_chain(trail, fx_chain)
        # 3) composite: trails behind (or in front of) the crisp live subject
        out = frames[i].copy()
        live_rgb, live_a = frames[i], mattes[i]
        if position == "behind":
            out = _over(out, trail[..., :3], np.clip(trail[..., 3], 0, 1))
            out = _over(out, live_rgb, live_a)
        else:
            out = _over(out, live_rgb, live_a)
            out = _over(out, trail[..., :3], np.clip(trail[..., 3], 0, 1))
        out_frames.append(np.clip(out, 0, 255).astype(np.uint8))
    return out_frames

# ---------------- CLI / demo ----------------
def run_cli(a):
    fr = sorted(glob.glob(os.path.join(a.frames, "*.png")) + glob.glob(os.path.join(a.frames, "*.jpg")))
    mt = sorted(glob.glob(os.path.join(a.mattes, "*.png")))
    frames = [_rgb(p) for p in fr]; mattes = [_a(p) for p in mt]
    chain = [s.strip() for s in a.fx.split(",") if s.strip()]
    outs = process(frames, mattes, a.length, a.decay, a.spacing, a.opacity, a.mode, a.blur, a.position, ACCENT, chain)
    os.makedirs(a.out, exist_ok=True)
    for i, o in enumerate(outs): Image.fromarray(o).save(os.path.join(a.out, f"{i:05d}.png"))
    print(f"wrote {len(outs)} frames to {a.out}")

def make_demo(a):
    """Synthesize a moving anime subject (cover cut into an ellipse) over a dark bg, then run Trails."""
    W, H, N = 720, 440, 22
    cover = Image.open(a.cover).convert("RGB").resize((300, 300))
    cov = np.asarray(cover, np.float32)
    # ellipse mask for the subject
    em = Image.new("L", (300, 300), 0); ImageDraw.Draw(em).ellipse((30, 10, 270, 290), fill=255)
    em = np.asarray(em.filter(ImageFilter.GaussianBlur(3)), np.float32) / 255.0
    # background gradient
    bg = np.zeros((H, W, 3), np.float32)
    for y in range(H): bg[y, :] = (10 + y * 0.02, 8, 16 + y * 0.03)
    frames, mattes = [], []
    for i in range(N):
        t = i / (N - 1)
        cx = int(30 + t * (W - 360)); cy = int(40 + np.sin(t * 3.14159) * 80)   # arc path
        cx = max(0, min(W - 300, cx)); cy = max(0, min(H - 300, cy))             # keep fully in-frame
        frame = bg.copy(); matte = np.zeros((H, W), np.float32)
        sy, sx = cy, cx
        frame[sy:sy+300, sx:sx+300] = _over(frame[sy:sy+300, sx:sx+300], cov, em)
        matte[sy:sy+300, sx:sx+300] = em
        frames.append(frame); mattes.append(matte)
    os.makedirs(a.out, exist_ok=True)
    specs = [
        ("rgb", "RGB + bloom", ["bloom"]),
        ("accent", "Accent + edge-glow", ["edgeglow"]),
        ("rgb", "RGB + halftone + chroma", ["halftone", "chroma"]),
        ("rgb", "RGB + zoom-blur", ["zoomblur"]),
        ("accent", "Accent + solarize + scanroll", ["solarize", "scanroll"]),
        ("rgb", "RGB + grain + posterize", ["grain", "posterize"]),
    ]
    previews = []
    for k, (mode, label, chain) in enumerate(specs):
        outs = process(frames, mattes, length=16, decay=0.82, spacing=1, opacity=0.85, mode=mode, blur=2.5, fx_chain=chain)
        img = Image.fromarray(outs[-1]); ImageDraw.Draw(img).text((12, 10), "Kage Trails - " + label, fill=(255, 255, 255))
        img.save(os.path.join(a.out, f"demo_{k}.png")); previews.append(img)
    mon = Image.new("RGB", (W, H * len(previews) + 8 * (len(previews) - 1)), (8, 8, 12))
    for k, p in enumerate(previews): mon.paste(p, (0, k * (H + 8)))
    mon.save(os.path.join(a.out, "preview.png"))
    print("demo written to " + a.out + " (preview.png = 3 colour modes)")

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--frames"); p.add_argument("--mattes"); p.add_argument("--out", default="out")
    p.add_argument("--length", type=int, default=14); p.add_argument("--decay", type=float, default=0.80)
    p.add_argument("--spacing", type=int, default=1); p.add_argument("--opacity", type=float, default=0.75)
    p.add_argument("--mode", default="shadow", choices=["shadow", "accent", "rgb", "custom"])
    p.add_argument("--blur", type=float, default=2.0); p.add_argument("--position", default="behind", choices=["behind", "front"])
    p.add_argument("--fx", default="", help="comma-separated trail FX: chroma,crt,lumakey,wave,dither,sort,glitch,posterize,mirror,displace,scanroll")
    p.add_argument("--demo", action="store_true"); p.add_argument("--cover")
    a = p.parse_args()
    if a.demo: make_demo(a)
    else: run_cli(a)
