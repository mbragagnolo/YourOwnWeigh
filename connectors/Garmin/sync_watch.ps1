<#
.SYNOPSIS
  Copies new health files from a USB-connected Garmin watch into the YourOwnWeigh
  watch inbox. The server imports them within a minute.

.DESCRIPTION
  Garmin watches such as the vivoactive 4 connect over MTP (no drive letter), so
  this uses the Windows Shell to read GARMIN\Monitor, Metrics, Activity and Sleep.
  Files already in the inbox are skipped unless their size changed (the watch
  keeps adding to the current day's file). Nothing on the watch is changed.
  Exits quietly when no watch is connected, so it can run on a schedule.

.PARAMETER Inbox
  Folder the server reads (bind-mounted as YOW_WATCH_INBOX).
#>
param(
  [string]$Inbox = (Join-Path $PSScriptRoot "..\..\docker\local-windows\watch-inbox")
)
$ErrorActionPreference = "Stop"
$Folders = "Monitor", "Metrics", "Activity", "Sleep"

# One run at a time: a scheduled run may start while a manual one is copying.
$mutex = New-Object System.Threading.Mutex($false, "Global\YourOwnWeighWatchSync")
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
  $Inbox = [System.IO.Path]::GetFullPath($Inbox)
  New-Item -ItemType Directory -Force $Inbox | Out-Null
  $log = Join-Path $Inbox "sync.log"
  function Log([string]$text) {
    Add-Content -Path $log -Value ("{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $text) -Encoding utf8
  }

  # Any portable device with a GARMIN folder on one of its storages.
  $shell = New-Object -ComObject Shell.Application
  $garmin = $null
  foreach ($device in @($shell.Namespace(17).Items())) {
    if ($device.Type -ne "Portable Device") { continue }
    foreach ($storage in @($device.GetFolder.Items())) {
      if (-not $storage.IsFolder) { continue }
      $found = @($storage.GetFolder.Items()) | Where-Object { $_.Name -eq "GARMIN" }
      if ($found) { $garmin = $found; $watchName = $device.Name; break }
    }
    if ($garmin) { break }
  }
  if (-not $garmin) { exit 0 }

  $staging = Join-Path $Inbox ".staging"
  New-Item -ItemType Directory -Force $staging | Out-Null
  $copied = 0
  foreach ($name in $Folders) {
    $source = @($garmin.GetFolder.Items()) | Where-Object { $_.Name -eq $name }
    if (-not $source) { continue }
    $target = Join-Path $Inbox $name
    New-Item -ItemType Directory -Force $target | Out-Null
    $items = @($source.GetFolder.Items()) | Where-Object { -not $_.IsFolder } | Sort-Object Name
    $newest = @($items | Select-Object -Last 2 | ForEach-Object { $_.Name })
    foreach ($item in $items) {
      $dest = Join-Path $target $item.Name
      $size = 0
      try { $size = [int64]$item.ExtendedProperty("System.Size") } catch { }
      if (-not $size) { try { $size = [int64]$item.Size } catch { } }
      if (Test-Path $dest) {
        $have = (Get-Item $dest).Length
        # With a size, recopy only on change; without one, recopy the newest
        # files, the only ones the watch still writes to.
        if ($size -and $size -eq $have) { continue }
        if (-not $size -and $newest -notcontains $item.Name) { continue }
      }
      # Copy to staging first so the server never reads a half-written file.
      $staged = Join-Path $staging $item.Name
      Remove-Item $staged -ErrorAction SilentlyContinue
      $shell.Namespace($staging).CopyHere($item, 0x14)
      $deadline = (Get-Date).AddSeconds(60)
      do {
        Start-Sleep -Milliseconds 250
        $ready = (Test-Path $staged) -and ((-not $size) -or (Get-Item $staged).Length -eq $size)
        if ($ready -and -not $size) {
          # Unknown size: wait until the length stops changing.
          $a = (Get-Item $staged).Length; Start-Sleep -Milliseconds 500
          $ready = $a -gt 0 -and $a -eq (Get-Item $staged).Length
        }
      } while (-not $ready -and (Get-Date) -lt $deadline)
      if (-not $ready) { Log "timed out copying $name\$($item.Name)"; continue }
      Move-Item -Force $staged $dest
      $copied++
    }
  }
  if ($copied) { Log "$watchName : copied $copied file(s)" }
}
catch {
  try { Log "error: $($_.Exception.Message)" } catch { }
  exit 1
}
finally {
  $mutex.ReleaseMutex()
}
