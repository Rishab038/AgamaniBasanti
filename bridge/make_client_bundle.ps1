# Builds the ready-to-send folder for the shop PC, with config.json
# already filled in - so the client runs install.bat and answers nothing.
#
# The secret is read from .env.adms at build time and written only into
# the output, which .gitignore excludes (*.zip and bridge-client/). That
# is deliberate: "remember to delete the key before pushing" is a step
# that gets forgotten exactly once, and git history keeps it forever.
# Here there is nothing to remember - the key never lands anywhere git
# is watching.
#
# Usage (from the repo root):
#     powershell -ExecutionPolicy Bypass -File bridge\make_client_bundle.ps1

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$bridge = Join-Path $repo "bridge"
$out = Join-Path $repo "bridge-client"
$zip = Join-Path $repo "agamani-attendance-setup.zip"

# ---- the secret -----------------------------------------------------
$envFile = Join-Path $repo ".env.adms"
if (-not (Test-Path $envFile)) { throw ".env.adms not found at $envFile" }

$secret = (Get-Content $envFile |
    Where-Object { $_ -match '^\s*ADMS_SHARED_SECRET\s*=' } |
    Select-Object -First 1) -replace '^\s*ADMS_SHARED_SECRET\s*=\s*', '' -replace '^["'']|["'']$', ''
$secret = $secret.Trim()
if ([string]::IsNullOrWhiteSpace($secret)) { throw "ADMS_SHARED_SECRET is empty in .env.adms" }

# ---- stage the files the shop PC needs ------------------------------
Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $out | Out-Null

# Everything except build litter, local state, and the example config
# (which would only confuse someone next to a real one).
$ship = @(
    "pyzk_bridge.py",
    "requirements.txt",
    "install.bat",
    "check_status.bat",
    "run_sync.vbs",
    "README.md"
)
foreach ($f in $ship) {
    $p = Join-Path $bridge $f
    if (-not (Test-Path $p)) { throw "missing file: $f" }
    Copy-Item $p $out
}

# ---- the pre-filled settings ----------------------------------------
$config = [ordered]@{
    device_ip     = ""                 # discovered on the shop network
    device_port   = 5005
    device_serial = "RGS2022036320"
    function_url  = "https://zhekzbooxkuosolubdjd.supabase.co/functions/v1/adms"
    shared_secret = $secret
    lookback_days = 10
}
$config | ConvertTo-Json | Set-Content (Join-Path $out "config.json") -Encoding utf8

# ---- zip it ---------------------------------------------------------
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path "$out\*" -DestinationPath $zip

# ---- confirm the key really is in there, and really is not in git ----
$masked = $secret.Substring(0, [Math]::Min(4, $secret.Length)) + "..." +
          $secret.Substring([Math]::Max(0, $secret.Length - 2))

Write-Output ""
Write-Output "  Built: $zip"
Write-Output "  Setup key baked in: $masked  (client types nothing)"
Write-Output ""

Push-Location $repo
$tracked = git check-ignore "bridge-client/config.json" 2>$null
Pop-Location
if ($tracked) {
    Write-Output "  Safe: the bundle and its key are excluded from git."
} else {
    Write-Warning "  The output is NOT gitignored - do not commit until fixed."
}
Write-Output ""
Write-Output "  Send the .zip to the client. It contains a password-equivalent"
Write-Output "  key, so send it the way you would send a password."
Write-Output ""
