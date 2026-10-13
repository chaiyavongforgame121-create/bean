# Installs Bean Garden as a background app on this Windows PC (local only until YOU publish it).
#
#   1. registers the "BeanGarden" scheduled task: runs deploy\windows\start-bean.ps1 hidden at every logon
#   2. starts it now (the server listens on 127.0.0.1:8420 only)
#
# Publishing to the internet is a separate, deliberate step you run yourself:
#   & 'C:\Program Files\Tailscale\tailscale.exe' funnel --bg 8420
# (the first time, Tailscale asks you to enable Funnel for your tailnet in the browser). Stop publishing any time with
#   & 'C:\Program Files\Tailscale\tailscale.exe' funnel reset
#
# Undo everything with deploy\windows\uninstall.ps1. The PC must stay on and awake for the site to be reachable.
param([int]$Port = 8420)

$ErrorActionPreference = 'Stop'
$start = (Resolve-Path (Join-Path $PSScriptRoot 'start-bean.ps1')).Path

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$start`" -Port $Port"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName 'BeanGarden' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Bean Garden game server (accounts mode, 127.0.0.1:8420)' -Force | Out-Null
Start-ScheduledTask -TaskName 'BeanGarden'
Write-Output "scheduled task BeanGarden registered and started (local only: http://127.0.0.1:$Port)"
