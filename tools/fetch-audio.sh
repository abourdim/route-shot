#!/usr/bin/env bash
# fetch-audio.sh — template for downloading curated free-audio tracks into
#                  audio/library/. This script ships WITHOUT baked-in URLs
#                  because Pixabay CDN paths rotate over time and hard-coded
#                  URLs break silently.
#
# Usage:
#   1. Visit https://pixabay.com/music/ (or the sources listed in
#      audio/library/README.md)
#   2. Click a track → Download button → note the resulting MP3 URL
#   3. Fill in the TRACKS array below (name + URL), then run this script.
#
# Or: just download tracks manually into audio/library/ — the dashboard will
# pick them up regardless of how they got there.

set -e
cd "$(dirname "$0")/.."
mkdir -p audio/library

# TRACKS: filled by the user with (name, URL) pairs. Name can be anything —
# it's just the filename the dashboard will show in the dropdown.
declare -A TRACKS=(
  # ["ambient-tech.mp3"]="https://cdn.pixabay.com/download/audio/…/ambient-tech.mp3"
  # ["upbeat-startup.mp3"]="https://cdn.pixabay.com/download/audio/…/upbeat.mp3"
  # ["cinematic-epic.mp3"]="https://cdn.pixabay.com/download/audio/…/cinematic.mp3"
  # ["chill-lofi.mp3"]="https://cdn.pixabay.com/download/audio/…/lofi.mp3"
  # ["cyberpunk-synth.mp3"]="https://cdn.pixabay.com/download/audio/…/cyberpunk.mp3"
  # ["space-ambient.mp3"]="https://cdn.pixabay.com/download/audio/…/space.mp3"
)

if [ ${#TRACKS[@]} -eq 0 ]; then
  cat <<EOF
No tracks configured yet. Edit this file and fill in the TRACKS array with
(filename, URL) pairs. See audio/library/README.md for recommended sources.

Quick alternative: just drop MP3 files into audio/library/ manually — the
dashboard picks them up regardless.
EOF
  exit 0
fi

for name in "${!TRACKS[@]}"; do
  dest="audio/library/$name"
  if [ -f "$dest" ]; then
    printf "  ✓ %s already present\n" "$name"
    continue
  fi
  printf "  → downloading %s …\n" "$name"
  if command -v curl >/dev/null 2>&1; then
    curl -L -o "$dest" "${TRACKS[$name]}"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$dest" "${TRACKS[$name]}"
  else
    printf "  ✗ no curl or wget on PATH\n"; exit 1
  fi
done

printf "\nDone. Reload the dashboard — the dropdown will show the new tracks.\n"
