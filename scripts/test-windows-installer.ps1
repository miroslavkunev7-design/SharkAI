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
  if ($env:SHARKAI_WINDOWS_TEST_COMMIT -cnotmatch '^[0-9a-f]{40}$') {
    throw 'Set SHARKAI_WINDOWS_TEST_COMMIT to the 40-character lowercase SHA of the staged candidate.'
  }
}

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$installer = (Resolve-Path "release/SharkAI-Setup-$version.exe").Path
$target = Join-Path $env:LOCALAPPDATA 'Programs\SharkAI Windows Smoke'
# Electron Builder rereads /D with StdUtils after choosing the per-user install mode.
$targetArgument = '"/D={0}"' -f $target
$executable = Join-Path $target 'SharkAI.exe'
$uninstaller = Join-Path $target 'Uninstall SharkAI.exe'
$runnerTemp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$legacyVersion = if ($Windows11Acceptance) { '1.0.1' } else { '1.0.0' }
$legacyFilename = "SharkAI-Setup-$legacyVersion.exe"
$previous = if ($Windows11Acceptance) { (Resolve-Path "release/legacy/$legacyFilename").Path } else { Join-Path $runnerTemp $legacyFilename }
$state = Join-Path $runnerTemp "SharkAI-windows-session-$([Guid]::NewGuid()).json"
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'SharkAI.lnk'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'SharkAI.lnk'
$profile = Join-Path $env:APPDATA 'SharkAI'
$marker = Join-Path $profile 'upgrade-smoke-marker.txt'
$registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
$setupHash = (Get-FileHash -Algorithm SHA256 $installer).Hash.ToLowerInvariant()
$setupBytes = (Get-Item $installer).Length
$sourceCommit = git rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $sourceCommit -cnotmatch '^[0-9a-f]{40}$') { throw 'The Windows test checkout must identify an exact source commit.' }
$signature = Get-AuthenticodeSignature -FilePath $installer
if ($signature.Status.ToString() -notin @('Valid', 'NotSigned')) {
  throw "The installer Authenticode check failed with $($signature.Status)."
}
if ($Windows11Acceptance) {
  $build = Get-Content release/windows-installer.json -Raw | ConvertFrom-Json
  if ($build.sha256 -ne $setupHash -or $build.sizeBytes -ne $setupBytes -or $build.version -ne $version -or
      $build.sourceCommit -cne $sourceCommit -or $sourceCommit -cne $env:SHARKAI_WINDOWS_TEST_COMMIT) {
    throw 'The downloaded installer does not match the Windows build metadata.'
  }
  $baseline = Get-Content release/legacy/windows-baseline.json -Raw | ConvertFrom-Json
  if ($baseline.sourceCommit -ne '6a0fa596dc6fe0a59f264993f3be89aeaed6b16a' -or
      $baseline.filename -ne $legacyFilename -or $baseline.version -ne $legacyVersion -or
      $baseline.sizeBytes -ne (Get-Item -LiteralPath $previous).Length -or
      $baseline.sha256 -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $previous).Hash.ToLowerInvariant()) {
    throw 'The downloaded staging baseline does not match its pinned source and build metadata.'
  }
}

function Invoke-Setup($Path, $Arguments) {
  $process = Start-Process -FilePath $Path -ArgumentList $Arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Setup or uninstall exited with $($process.ExitCode)." }
}

function Assert-NoAppProcesses {
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $remaining = Get-CimInstance Win32_Process -Filter "Name = 'SharkAI.exe'" | Where-Object { $_.ExecutablePath -eq $executable }
    if (!$remaining) { return }
    Start-Sleep -Milliseconds 250
  }
  throw 'SharkAI still has installed application processes after closing.'
}

function Invoke-Desktop($Mode) {
  node scripts/test-windows-desktop.cjs $executable $Mode $state
  if ($LASTEXITCODE -ne 0) { throw "Installed application check failed in $Mode mode." }
  Assert-NoAppProcesses
}

function Get-Registration {
  Get-ItemProperty $registry -ErrorAction SilentlyContinue | Where-Object {
    $_.DisplayName -like 'SharkAI*' -and $_.UninstallString -eq ('"' + $uninstaller + '" /currentuser')
  }
}

