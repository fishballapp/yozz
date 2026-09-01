#!/usr/bin/env bash
# Builds apps/web/public/og.png from og-card.html. Run from projects/yozz.
#
# Two passes, because the card's layers want opposite treatment.
#
# The type is vector and the app screenshot is downscaled, so both come out cleaner rendered at 2x
# and resampled down: on the app's list rows the difference is plain, and the result is smaller
# too, since the downsample removes high-frequency noise PNG was paying to encode.
#
# envelope.png is the exception. It is already exactly 1200x630, so at 1x it maps one image pixel
# to one output pixel and its paper grain survives intact. Put it through the same 2x round trip
# and the grain averages away, which is the one thing the generated envelope is there for.
#
# So: render everything under the type at 2x and resample it down, composite the envelope at its
# native pixels over that, then lay the separately supersampled type on top.
set -euo pipefail

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CARD="$(cd "$(dirname "$0")" && pwd)/og-card.html"
OUT=apps/web/public/og.png
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

shot() { # shot <layer> <out> [extra chrome flags...]
  local layer=$1 out=$2; shift 2
  "$CHROME" --headless --disable-gpu --allow-file-access-from-files \
    --force-device-scale-factor=2 --window-size=1200,630 --hide-scrollbars \
    "$@" --screenshot="$out" "file://$CARD?layer=$layer" >/dev/null 2>&1
}

shot base "$TMP/base.png"
shot type "$TMP/type.png" --default-background-color=00000000

magick "$TMP/base.png" -filter Lanczos -resize 1200x630 "$TMP/base-1x.png"
magick "$TMP/type.png" -filter Lanczos -resize 1200x630 "$TMP/type-1x.png"

magick "$TMP/base-1x.png" assets/envelope.png -composite \
       "$TMP/type-1x.png" -composite "$OUT"

# Chrome writes 24-bit PNG and the paper grain costs ~300KB of it, over the ~300KB at which
# WhatsApp stops fetching a card. A palette takes it to ~80KB and, unlike JPEG at the same size,
# leaves the app's text crisp.
pngquant --quality 70-92 --speed 1 --strip --force --output "$OUT" "$OUT"
magick identify "$OUT"
