$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$image = 'relay-tauri-check:latest'
$dockerfile = Join-Path $root 'docker\tauri-check.Dockerfile'
$envFile = Join-Path $env:TEMP 'relay-tauri-check.env'
[IO.File]::WriteAllText($envFile, 'TAURI_CONFIG={"bundle":{"resources":[]}}', (New-Object Text.UTF8Encoding($false)))
if (-not (docker image inspect $image 2>$null)) {
  docker build -f $dockerfile -t $image $root
}
try {
  docker run --rm --label "ao.session=$env:AO_SESSION_ID" `
    --env-file $envFile `
    -v "${root}:/workspace" `
    -v relay-cargo-registry:/usr/local/cargo/registry `
    -v relay-cargo-target:/workspace/src-tauri/target `
    -w /workspace/src-tauri `
    $image cargo check
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Remove-Item -LiteralPath $envFile -Force -ErrorAction SilentlyContinue
}