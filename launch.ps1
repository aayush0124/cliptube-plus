$ErrorActionPreference = 'Stop'
$clipRoot = $PSScriptRoot
$clipRuntime = $env:CLIPTUBE_ELECTRON
if (-not $clipRuntime) {
    $clipNode = Get-Command node -ErrorAction SilentlyContinue
    if (-not $clipNode) {
        throw 'Node.js 22+ is required. Install Node.js, then run npm install in this application folder.'
    }
    Push-Location -LiteralPath $clipRoot
    try {
        $clipRuntime = & $clipNode.Source -e "process.stdout.write(require('electron'))"
        if ($LASTEXITCODE -ne 0 -or -not $clipRuntime) {
            throw 'Electron is missing. Run npm install in this application folder, or set CLIPTUBE_ELECTRON to your Electron executable.'
        }
    }
    finally { Pop-Location }
}
if (-not [System.IO.Path]::IsPathRooted($clipRuntime)) {
    $clipRuntime = Join-Path $clipRoot $clipRuntime
}
if (-not (Test-Path -LiteralPath $clipRuntime -PathType Leaf)) {
    throw 'The Electron executable was not found. Run npm install in this application folder, or check CLIPTUBE_ELECTRON.'
}
# Only this launcher process changes its child environment.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process -FilePath $clipRuntime -ArgumentList @('"' + $clipRoot + '"', '--disable-gpu') -WorkingDirectory $clipRoot -WindowStyle Hidden
