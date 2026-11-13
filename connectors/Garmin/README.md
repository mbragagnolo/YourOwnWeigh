# Garmin Watch (USB)

Imports resting heart rate, steps, stress, VO2 max and workouts from a Garmin
watch's own FIT files. No Garmin account or cloud is involved. Tested with a
vívoactive 4; other Garmin watches that connect over USB as a portable (MTP)
device store the same files.

## How it works

1. `sync_watch.ps1` finds the watch over USB and copies new files from
   `GARMIN\Monitor`, `Metrics`, `Activity` and `Sleep` into the watch inbox.
   It never changes anything on the watch.
2. The server reads the inbox (`YOW_WATCH_INBOX`) every minute and imports each
   file once. Imports are idempotent: today's monitoring file grows all day and
   is simply imported again.
3. On the **Goals** page, link the watch to a user. Resting heart rate, steps
   and VO2 max then appear next to the scale's measures and can have targets.

The inbox is also the archive: the watch deletes its own files after a few
weeks, while the inbox keeps them, so the database can be rebuilt from it.
Watch data is not part of household backups.

## Setup (Windows, local Docker)

The local compose file already mounts `docker/local-windows/watch-inbox`. Then,
in PowerShell from the repository root:

```powershell
.\connectors\Garmin\install_sync_task.ps1
```

This registers a task that checks for the watch every 3 minutes while you are
signed in, without opening a window. Plug the watch in and the data arrives on
the dashboard within a few minutes. To sync by hand instead, run
`.\connectors\Garmin\sync_watch.ps1`. Remove the task with
`install_sync_task.ps1 -Remove`. The script logs to `watch-inbox\sync.log`.

## Notes

- Days follow the watch's clock. A watch that has not synced with a phone for a
  long time may still be on an old time zone.
- Steps and resting heart rate for a day are the watch's own totals; the
  current day's steps are left out of averages until the day is over.
- Sleep files are copied but not imported yet: the vívoactive 4's sleep stages
  do not decode reliably.
