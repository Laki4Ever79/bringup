#!/usr/bin/env bash
# Lays the Soniox voice lines (public/vo/<voice>/bN.wav) on the timeline from src/timing.json and muxes them into the
# rendered video. Usage: tools/mux.sh output/project.mp4 [voice=maya] [out=output/bringup.mp4]
set -euo pipefail
cd "$(dirname "$0")/.."
IN="$1"; VOICE="${2:-maya}"; OUT="${3:-output/bringup.mp4}"
mapfile -t PLACES < <(python3 - <<'PY'
import json
t, at = json.load(open('src/timing.json')), 0.0
for s in t['scenes']:
    for name, off in s['voice']:
        print(f"{name} {int((at + off) * 1000)}")
    at += s['length']
PY
)
args=(); filt=""; i=0
for p in "${PLACES[@]}"; do
  set -- $p
  args+=(-i "public/vo/$VOICE/$1.wav")
  filt+="[$((i+1)):a]adelay=$2|$2,aresample=48000[a$i];"
  i=$((i+1))
done
mix=""; for ((k=0;k<i;k++)); do mix+="[a$k]"; done
filt+="${mix}amix=inputs=$i:normalize=0,loudnorm=I=-16:TP=-1.5[vo]"
ffmpeg -v error -y -i "$IN" "${args[@]}" -filter_complex "$filt" -map 0:v -map "[vo]" -c:v copy -c:a aac -b:a 160k "$OUT"
echo "$OUT ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT") s)"
