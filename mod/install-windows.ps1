<#
.SYNOPSIS
  Installs the TaleSpire Map Exporter mod on Windows: BepInEx (if needed) + the plugin.

.DESCRIPTION
  Easiest: double-click install-windows.bat next to this file.

  1. Finds TaleSpire in your Steam libraries (or use -GamePath).
  2. Installs BepInEx 5 (x64) into the game folder if it isn't there yet - downloaded from
     the official GitHub release and checksum-verified.
  3. Installs the plugin into BepInEx\plugins\TaleSpireMapExporter. Uses the prebuilt DLL in
     .\dist when present (no .NET SDK needed); otherwise, or with -Build, builds it from
     source with the dotnet CLI.

  Safe to run again (updates the plugin). On Windows no Steam launch option is needed -
  BepInEx loads automatically through winhttp.dll in the game folder.

.PARAMETER GamePath
  The TaleSpire folder (the one containing TaleSpire.exe), if it isn't found automatically.
.PARAMETER Build
  Build the plugin from source instead of using the prebuilt DLL.
.PARAMETER Uninstall
  Remove the plugin. Pass -RemoveBepInEx as well to remove BepInEx itself.

.EXAMPLE
  .\install-windows.ps1
  .\install-windows.ps1 -GamePath "D:\SteamLibrary\steamapps\common\TaleSpire"
  .\install-windows.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$GamePath,
  [switch]$Build,
  [switch]$Uninstall,
  [switch]$RemoveBepInEx
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 defaults to old TLS; GitHub needs 1.2.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$BepInExVersion = '5.4.23.5'
$BepInExZip     = "BepInEx_win_x64_$BepInExVersion.zip"
$BepInExUrl     = "https://github.com/BepInEx/BepInEx/releases/download/v$BepInExVersion/$BepInExZip"
$BepInExSha256  = '82f9878551030f54657792c0740d9d51a09500eeae1fba21106b0c441e6732c4'
$SteamAppId     = '720620'
$PluginName     = 'TaleSpireMapExporter'

function Write-Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "`n$text" -ForegroundColor Red; exit 1 }

# --- 1. Find TaleSpire --------------------------------------------------------------------

