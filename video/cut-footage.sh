#!/usr/bin/env bash
# Cuts the dashboard footage (recorded by scripts/record-footage.ts in ../wt-board) into the clips the scenes use.
# Real time is never hidden: every cut lands on the dashboard's own clock or result line.
set -euo pipefail
SRC="${1:-../../wt-board/out/footage}"
OUT=public
mkdir -p "$OUT"
cut() { # name file start end
  ffmpeg -v error -y -ss "$3" -to "$4" -i "$SRC/$2" -an -r 30 -c:v libx264 -preset veryfast -crf 18 -g 10 -pix_fmt yuv420p "$OUT/$1.mp4"
  echo "$1.mp4  $2 $3–$4"
}
cut a1_hub     act-1.webm 0   9.2
cut a2_start   act-2.webm 2   16
cut a2_board   act-2.webm 63  69
cut a2_settle  act-2.webm 108 115.4
cut a3_type    act-3.webm 16  23
cut a3_ripple  act-3.webm 22  36
cut a3_settle  act-3.webm 62  76
cut a3_moved   act-3.webm 108 124.7
cut a4_proof   act-4.webm 0   10.8
# The dashboard's own fonts, so the cards match the footage.
mkdir -p "$OUT/fonts" && cp ../src/dashboard/fonts/*.woff "$OUT/fonts/"
