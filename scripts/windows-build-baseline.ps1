$ErrorActionPreference = 'Stop'
$legacyCommit = '6a0fa596dc6fe0a59f264993f3be89aeaed6b16a'
$legacyVersion = '1.0.1'
$origin = [Uri]$env:SHARKAI_WINDOWS_TEST_ORIGIN
if (!$origin -or !$origin.IsAbsoluteUri -or $origin.Scheme -ne 'https' -or $origin.UserInfo -or
    $origin.AbsolutePath -ne '/' -or $origin.Query -or $origin.Fragment -or
    $origin.Host -eq 'mm-auto-nadq-jeleva-s-projects.vercel.app') {
  throw 'The baseline installer requires the approved HTTPS staging origin.'
}
$workspace = (Get-Location).Path
$output = Join-Path $workspace 'release/legacy'
$temporary = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$checkout = Join-Path $temporary "SharkAI baseline $([Guid]::NewGuid())"
$installer = "SharkAI-Setup-$legacyVersion.exe"
$env:SHARKAI_DESKTOP_ORIGIN = $origin.GetLeftPart([UriPartial]::Authority)

git worktree add --detach $checkout $legacyCommit
if ($LASTEXITCODE -ne 0) { throw 'The pinned baseline source could not be checked out.' }
try {
  Push-Location $checkout
  try {
    if ((Get-Content package.json -Raw | ConvertFrom-Json).version -ne $legacyVersion) {
      throw 'The pinned baseline checkout does not declare the expected version.'
    }
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'The pinned baseline dependencies could not be installed.' }
    npm run electron:build
    if ($LASTEXITCODE -ne 0) { throw 'The pinned baseline installer did not build.' }
    $file = (Resolve-Path "release/$installer").Path
    New-Item -ItemType Directory -Force $output | Out-Null
    Copy-Item -LiteralPath $file -Destination (Join-Path $output $installer)
    [ordered]@{
      filename = $installer
      version = $legacyVersion
      sourceCommit = $legacyCommit
      sizeBytes = (Get-Item -LiteralPath $file).Length
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'windows-baseline.json')
  } finally {
    Pop-Location
  }
} finally {
  git worktree remove --force $checkout
}