function Get-SteamLibraries {
  $roots = @()
  foreach ($key in 'HKCU:\Software\Valve\Steam', 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam', 'HKLM:\SOFTWARE\Valve\Steam') {
    $props = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
    if ($props) {
      if ($props.SteamPath)   { $roots += ($props.SteamPath -replace '/', '\') }
      if ($props.InstallPath) { $roots += $props.InstallPath }
    }
  }
  $roots += "${env:ProgramFiles(x86)}\Steam"
  $libraries = @()
  foreach ($root in ($roots | Select-Object -Unique)) {
    if (-not (Test-Path $root)) { continue }
    $libraries += $root
    # Extra library folders (other drives) are listed in libraryfolders.vdf.
    $vdf = Join-Path $root 'steamapps\libraryfolders.vdf'
    if (Test-Path $vdf) {
      foreach ($m in [regex]::Matches((Get-Content $vdf -Raw), '"path"\s+"([^"]+)"')) {
        $libraries += ($m.Groups[1].Value -replace '\\\\', '\')
      }
    }
  }
  return $libraries | Select-Object -Unique
}

function Find-TaleSpire {
  foreach ($lib in Get-SteamLibraries) {
    $candidate = Join-Path $lib 'steamapps\common\TaleSpire'
    if (Test-Path (Join-Path $candidate 'TaleSpire.exe')) { return $candidate }
  }
  return $null
}

if (-not $GamePath) { $GamePath = Find-TaleSpire }
if (-not $GamePath -or -not (Test-Path (Join-Path $GamePath 'TaleSpire.exe'))) {
  Fail ("Couldn't find TaleSpire. Run again with the game folder, e.g.:`n" +
        "  .\install-windows.ps1 -GamePath ""D:\SteamLibrary\steamapps\common\TaleSpire""`n" +
        "(Steam > right-click TaleSpire > Manage > Browse local files shows the folder.)")
}
$GamePath = (Resolve-Path $GamePath).Path
Write-Host "TaleSpire: $GamePath"

if (Get-Process -Name 'TaleSpire' -ErrorAction SilentlyContinue) {
  Fail 'TaleSpire is running. Close it first (its files are in use), then run this again.'
}

$PluginDir = Join-Path $GamePath "BepInEx\plugins\$PluginName"

# --- Uninstall ------------------------------------------------------------------------------

if ($Uninstall) {
  Write-Step 'Removing the plugin'
  if (Test-Path $PluginDir) { Remove-Item $PluginDir -Recurse -Force; Write-Host "Removed $PluginDir" }
  else { Write-Host 'Plugin not installed.' }
  if ($RemoveBepInEx) {
    Write-Step 'Removing BepInEx'
    foreach ($item in 'BepInEx', 'winhttp.dll', 'doorstop_config.ini', '.doorstop_version', 'changelog.txt') {
      $path = Join-Path $GamePath $item
      if (Test-Path $path) { Remove-Item $path -Recurse -Force; Write-Host "Removed $path" }
    }
  }
  Write-Host "`nDone." -ForegroundColor Green
  exit 0
}

# --- 2. BepInEx -----------------------------------------------------------------------------

Write-Step 'BepInEx'
if (Test-Path (Join-Path $GamePath 'BepInEx\core\BepInEx.dll')) {
  Write-Host 'Already installed - keeping it.'
} else {
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp $BepInExZip
    Write-Host "Downloading $BepInExZip ..."
    Invoke-WebRequest -Uri $BepInExUrl -OutFile $zip -UseBasicParsing
    $hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $BepInExSha256) { Fail "Checksum mismatch for $BepInExZip (got $hash). Not installing." }
    Expand-Archive -Path $zip -DestinationPath $GamePath -Force
    Write-Host "Installed BepInEx $BepInExVersion."
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# --- 3. Plugin ------------------------------------------------------------------------------

Write-Step 'TaleSpire Map Exporter plugin'
$dist = Join-Path $PSScriptRoot 'dist'
$prebuilt = Join-Path $dist "$PluginName.dll"

if ($Build -or -not (Test-Path $prebuilt)) {
  $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
  if (-not $dotnet) {
    Fail ("Building needs the .NET SDK: https://dotnet.microsoft.com/download`n" +
          "(or: winget install Microsoft.DotNet.SDK.8). Then run this again.")
  }
  $project = Join-Path $PSScriptRoot "$PluginName\$PluginName.csproj"
  Write-Host 'Building from source ...'
  & $dotnet.Source build $project -c Release -nologo -v:q "-p:TaleSpirePath=$GamePath" -p:DeployToGame=false
  if ($LASTEXITCODE -ne 0) { Fail 'Build failed (see above).' }
  $source = Join-Path $PSScriptRoot "$PluginName\bin\Release\net472"
} else {
  Write-Host 'Using the prebuilt plugin (no .NET SDK needed).'
  $source = $dist
}

New-Item -ItemType Directory -Path $PluginDir -Force | Out-Null
foreach ($file in "$PluginName.dll", 'manifest.json') {
  $from = Join-Path $source $file
  if (-not (Test-Path $from)) { Fail "Missing $from" }
  Copy-Item $from -Destination $PluginDir -Force
  # Files from a downloaded zip carry the "from the internet" mark; clear it.
  if (Get-Command Unblock-File -ErrorAction SilentlyContinue) {
    Unblock-File -Path (Join-Path $PluginDir $file)
  }
}
Write-Host "Installed to $PluginDir"

# --- Done -----------------------------------------------------------------------------------

$docs = [Environment]::GetFolderPath('MyDocuments')
Write-Host ''
Write-Host 'Done!' -ForegroundColor Green
Write-Host @"

  1. Start TaleSpire from Steam as usual (no launch options needed on Windows).
  2. Open a board and press Ctrl+Shift+E. A message at the top of the screen confirms the export.
     To export just part of the board, select it with TaleSpire's selection tool first.
  3. Exports are saved to: $docs\TaleSpireMapExporter

  Not working? Check $GamePath\BepInEx\LogOutput.log for
  "TaleSpire Map Exporter ... loaded". See docs\INSTALL.md for troubleshooting.

  Using r2modman / Thunderstore profiles? Those run BepInEx from the profile folder instead;
  copy BepInEx\plugins\$PluginName into the profile's BepInEx\plugins folder.
"@
