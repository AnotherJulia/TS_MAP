#!/bin/bash
# Assembles one platform's release bundle: install guide + mod installer + viewer installer,
# zipped. Used by .github/workflows/release.yml; also runs locally.
#
#   release/package.sh <macos|windows> <viewer installer (.dmg/.exe)> <version> [out dir]
set -euo pipefail

PLATFORM="$1"
APP="$2"
VERSION="$3"
OUT="${4:-release/out}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

case "$PLATFORM" in
  macos) LABEL="macOS" ;;
  windows) LABEL="Windows" ;;
  *) echo "platform must be macos or windows" >&2; exit 1 ;;
esac

NAME="TaleSpire-Map-Tools-$LABEL-v$VERSION"
STAGE="$OUT/$NAME"
# The app installs the mod itself ("Install TaleSpire mod"); the scripts are a fallback.
VIEWER="$STAGE/1 - Viewer app"
MOD="$STAGE/Manual mod install (optional)"
rm -rf "$STAGE" "$OUT/$NAME.zip"
mkdir -p "$MOD/dist" "$VIEWER"

cp "$ROOT/mod/dist/TaleSpireMapExporter.dll" "$ROOT/mod/dist/manifest.json" "$MOD/dist/"
cp "$APP" "$VIEWER/"

if [ "$PLATFORM" = macos ]; then
  cp "$ROOT/release/how-to-install-macos.html" "$STAGE/How to install.html"
  cp "$ROOT/mod/install-mac.sh" "$MOD/install-mac.sh"
  cat > "$MOD/Install mod.command" <<'CMD'
#!/bin/bash
# Installs the TaleSpire Map Exporter mod (BepInEx + plugin).
# Not notarized: if macOS blocks it, use System Settings > Privacy & Security > Open Anyway,
# or run `bash install-mac.sh` in Terminal instead.
cd "$(dirname "$0")"
bash ./install-mac.sh
echo
read -n 1 -s -r -p "Press any key to close this window."
CMD
  chmod +x "$MOD/Install mod.command" "$MOD/install-mac.sh"
else
  cp "$ROOT/release/how-to-install-windows.html" "$STAGE/How to install.html"
  cp "$ROOT/mod/install-windows.ps1" "$MOD/install-windows.ps1"
  cp "$ROOT/mod/install-windows.bat" "$MOD/Install mod.bat"
  # cmd.exe needs CRLF; normalise in case this runs from an LF checkout.
  for f in "$MOD/Install mod.bat" "$MOD/install-windows.ps1"; do
    perl -pi -e 's/\r?\n/\r\n/' "$f"
  done
fi

(cd "$OUT" && zip -qry "$NAME.zip" "$NAME")
echo "$OUT/$NAME.zip"
