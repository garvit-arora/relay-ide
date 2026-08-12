param(
  [switch]$SkipInstall,
  [switch]$SkipCompile
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vscode = Join-Path $root 'vendor\vscode'
$commit = '8b5471c4c8639e9fd142ce9931ffedc1a56c5ba4'

if (-not (Test-Path (Join-Path $vscode '.git'))) {
  git -C $root submodule update --init --depth 1 vendor/vscode
}

git -C $vscode fetch --depth 1 origin $commit
git -C $vscode checkout --detach $commit
git -C $vscode reset --hard $commit
git -C $vscode clean -fd -e node_modules -e .build

git -C $vscode apply (Join-Path $root 'vscode-relay.patch')

if (-not $SkipInstall) {
  Push-Location $vscode
  try {
    npm install --ignore-scripts --legacy-peer-deps
    $env:npm_config_ignore_scripts = 'true'
    npm run postinstall
    Remove-Item Env:npm_config_ignore_scripts -ErrorAction SilentlyContinue
    npm run gulp node
  } finally {
    Remove-Item Env:npm_config_ignore_scripts -ErrorAction SilentlyContinue
    Pop-Location
  }
}

if (-not $SkipCompile) {
  Push-Location $vscode
  try {
    npm run compile-client
    npm run compile-web
  } finally { Pop-Location }
}

Write-Host 'Code-OSS is ready for Relay.' -ForegroundColor Green