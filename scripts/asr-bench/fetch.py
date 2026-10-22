# 从 HF datasets-server 取真实录音片段，按时间顺序拼成连续音频（16k 单声道），同时写参考文本
import json, subprocess, sys, urllib.request, os, struct
API = "https://datasets-server.huggingface.co/rows?dataset={ds}&config={cfg}&split={sp}&offset={off}&length=100"
import time
def rows(ds, cfg, sp, off):
    for i in range(5):
        try:
            with urllib.request.urlopen(API.format(ds=ds, cfg=cfg, sp=sp, off=off), timeout=60) as r:
                return json.load(r)["rows"]
        except Exception as e:
            print("retry rows", off, e, file=sys.stderr); time.sleep(3 * (i + 1))
    return []
def pcm16k(url):
    raw = b""
    for i in range(4):
        try:
            raw = urllib.request.urlopen(url, timeout=60).read(); break
        except Exception as e:
            print("retry audio", e, file=sys.stderr); time.sleep(2 * (i + 1))
    if not raw: return b""
    p = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"], input=raw, capture_output=True)
    return p.stdout
def write_wav(path, pcm):
    with open(path, "wb") as f:
        f.write(b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, 16000, 32000, 2, 16) + b"data" + struct.pack("<I", len(pcm)) + pcm)
def build(name, items, target_s, gap_s=0.5):
    pcm = b""; refs = []; segs = []
    gap = b"\x00\x00" * int(16000 * gap_s)
    for text, url, lang in items:
        if len(pcm) / 32000 >= target_s: break
        a = pcm16k(url)
        if not a: continue
        start = len(pcm) / 32000
        pcm += a + gap
        refs.append(text); segs.append({"start": round(start, 2), "end": round(start + len(a) / 32000, 2), "text": text, "lang": lang})
    write_wav(f"data/{name}.wav", pcm)
    json.dump({"segments": segs, "text": " ".join(refs)}, open(f"data/{name}.json", "w"), ensure_ascii=False, indent=1)
    print(name, round(len(pcm) / 32000, 1), "s", len(segs), "segs")

which = sys.argv[1:]
if "ami" in which:
    # AMI 测试集一场会（各人头戴麦按时间排），跳过一两个词的附和
    rs = []
    for off in range(0, 1200, 100): rs += [r["row"] for r in rows("edinburghcstr/ami", "ihm", "test", off)]
    m = [r for r in rs if r["meeting_id"] == rs[0]["meeting_id"]]
    m.sort(key=lambda r: r["begin_time"])
    m = [r for r in m if len(r["text"].split()) >= 4]
    build("ami", [(r["text"], r["audio"][0]["src"], "en") for r in m], 180)
if "earnings" in which:
    rs = []
    for off in range(0, 600, 100): rs += [r["row"] for r in rows("distil-whisper/earnings22", "chunked", "test", off)]
    fid = rs[0]["file_id"]
    m = sorted([r for r in rs if r["file_id"] == fid], key=lambda r: r["start_ts"])
    build("earnings", [(r["transcription"], r["audio"][0]["src"], "en") for r in m], 180, gap_s=0.3)
if "ascend" in which:
    rs = []
    for off in range(0, 700, 100): rs += [r["row"] for r in rows("CAiRE/ASCEND", "main", "test", off)]
    rs = [r for r in rs if r["duration"] >= 2.0]
    zh = [r for r in rs if r["language"] == "zh"][:40]
    mixed = [r for r in rs if r["language"] == "mixed"][:40]
    build("ascend_zh", [(r["transcription"], r["audio"][0]["src"], "zh") for r in zh], 120)
    build("ascend_mix", [(r["transcription"], r["audio"][0]["src"], "mixed") for r in mixed], 120)
