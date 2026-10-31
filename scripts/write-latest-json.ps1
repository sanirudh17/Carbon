param(
 [Parameter(Mandatory=$true)][string]$Version,
 [Parameter(Mandatory=$true)][string]$NotesFile,
 [string]$TargetDir = 'src-tauri/target'
)
$ErrorActionPreference='Stop'
$sigPath=Join-Path $TargetDir "release/bundle/nsis/Carbon_${Version}_x64-setup.exe.sig"
if (-not (Test-Path -LiteralPath $sigPath)) {throw 'Requested updater signature is missing.'}
$manifest=[ordered]@{
 version=$Version
 notes=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $NotesFile).Path,[Text.UTF8Encoding]::new($false)).Trim()
 pub_date=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
 platforms=@{'windows-x86_64'=@{
  signature=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $sigPath).Path).Trim()
  url="https://github.com/sanirudh17/Carbon/releases/download/v$Version/Carbon_${Version}_x64-setup.exe"
 }}
}
[IO.File]::WriteAllText((Join-Path (Get-Location) 'latest.json'),($manifest|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
$bytes=[IO.File]::ReadAllBytes((Join-Path (Get-Location) 'latest.json'))
if ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) {throw 'Updater manifest has a BOM.'}
Write-Output "Wrote latest.json for $Version (BOM-free UTF-8)."
