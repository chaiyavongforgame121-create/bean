# Stops publishing Bean Garden and removes the background task. Data in data-prod\ is kept.
$ErrorActionPreference = 'Continue'
& 'C:\Program Files\Tailscale\tailscale.exe' funnel reset
Stop-ScheduledTask -TaskName 'BeanGarden' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'BeanGarden' -Confirm:$false -ErrorAction SilentlyContinue
# The launcher loop runs node as a child process: stop the server listening on the port too.
$owner = (Get-NetTCPConnection -LocalPort 8420 -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($owner) { Stop-Process -Id $owner -Force }
Write-Output 'Bean Garden unpublished and stopped (data-prod kept)'
