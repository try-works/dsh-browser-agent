# Publishes @try-works/dsh-browser-agent to the public npm registry.
#
# Requires a fresh npm automation token in the transient token file (the
# default path matches this project's workflow; override with -TokenFile).
# The token is never stored in this repo: it is written to a local .npmrc
# for the duration of the command and removed in `finally`.
#
# Usage:
#   pwsh scripts/publish.ps1            # publish current version
#   pwsh scripts/publish.ps1 -CheckOnly  # verify token without publishing
#
# Exit codes: 0 success, 1 token invalid/missing, 2 publish failed.

param(
  [string]$TokenFile = 'C:\Users\erikb\OneDrive\Skrivbord\temp npm token.txt',
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

if (-not (Test-Path $TokenFile)) {
  Write-Error "Token file not found: $TokenFile — refresh it with a new npm automation token (publish access to @try-works)."
  exit 1
}

$token = (Get-Content $TokenFile -Raw).Trim()
if ($token.Length -lt 20) {
  Write-Error "Token file looks empty/truncated ($($token.Length) chars). Refresh it."
  exit 1
}

$npmrc = Join-Path (Get-Location) '.npmrc'
Set-Content -Path $npmrc -Value "//registry.npmjs.org/:_authToken=$token" -NoNewline -Encoding ascii

try {
  $who = (npm whoami 2>&1 | Out-String).Trim()
  if ($who -match 'npm error|E401|Unauthorized') {
    Write-Error "Token rejected by registry ($who). Refresh the token file and retry."
    exit 1
  }
  Write-Output "Authenticated as: $who"
  if ($CheckOnly) { Write-Output 'CheckOnly: not publishing.'; exit 0 }

  npm publish
  if ($LASTEXITCODE -ne 0) { exit 2 }
  Write-Output 'Published. Next: dsh plugin --profile web add @try-works/dsh-browser-agent'
} finally {
  if (Test-Path $npmrc) { Remove-Item $npmrc -Force }
}
