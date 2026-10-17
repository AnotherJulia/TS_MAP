#!/bin/bash
# Installs BepInEx (if needed) into the native macOS TaleSpire build, then builds and deploys
# the TaleSpireMapExporter plugin into it. Safe to re-run: it skips BepInEx if it's already
# there and just rebuilds/redeploys the plugin.
#
# Usage: mod/install-mac.sh [path to the Steam "TaleSpire" folder]
set -euo pipefail

GAME_DIR="${1:-$HOME/Library/Application Support/Steam/steamapps/common/TaleSpire}"
BEPINEX_VERSION="5.4.23.5"
BEPINEX_ZIP="BepInEx_macos_universal_${BEPINEX_VERSION}.zip"
BEPINEX_URL="https://github.com/BepInEx/BepInEx/releases/download/v${BEPINEX_VERSION}/${BEPINEX_ZIP}"
BEPINEX_SHA256="01c2ae782eb016dfd6c345a18dbd2dcafffb3d9d318449d6486689f426b4a323"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$GAME_DIR/TaleSpire.app" ]; then
  echo "TaleSpire.app not found in: $GAME_DIR" >&2
  echo "Pass the folder that contains TaleSpire.app (Steam > TaleSpire > Manage > Browse local files)." >&2
  exit 1
fi

# --- 1. BepInEx -----------------------------------------------------------------------------
if [ -f "$GAME_DIR/BepInEx/core/BepInEx.dll" ]; then
  echo "BepInEx already installed in $GAME_DIR"
else
  echo "Installing BepInEx $BEPINEX_VERSION into $GAME_DIR ..."
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL -o "$TMP/$BEPINEX_ZIP" "$BEPINEX_URL"
  echo "$BEPINEX_SHA256  $TMP/$BEPINEX_ZIP" | shasum -a 256 -c -
  unzip -q "$TMP/$BEPINEX_ZIP" -d "$GAME_DIR"
fi

# run_bepinex.sh needs to know which .app to launch.
sed -i '' 's/^executable_name=""$/executable_name="TaleSpire.app"/' "$GAME_DIR/run_bepinex.sh"
# BepInEx 5's MonoMod can't detour on Apple Silicon (arm64): the preloader dies with a
# NullReferenceException in DetourHelper.GetIdentifiable before any plugin loads. TaleSpire is a
# universal binary, so launch it as x86_64 under Rosetta instead, where MonoMod works.
sed -i '' \
  -e 's/export ARCHPREFERENCE="arm64,x86_64"/export ARCHPREFERENCE="x86_64"/' \
  -e 's/exec arch -e DYLD_INSERT_LIBRARIES=/exec arch -x86_64 -e DYLD_INSERT_LIBRARIES=/' \
  "$GAME_DIR/run_bepinex.sh"
chmod +x "$GAME_DIR/run_bepinex.sh"
xattr -dr com.apple.quarantine "$GAME_DIR/libdoorstop.dylib" "$GAME_DIR/BepInEx" 2>/dev/null || true

# --- 2. Build + deploy the plugin -------------------------------------------------------------
DOTNET="$(command -v dotnet || true)"
if [ -z "$DOTNET" ] && [ -x "$HOME/.dotnet/dotnet" ]; then
  DOTNET="$HOME/.dotnet/dotnet"
  export DOTNET_ROOT="$HOME/.dotnet"
fi
if [ -z "$DOTNET" ]; then
  echo "The .NET SDK is needed to build the plugin. Install it with either:" >&2
  echo "  brew install --cask dotnet-sdk" >&2
  echo "  curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel LTS" >&2
  exit 1
fi

"$DOTNET" build "$SCRIPT_DIR/TaleSpireMapExporter/TaleSpireMapExporter.csproj" -c Release \
  -p:TaleSpirePath="$GAME_DIR" -nologo -v:q

# --- 3. Steam launch option ---------------------------------------------------------------
cat <<EOF

Done. One manual step left (only needed once):

  Steam > right-click TaleSpire > Properties > General > Launch Options, paste:

    "$GAME_DIR/run_bepinex.sh" %command%

Then launch TaleSpire from Steam as usual. To confirm the mod loaded, look for
"TaleSpire Map Exporter" in:
    $GAME_DIR/BepInEx/LogOutput.log
EOF
