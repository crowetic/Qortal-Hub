param(
  [ValidateSet('unsigned', 'signed')][string]$Signing = 'unsigned',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
  $buildArgs = @('run', 'build:test-release', '--', '--platform', 'win', '--arch', 'x64', '--signing', $Signing)
  if ($DryRun) { $buildArgs += '--dry-run' }
  & npm.cmd @buildArgs
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
