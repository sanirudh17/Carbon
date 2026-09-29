param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$NotesFile
)

# Writes the repo-root latest.json for the Tauri updater (Carbon v0.1.17+).
#
# CRITICAL: this file MUST be written as raw UTF-8 bytes WITHOUT a byte-order mark.
# The @tauri-apps/plugin-updater JSON decoder rejects a BOM with
# "error decoding response body". Do NOT use PowerShell `Set-Content -Encoding UTF8`
# here (always writes a BOM) and do NOT redirect `>` (writes the host console code page).
# [Text.UTF8Encoding]::new($false) is the only safe path on Windows.

$ErrorActionPreference = "Stop"

$sigPath = "src-tauri\target\release\bundle\nsis\Carbon_${Version}_x64-setup.exe.sig"
if (-not (Test-Path $sigPath)) {
    throw "Signature file not found: $sigPath"
}
$sig = (Get-Content $sigPath -Raw).Trim()
$notes = [IO.File]::ReadAllText((Resolve-Path $NotesFile).Path, [Text.UTF8Encoding]::new($false)).Trim()
$pub = ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))
$url = "https://github.com/sanirudh17/Carbon/releases/download/v$Version/Carbon_${Version}_x64-setup.exe"
$esc = { param($s) $s -replace '\\', '\\' -replace '"', '\"' -replace "`r`n", '\n' -replace "`n", '\n' }
$text = @"
{
  "platforms": {
    "windows-x86_64": {
      "signature": "$sig",
      "url": "$url"
    }
  },
  "pub_date": "$pub",
  "version": "$Version",
  "notes": "$(& $esc $notes)"
}
"@.TrimStart("`r", "`n")

$out = "latest.json"
[IO.File]::WriteAllText($out, $text, [Text.UTF8Encoding]::new($false))

# Self-check: assert BOM is absent. If you ever see this throw, the release
# pipeline regressed — do NOT upload the manifest until it's fixed.
$bytes = [IO.File]::ReadAllBytes($out)
if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    throw "BOM detected in $out - refusing to publish."
}
Write-Output "Wrote $out ($($bytes.Length) bytes, BOM-free)."
