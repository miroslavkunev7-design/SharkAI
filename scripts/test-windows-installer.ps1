$ErrorActionPreference = 'Stop'
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$installer = (Resolve-Path "release/SharkAI-Setup-$version.exe").Path
$target = Join-Path $env:LOCALAPPDATA 'Programs\SharkAI Windows Smoke'
$executable = Join-Path $target 'SharkAI.exe'
$uninstaller = Join-Path $target 'Uninstall SharkAI.exe'
$previous = Join-Path $env:RUNNER_TEMP 'SharkAI-Setup-1.0.0.exe'
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'SharkAI.lnk'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'SharkAI.lnk'
$profile = Join-Path $env:APPDATA 'SharkAI'
$marker = Join-Path $profile 'upgrade-smoke-marker.txt'

function Invoke-Setup($Path, $Arguments) {
  $process = Start-Process -FilePath $Path -ArgumentList $Arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "$Path exited with $($process.ExitCode)" }
}

if ((Test-Path $target) -or (Test-Path $shortcut) -or (Test-Path $marker)) {
  throw 'Run this smoke test on a clean disposable Windows runner.'
}
Invoke-WebRequest 'https://github.com/miroslavkunev7-design/SharkAI/releases/download/v1.0.0/SharkAI-Setup-1.0.0.exe' -OutFile $previous
try {
  Invoke-Setup $previous "/S /D=$target"
  if (-not (Test-Path $executable)) { throw 'Previous version did not install.' }
  New-Item -ItemType Directory -Force -Path $profile | Out-Null
  Set-Content -LiteralPath $marker -Value 'retained'
  Invoke-Setup $installer '/S /currentuser'
  if (-not (Test-Path $executable) -or -not (Test-Path $uninstaller)) { throw 'Upgrade did not preserve the install location.' }
  if ((Get-Content -LiteralPath $marker -Raw).Trim() -ne 'retained') { throw 'Upgrade discarded the existing profile.' }
  if (-not (Test-Path $shortcut) -or -not (Test-Path $desktopShortcut)) { throw 'Expected shortcuts missing.' }
  node scripts/test-windows-desktop.cjs $executable
  if ($LASTEXITCODE -ne 0) { throw 'Installed application startup checks failed.' }
  Invoke-Setup $uninstaller '/S /currentuser'
  if ((Test-Path $executable) -or (Test-Path $shortcut) -or (Test-Path $desktopShortcut)) { throw 'Uninstall left the app or its shortcuts behind.' }
  if (-not (Test-Path $marker)) { throw 'Uninstall removed the retained user data.' }
} finally {
  if (Test-Path $marker) { Remove-Item -LiteralPath $marker }
}

$signature = Get-AuthenticodeSignature -FilePath $installer
$system = Get-CimInstance Win32_OperatingSystem
[ordered]@{
  filename = [IO.Path]::GetFileName($installer)
  version = $version
  sizeBytes = (Get-Item $installer).Length
  sha256 = (Get-FileHash -Algorithm SHA256 $installer).Hash.ToLowerInvariant()
  signature = $signature.Status.ToString()
  os = $system.Caption
  osBuild = $system.BuildNumber
  architecture = 'x64'
} | ConvertTo-Json | Tee-Object -FilePath release/windows-installer.json
