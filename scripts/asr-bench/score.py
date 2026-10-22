# 汇总 out/*.json：英文算 WER（whisper 的英文归一化），中文和中英夹杂算 MER（汉字一个字一个单位、英文一个词一个单位）
import json, glob, os, re, sys
import jiwer
from whisper_normalizer.english import EnglishTextNormalizer
from whisper_normalizer.basic import BasicTextNormalizer

here = os.path.dirname(os.path.abspath(__file__))
en_norm = EnglishTextNormalizer()
basic = BasicTextNormalizer()
CJK = re.compile(r"[一-鿿]")

def mixed_tokens(s):
    s = s.replace("[UNK]", " ")
    s = basic(s).lower()
    out = []
    for w in s.split():
        buf = ""
        for ch in w:
            if CJK.match(ch):
                if buf: out.append(buf); buf = ""
                out.append(ch)
            else:
                buf += ch
        if buf: out.append(buf)
    return out

def score(dataset, hyp):
    ref = json.load(open(os.path.join(here, "data", f"{dataset}.json")))["text"]
    if dataset.startswith("ascend"):
        r, h = mixed_tokens(ref), mixed_tokens(hyp)
        return "MER", jiwer.wer(" ".join(r), " ".join(h) or "x")
    r, h = en_norm(ref), en_norm(hyp)
    return "WER", jiwer.wer(r, h or "x")

rows = []
for f in sorted(glob.glob(os.path.join(here, sys.argv[1] if len(sys.argv) > 1 else "out", "*.json"))):
    d = json.load(open(f))
    if d["dataset"] not in ("ami", "earnings", "ascend_zh", "ascend_mix"): continue
    kind, err = score(d["dataset"], d["hyp"])
    lat = d.get("tokenDelay") or d.get("finalLag") or {}
    rows.append((d["model"], d["dataset"], d["threads"], d.get("lang", ""), d.get("platform", ""), f"{kind} {err*100:5.1f}%", f"RTF {d['rtf']:.3f}", f"lag p50 {lat.get('p50','-')} p90 {lat.get('p90','-')}", f"load {d['loadMs']}ms", f"+{d['rssMB']}MB", f"redecode {d.get('redecodeMs','')}"))
for r in sorted(rows, key=lambda x: (x[1], x[0], x[2])):
    print(" | ".join(str(x) for x in r))
