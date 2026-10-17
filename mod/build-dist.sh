#!/bin/bash
# Rebuilds the prebuilt plugin in mod/dist/ (used by install-windows.ps1 and as a fallback
# by install-mac.sh, so users don't need the .NET SDK). Run after changing the mod's code
# and commit the result. The DLL targets .NET Framework 4.7.2 and isn't platform-specific.
set -euo pipefail
cd "$(dirname "$0")"
DOTNET="$(command -v dotnet || echo "$HOME/.dotnet/dotnet")"
"$DOTNET" build TaleSpireMapExporter/TaleSpireMapExporter.csproj -c Release -nologo -v:q -p:DeployToGame=false
mkdir -p dist
cp TaleSpireMapExporter/bin/Release/net472/TaleSpireMapExporter.dll TaleSpireMapExporter/manifest.json dist/
echo "Updated mod/dist/ ($(grep -o '"version_number": "[^"]*"' dist/manifest.json))"
