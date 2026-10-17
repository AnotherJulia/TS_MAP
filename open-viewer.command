#!/bin/bash
# Double-click (macOS) to open the TaleSpire map viewer in your browser.
# Serves this folder on http://localhost:8765 (browsers won't run the viewer from file://).
# Close this Terminal window to stop it.
cd "$(dirname "$0")"
PORT=8765
URL="http://localhost:$PORT/viewer/"
if curl -s -o /dev/null "$URL"; then
  echo "Viewer already running at $URL"
  open "$URL"
  exit 0
fi
(sleep 1 && open "$URL") &
echo "TaleSpire map viewer: $URL"
echo "Leave this window open while you use the viewer. Close it to stop."
exec python3 -m http.server "$PORT" --bind 127.0.0.1
