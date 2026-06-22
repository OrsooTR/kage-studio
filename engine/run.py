"""
Kage Trails — pipeline orchestrator (called by the panel).
  python run.py --input <rendered.mov> --out <result.mp4> --config <config.json> --ffmpeg <ffmpeg> --tmp <dir> [--maxw N]
Steps: extract frames -> anime segmentation -> trails + FX chain -> encode (with audio).
Prints progress markers (FPS / FRAMES n / SEG i/n / TRAILS / ENCODE / DONE) on stdout.
"""
import argparse, json, os, glob, subprocess, sys
import numpy as np
from PIL import Image
import trails, fx  # noqa (fx used via trails)

def hex2rgb(h):
    h = (h or "#8b5cf6").lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--config", required=True)
    p.add_argument("--ffmpeg", default="ffmpeg")
    p.add_argument("--tmp", required=True)
    p.add_argument("--maxw", type=int, default=0)
    p.add_argument("--model", default="isnet-anime")
    a = p.parse_args()

    cfg = json.load(open(a.config, "r", encoding="utf-8-sig"))
    ffmpeg = a.ffmpeg
    fdir = os.path.dirname(ffmpeg)
    ffprobe = os.path.join(fdir, "ffprobe.exe") if fdir else "ffprobe"
    frames_dir = os.path.join(a.tmp, "frames"); mattes_dir = os.path.join(a.tmp, "mattes"); out_dir = os.path.join(a.tmp, "out")
    for d in (frames_dir, mattes_dir, out_dir):
        os.makedirs(d, exist_ok=True)

    # fps
    fps = 24.0
    try:
        r = subprocess.run([ffprobe, "-v", "0", "-of", "csv=p=0", "-select_streams", "v:0",
                            "-show_entries", "stream=r_frame_rate", a.input], capture_output=True, text=True)
        n, dn = r.stdout.strip().split("/"); fps = float(n) / float(dn)
    except Exception:
        pass
    print("FPS %.3f" % fps, flush=True)

    # extract
    vf = ["-vf", "scale=%d:-2" % a.maxw] if a.maxw > 0 else []
    subprocess.run([ffmpeg, "-y", "-i", a.input] + vf + ["-vsync", "0", os.path.join(frames_dir, "%08d.png")],
                   check=True, capture_output=True)
    files = sorted(glob.glob(os.path.join(frames_dir, "*.png")))
    print("FRAMES %d" % len(files), flush=True)
    if not files:
        print("ERROR no frames", flush=True); sys.exit(2)

    # segment
    from rembg import new_session, remove
    session = new_session(a.model)
    for i, fp in enumerate(files):
        m = remove(Image.open(fp).convert("RGB"), session=session, only_mask=True, post_process_mask=True)
        m.save(os.path.join(mattes_dir, os.path.basename(fp)))
        if i % 3 == 0 or i == len(files) - 1:
            print("SEG %d/%d" % (i + 1, len(files)), flush=True)

    # trails + fx
    print("TRAILS", flush=True)
    frames = [np.asarray(Image.open(p2).convert("RGB"), np.float32) for p2 in files]
    mattes = [np.asarray(Image.open(os.path.join(mattes_dir, os.path.basename(p2))).convert("L"), np.float32) / 255.0 for p2 in files]
    chain = [(f["name"], f.get("params", {})) for f in cfg.get("fx", [])]
    outs = trails.process(frames, mattes,
                          length=int(cfg.get("length", 16)), decay=float(cfg.get("decay", 0.82)),
                          spacing=int(cfg.get("spacing", 1)), opacity=float(cfg.get("opacity", 0.85)),
                          mode=cfg.get("mode", "shadow"), blur=float(cfg.get("blur", 2)),
                          position=cfg.get("position", "behind"), custom=hex2rgb(cfg.get("custom")), fx_chain=chain)
    for i, o in enumerate(outs):
        Image.fromarray(o).save(os.path.join(out_dir, "%08d.png" % i))

    # encode (carry the original audio if present)
    print("ENCODE", flush=True)
    subprocess.run([ffmpeg, "-y", "-framerate", str(fps), "-i", os.path.join(out_dir, "%08d.png"),
                    "-i", a.input, "-map", "0:v:0", "-map", "1:a:0?",
                    "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-shortest", a.out], check=True, capture_output=True)
    print("DONE " + a.out, flush=True)

if __name__ == "__main__":
    main()
