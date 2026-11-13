<#
.SYNOPSIS
  Registers (or with -Remove, removes) a scheduled task that runs sync_watch.ps1
  every few minutes while you are signed in, without a visible window. With the
  task in place, plugging the watch into this PC is the whole sync.
#>
param(
  [string]$Inbox = (Join-Path $PSScriptRoot "..\..\docker\local-windows\watch-inbox"),
  [int]$EveryMinutes = 3,
  [switch]$Remove
)
$ErrorActionPreference = "Stop"
$name = "YourOwnWeigh Watch Sync"
if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  "Removed '$name'."
  exit 0
}
$script = Join-Path $PSScriptRoot "sync_watch.ps1"
$Inbox = [System.IO.Path]::GetFullPath($Inbox)
# conhost --headless keeps PowerShell from flashing a window on every run.
$action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument (
  "--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`" -Inbox `"$Inbox`""
)
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Description "Copies new Garmin watch files into the YourOwnWeigh inbox ($Inbox)." -Force | Out-Null
"Registered '$name': every $EveryMinutes minutes, inbox $Inbox"
