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
# Times from shots.md of the final re-recording (frozen design; beacon brief → "add a temperature/humidity sensor").
cut a1_hub     act-1.webm 0     16    # the hub, then the scroll to the evidence band (register folded)
cut a2_start   act-2.webm 0     11
cut a2_settle  act-2.webm 148   159   # "First design consistent" at 2:33
cut a3_type    act-3.webm 2     7
cut a3_rip_a   act-3.webm 7     27    # 7 of 9 wake, mismatches appear, the case cuts its vent (+12 s)
cut a3_rip_b   act-3.webm 216   230   # the banner at 3:41 (the waiting between is cut; the clock on screen is real)
cut a3_case    act-3.webm 239   248   # the new vent grille in 3D
cut a3_pcb     act-3.webm 268   277   # U2 glows NEW, U1 CHANGED
cut a4_proof   act-4.webm 0     10.8
# The dashboard's own fonts, so the cards match the footage.
mkdir -p "$OUT/fonts" && cp ../src/dashboard/fonts/*.woff "$OUT/fonts/"
