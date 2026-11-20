# Ejecutar desde PowerShell con Node.js y npm instalados.
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $project
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Falló la compilación.' }
    $version = (Get-Content -Raw -LiteralPath 'dist/manifest.json' | ConvertFrom-Json).version
    Copy-Item -LiteralPath 'README.md' -Destination 'dist/README.md'
    $distribution = @(
        'dist/manifest.json'
        'dist/background.js'
        'dist/content.js'
        'dist/content.js.LEGAL.txt'
        'dist/LICENSE'
        'dist/THIRD_PARTY_NOTICES.txt'
        'dist/SOURCE.txt'
        'dist/README.md'
        'dist/crl'
    )
    New-Item -ItemType Directory -Path 'release' -Force | Out-Null
    $name = "sgt-ver-firmas-v$version.zip"
    $archive = Join-Path 'release' $name
    Compress-Archive -LiteralPath $distribution -DestinationPath $archive -Force
    $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $name" | Set-Content -LiteralPath 'release/SHA256SUMS.txt' -Encoding ascii
    Get-Item -LiteralPath $archive
} finally {
    Pop-Location
}
