# Bean Garden — production run on this Windows PC, published for free through Tailscale Funnel.
#
# Accounts mode (many players), REAL prices, PAPER trades, testnet OFF, sign-up CLOSED (the first admin signs up with
# the bootstrap code in data-prod\admin-bootstrap.txt). The server listens on 127.0.0.1 only; Tailscale Funnel is the
# only way in from the internet (https://<this-machine>.<tailnet>.ts.net → http://127.0.0.1:8420).
#
# Started at logon by the "BeanGarden" scheduled task (deploy\windows\install.ps1). Restarts the server if it exits.
param([int]$Port = 8420)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
$data = Join-Path $root 'data-prod'
$logs = Join-Path $data 'logs'
New-Item -ItemType Directory -Force -Path $data, $logs | Out-Null
$log = Join-Path $logs 'server.log'

function Write-Log([string]$line) {
  Add-Content -Path $log -Encoding UTF8 -Value ("[{0:u}] [launcher] {1}" -f (Get-Date), $line)
}

# The public origin is this machine's Tailscale name; wait for tailscaled after a reboot.
$dns = $null
for ($i = 0; $i -lt 60 -and -not $dns; $i++) {
  try { $dns = ((& $tailscale status --json | ConvertFrom-Json).Self.DNSName).TrimEnd('.') } catch { $dns = $null }
  if (-not $dns) { Start-Sleep -Seconds 5 }
}
if (-not $dns) { Write-Log 'Tailscale is not connected: cannot determine the public origin'; exit 1 }
$origin = "https://$dns"

$env:NODE_ENV = 'production'
$env:SIGNUP_MODE = 'closed'
$env:TESTNET_ENABLED = '0'
# tailscaled (on this machine) is the only proxy: trust its X-Forwarded-For for the visitor IP, and nothing else.
$env:TRUST_PROXY = '1'
$env:TRUSTED_PROXY_CIDRS = '127.0.0.1/32,::1/128'
$adminToken = Join-Path $root 'secrets\admin_token'
if (Test-Path $adminToken) { $env:ADMIN_TOKEN_FILE = $adminToken }

Set-Location $root
Write-Log "starting Bean Garden at $origin (port $Port, data $data)"
while ($true) {
  # Rotate the log at ~10 MB so a long run never fills the disk.
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 10MB) { Move-Item -Force $log "$log.1" }
  # cmd's redirection keeps node's UTF-8 bytes (Windows PowerShell 5.1's *>> would write UTF-16).
  & cmd.exe /d /c "node server/main.js --auth accounts --public-origin $origin --host 127.0.0.1 --port $Port --data `"$data`" >> `"$log`" 2>&1"
  Write-Log "server exited with code $LASTEXITCODE; restarting in 10 s"
  Start-Sleep -Seconds 10
}
