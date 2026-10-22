#!/bin/bash
# 用法：get.sh <asset 名（不带 .tar.bz2）>...  下载、解压、删压缩包
cd "$(dirname "$0")/models"
B=https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models
for n in "$@"; do
  [ -d "$n" ] && { echo "have $n"; continue; }
  curl -sSL --retry 3 -o "$n.tar.bz2" "$B/$n.tar.bz2" && tar xjf "$n.tar.bz2" && rm -f "$n.tar.bz2" && echo "got $n $(du -sh "$n" | cut -f1)"
done
