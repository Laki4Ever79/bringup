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
# Times from shots.md of the 31 Oct re-recording (legible tiles).
cut a1_hub     act-1.webm 0   8.9
cut a2_start   act-2.webm 0   14
cut a2_board   act-2.webm 34  40
cut a2_settle  act-2.webm 69  76
cut a3_type    act-3.webm 17  21   # starts on the typing, after the earlier automatic change
cut a3_ripple  act-3.webm 21  58   # the whole ripple in real time: typed → consistent again in 31 s
cut a3_moved   act-3.webm 59  72.7
cut a4_proof   act-4.webm 0   10.8
# The dashboard's own fonts, so the cards match the footage.
mkdir -p "$OUT/fonts" && cp ../src/dashboard/fonts/*.woff "$OUT/fonts/"
