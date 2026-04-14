param(
  [ValidateSet('patch', 'minor', 'major')]
  [string] $Bump = 'patch',

  [switch] $DryRun,
  [switch] $SkipPush,
  [switch] $AllowDirty,
  [switch] $WithSourceDist
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$argList = @($Bump)
if ($DryRun) { $argList += '--dry-run' }
if ($SkipPush) { $argList += '--skip-push' }
if ($AllowDirty) { $argList += '--allow-dirty' }
if ($WithSourceDist) { $argList += '--with-source-dist' }

node scripts/release.js @argList