function Assert-Installed($ExpectedVersion) {
  if (!(Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'SharkAI.exe is missing from the requested installation directory containing spaces.' }
  if (!(Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'The uninstaller is missing from the requested installation directory containing spaces.' }
  $registered = Get-Registration
  if ($registered.DisplayVersion -ne $ExpectedVersion) { throw 'The expected per-user Windows uninstall registration is missing.' }
  $comShell = New-Object -ComObject WScript.Shell
  foreach ($link in @($shortcut, $desktopShortcut)) {
    if (!(Test-Path $link) -or $comShell.CreateShortcut($link).TargetPath -ne $executable) { throw 'A required Start Menu or desktop shortcut target is missing.' }
  }
}

function Assert-StartsFromShortcut {
  $client = Start-Process -FilePath $shortcut -PassThru
  if (!$client) { throw 'Windows did not start a process from the installed Start Menu shortcut.' }
  try {
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      $client.Refresh()
      if ($client.HasExited) { throw 'SharkAI exited before opening a window from the Start Menu shortcut.' }
      if ($client.Path -eq $executable -and $client.MainWindowHandle -ne [IntPtr]::Zero -and $client.MainWindowTitle -like '*SharkAI*') { break }
      Start-Sleep -Milliseconds 500
    }
    if ($attempt -ge 40) { throw 'The Start Menu shortcut did not open the installed SharkAI window.' }
    if (!$client.CloseMainWindow() -or !$client.WaitForExit(10000) -or $client.ExitCode -ne 0) {
      throw 'The SharkAI window opened from Start Menu did not close cleanly.'
    }
  } finally {
    if (!$client.HasExited -and $client.Path -eq $executable) { Stop-Process -Id $client.Id -Force }
  }
  Assert-NoAppProcesses
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

if (!$Windows11Acceptance) {
  Invoke-WebRequest 'https://github.com/miroslavkunev7-design/SharkAI/releases/download/v1.0.0/SharkAI-Setup-1.0.0.exe' -OutFile $previous
  if ((Get-FileHash -Algorithm SHA256 $previous).Hash.ToLowerInvariant() -ne '58de24e43683ec80781cbb7ac664b9f06fea8353c770cb68288e68dabb4b8150') {
    throw 'The previous version does not match the repository release asset.'
  }
}

try {
  if ($Windows11Acceptance) {
    Invoke-Setup $previous "/S /currentuser $targetArgument"
    Assert-Installed $legacyVersion
    Invoke-Desktop 'online-seed'
    Invoke-Desktop 'online-resume'
  } else {
    Invoke-Setup $installer "/S /currentuser $targetArgument"
    Assert-Installed $version
    Invoke-Desktop 'offline'
  }
  New-Item -ItemType Directory -Force -Path $profile | Out-Null
  Set-Content -LiteralPath $marker -Value 'retained'

  if (!$Windows11Acceptance) {
    Invoke-Setup $uninstaller '/S /currentuser'
    Assert-Uninstalled
    Invoke-Setup $previous "/S $targetArgument"
    if (!(Test-Path $executable)) { throw 'Previous version did not install.' }
  }

  Invoke-Setup $installer '/S /currentuser'
  Assert-Installed $version
  if ((Get-Content -LiteralPath $marker -Raw).Trim() -ne 'retained') { throw 'Upgrade discarded the existing profile.' }
  Invoke-Desktop 'offline'
  if ($Windows11Acceptance) {
    Assert-StartsFromShortcut
    Invoke-Desktop 'online-recover'
    Invoke-Desktop 'online-resume'
  }
  Invoke-Setup $uninstaller '/S /currentuser'
  Assert-Uninstalled
} finally {
  $temporaryFiles = @($marker, $state)
  if (!$Windows11Acceptance) { $temporaryFiles += $previous }
  foreach ($file in $temporaryFiles) {
    if (Test-Path $file) { Remove-Item -LiteralPath $file }
  }
}

$report = if ($Windows11Acceptance) { 'release/windows-client-acceptance.json' } else { 'release/windows-installer.json' }
[ordered]@{
  filename = [IO.Path]::GetFileName($installer)
  version = $version
  sourceCommit = $sourceCommit
  sizeBytes = $setupBytes
  sha256 = $setupHash
  signature = $signature.Status.ToString()
  os = $system.Caption
  osBuild = $system.BuildNumber
  architecture = 'x64'
  freshSetup = if ($Windows11Acceptance) { 'automated per-user setup of the staging baseline' } else { 'automated per-user setup of the candidate' }
  offlineStartup = 'passed'
  restartAndOccupiedPort = 'passed'
  previousVersion = $legacyVersion
  previousInstallerSha256 = if ($Windows11Acceptance) { $baseline.sha256 } else { '58de24e43683ec80781cbb7ac664b9f06fea8353c770cb68288e68dabb4b8150' }
  previousSourceCommit = if ($Windows11Acceptance) { $baseline.sourceCommit } else { $null }
  upgradeAndProfile = 'passed'
  uninstall = 'passed'
  standardWindows11Account = if ($Windows11Acceptance) { 'verified' } else { 'not checked' }
  stagedUltraLogin = if ($Windows11Acceptance) { 'passed' } else { 'not checked' }
  realChatAndRestart = if ($Windows11Acceptance) { 'passed' } else { 'not checked' }
  stagedSessionHistoryAndChatModeAfterDirectUpgrade = if ($Windows11Acceptance) { 'passed' } else { 'not checked' }
  startMenuLaunch = if ($Windows11Acceptance) { 'passed' } else { 'shortcut target checked' }
  offlineRetryRecovery = if ($Windows11Acceptance) { 'passed' } else { 'offline view checked' }
  interactiveWizard = 'awaiting manual verification'
} | ConvertTo-Json | Tee-Object -FilePath $report
