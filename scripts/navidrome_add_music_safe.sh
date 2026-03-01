#!/usr/bin/env bash
set -euo pipefail

# Safe add/import for Navidrome music library
# - Never edits media in-place
# - Always writes to temp file then atomic move
# - Preserves full duration (avoids truncated files)

MUSIC_ROOT="/home/songtaomocha/navidrome/music"

usage() {
  cat <<'EOF'
Usage:
  navidrome_add_music_safe.sh --src <source-file> --artist <artist> --album <album> --title <title> [--ext mp3|flac]

Example:
  navidrome_add_music_safe.sh \
    --src "/path/inbound/IU-Eight.mp3" \
    --artist "IU" \
    --album "Eight" \
    --title "Eight (Prod. & Feat. SUGA of BTS)"
EOF
}

SRC=""; ARTIST=""; ALBUM=""; TITLE=""; EXT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --src) SRC="$2"; shift 2 ;;
    --artist) ARTIST="$2"; shift 2 ;;
    --album) ALBUM="$2"; shift 2 ;;
    --title) TITLE="$2"; shift 2 ;;
    --ext) EXT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1"; usage; exit 1 ;;
  esac
done

[[ -f "$SRC" ]] || { echo "Source not found: $SRC"; exit 1; }
[[ -n "$ARTIST" && -n "$ALBUM" && -n "$TITLE" ]] || { usage; exit 1; }

if [[ -z "$EXT" ]]; then
  EXT="${SRC##*.}"
fi
EXT="${EXT,,}"
[[ "$EXT" == "mp3" || "$EXT" == "flac" ]] || { echo "Unsupported ext: $EXT"; exit 1; }

safe_name() {
  local s="$1"
  s="${s//\//-}"
  s="${s//$'\n'/ }"
  printf '%s' "$s"
}

ARTIST_DIR="$(safe_name "$ARTIST")"
ALBUM_DIR="$(safe_name "$ALBUM")"
TITLE_FILE="$(safe_name "$TITLE")"

DEST_DIR="$MUSIC_ROOT/$ARTIST_DIR/$ALBUM_DIR"
mkdir -p "$DEST_DIR"
DEST="$DEST_DIR/$ARTIST_DIR - $TITLE_FILE.$EXT"
TMP1="$DEST.__src__.$EXT"
TMP2="$DEST.__tagging__.$EXT"

cp -f "$SRC" "$TMP1"
chmod 644 "$TMP1"

# Tag in temp output (never input==output)
docker run --rm --entrypoint ffmpeg \
  -v "$MUSIC_ROOT":/music:rw \
  jrottenberg/ffmpeg:alpine \
  -i "/music/${TMP1#$MUSIC_ROOT/}" \
  -c copy \
  -metadata title="$TITLE" \
  -metadata artist="$ARTIST" \
  -metadata album_artist="$ARTIST" \
  -metadata album="$ALBUM" \
  -y "/music/${TMP2#$MUSIC_ROOT/}" >/dev/null 2>&1

mv -f "$TMP2" "$DEST"
rm -f "$TMP1"

# Quick duration sanity check
DUR_LINE=$(docker run --rm -v "$MUSIC_ROOT":/music:ro jrottenberg/ffmpeg:alpine -i "/music/${DEST#$MUSIC_ROOT/}" 2>&1 | grep -m1 Duration || true)
echo "Added: $DEST"
echo "Check: ${DUR_LINE:-Duration unavailable}"

echo "Done. Navidrome watcher should auto-scan in a few seconds."
