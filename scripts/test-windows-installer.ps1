param([switch]$Windows11Acceptance)

$ErrorActionPreference = 'Stop'
$system = Get-CimInstance Win32_OperatingSystem
if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
  throw 'Run this installer verification on native Windows x64.'
}
if ($Windows11Acceptance) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ($system.ProductType -ne 1 -or [int]$system.BuildNumber -lt 22000) {
    throw 'Client acceptance requires a disposable Windows 11 x64 workstation or VM.'
  }
  if ($identity.Groups.Value -contains 'S-1-5-32-544') {
    throw 'Run the Windows 11 acceptance runner under a standard, non-administrator Windows account.'
  }
  if (!$env:SHARKAI_WINDOWS_TEST_ORIGIN -or !$env:SHARKAI_WINDOWS_TEST_EMAIL -or !$env:SHARKAI_WINDOWS_TEST_PASSWORD) {
    throw 'An authorized staging server and existing ULTRA test credentials are required for client acceptance.'
  }
}

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$installer = (Resolve-Path "release/SharkAI-Setup-$version.exe").Path
$target = Join-Path $env:LOCALAPPDATA 'Programs\SharkAI Windows Smoke'
$executable = Join-Path $target 'SharkAI.exe'
$uninstaller = Join-Path $target 'Uninstall SharkAI.exe'
$runnerTemp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$previous = Join-Path $runnerTemp 'SharkAI-Setup-1.0.0.exe'
$state = Join-Path $runnerTemp "SharkAI-windows-session-$([Guid]::NewGuid()).json"
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'SharkAI.lnk'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'SharkAI.lnk'
$profile = Join-Path $env:APPDATA 'SharkAI'
$marker = Join-Path $profile 'upgrade-smoke-marker.txt'
$registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
$setupHash = (Get-FileHash -Algorithm SHA256 $installer).Hash.ToLowerInvariant()
$setupBytes = (Get-Item $installer).Length
$signature = Get-AuthenticodeSignature -FilePath $installer
if ($signature.Status.ToString() -notin @('Valid', 'NotSigned')) {
  throw "The installer Authenticode check failed with $($signature.Status)."
}
if ($Windows11Acceptance) {
  $build = Get-Content release/windows-installer.json -Raw | ConvertFrom-Json
  if ($build.sha256 -ne $setupHash -or $build.sizeBytes -ne $setupBytes -or $build.version -ne $version) {
    throw 'The downloaded installer does not match the Windows build metadata.'
  }
}

function Invoke-Setup($Path, $Arguments) {
  $process = Start-Process -FilePath $Path -ArgumentList $Arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Setup or uninstall exited with $($process.ExitCode)." }
}

function Invoke-Desktop($Mode) {
  node scripts/test-windows-desktop.cjs $executable $Mode $state
  if ($LASTEXITCODE -ne 0) { throw "Installed application check failed in $Mode mode." }
}

function Get-Registration {
  Get-ItemProperty $registry -ErrorAction SilentlyContinue | Where-Object {
    $_.DisplayName -like 'SharkAI*' -and $_.UninstallString -eq ('"' + $uninstaller + '" /currentuser')
  }
}

function Assert-Installed {
  if (!(Test-Path $executable) -or !(Test-Path $uninstaller)) { throw 'Setup did not preserve the installation path containing spaces.' }
  $registered = Get-Registration
  if ($registered.DisplayVersion -ne $version) { throw 'The expected per-user Windows uninstall registration is missing.' }
  $comShell = New-Object -ComObject WScript.Shell
  foreach ($link in @($shortcut, $desktopShortcut)) {
    if (!(Test-Path $link) -or $comShell.CreateShortcut($link).TargetPath -ne $executable) { throw 'A required Start Menu or desktop shortcut target is missing.' }
  }
}

function Assert-Uninstalled {
  if ((Test-Path $executable) -or (Test-Path $shortcut) -or (Test-Path $desktopShortcut) -or (Get-Registration)) {
    throw 'Uninstall left the app, shortcuts or Windows registration behind.'
  }
  if ((Get-Content -LiteralPath $marker -Raw).Trim() -ne 'retained') { throw 'Uninstall removed the retained user settings.' }
}

if ((Test-Path $target) -or (Test-Path $shortcut) -or (Test-Path $desktopShortcut) -or (Test-Path $profile)) {
  throw 'Use a clean disposable Windows machine with no installed SharkAI or SharkAI profile.'
}

Invoke-WebRequest 'https://github.com/miroslavkunev7-design/SharkAI/releases/download/v1.0.0/SharkAI-Setup-1.0.0.exe' -OutFile $previous
if ((Get-FileHash -Algorithm SHA256 $previous).Hash.ToLowerInvariant() -ne '58de24e43683ec80781cbb7ac664b9f06fea8353c770cb68288e68dabb4b8150') {
  throw 'The previous version does not match the repository release asset.'
}

try {
  Invoke-Setup $installer "/S /currentuser /D=$target"
  Assert-Installed
  Invoke-Desktop 'offline'
  if ($Windows11Acceptance) {
    Invoke-Desktop 'online-new'
    Invoke-Desktop 'online-resume'
  }
  New-Item -ItemType Directory -Force -Path $profile | Out-Null
  Set-Content -LiteralPath $marker -Value 'retained'
  Invoke-Setup $uninstaller '/S /currentuser'
  Assert-Uninstalled

  Invoke-Setup $previous "/S /D=$target"
  if (!(Test-Path $executable)) { throw 'Previous version did not install.' }
  Invoke-Setup $installer '/S /currentuser'
  Assert-Installed
  if ((Get-Content -LiteralPath $marker -Raw).Trim() -ne 'retained') { throw 'Upgrade discarded the existing profile.' }
  if ($Windows11Acceptance) { Invoke-Desktop 'online-resume' } else { Invoke-Desktop 'offline' }
  Invoke-Setup $uninstaller '/S /currentuser'
  Assert-Uninstalled
} finally {
  foreach ($file in @($marker, $state, $previous)) {
    if (Test-Path $file) { Remove-Item -LiteralPath $file }
  }
}

$report = if ($Windows11Acceptance) { 'release/windows-client-acceptance.json' } else { 'release/windows-installer.json' }
[ordered]@{
  filename = [IO.Path]::GetFileName($installer)
  version = $version
  sizeBytes = $setupBytes
  sha256 = $setupHash
  signature = $signature.Status.ToString()
  os = $system.Caption
  osBuild = $system.BuildNumber
  architecture = 'x64'
  freshSetup = 'automated per-user setup'
  offlineStartup = 'passed'
  restartAndOccupiedPort = 'passed'
  previousVersion = '1.0.0'
  upgradeAndProfile = 'passed'
  uninstall = 'passed'
  standardWindows11Account = if ($Windows11Acceptance) { 'verified' } else { 'not checked' }
  stagedUltraLogin = if ($Windows11Acceptance) { 'passed' } else { 'not checked' }
  realChatAndRestart = if ($Windows11Acceptance) { 'passed' } else { 'not checked' }
  stagedSessionAfterInstallUpgrade = if ($Windows11Acceptance) { 'passed' } else { 'not checked' }
  interactiveWizard = 'awaiting manual verification'
} | ConvertTo-Json | Tee-Object -FilePath $report
