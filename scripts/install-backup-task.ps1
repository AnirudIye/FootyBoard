# Register the nightly backup as a scheduled task. Run once, from an already
# elevated shell, on the deployment:
#
#     A:\FootyBoard\scripts\install-backup-task.ps1
#
# It exists so that registration is reproducible and self-checking, and so the
# task points at the tracked `scripts/backup.ps1` that arrives with a pull
# rather than at a loose file beside it. A fresh clone used to come up with a
# backup script and no way to know whether anything was scheduled to run it.
#
# **The comment that stood here said this existed "because the task did not",
# and that was false.** It cited a check across all 204 scheduled tasks finding
# nothing referencing backup.ps1, and concluded there had never been an
# automatic backup. Both halves were wrong, and the way they were wrong is the
# reason this paragraph is longer than the code it introduces:
#
#   A task had existed since 2026-08-01: \FootyBoardBackup, SYSTEM, daily at
#   04:00, already with StartWhenAvailable set. It ran. The 12:44 dump on
#   2026-08-02 is owned by NT AUTHORITY\SYSTEM, which is the scheduler catching
#   up the 04:00 run a sleeping machine missed.
#
#   The enumeration could not have found it. A task registered by an
#   administrator with a SYSTEM principal is invisible to an unelevated shell:
#   Get-ScheduledTask -TaskName reports no objects found, the full enumeration
#   omits it *silently* rather than erroring, and C:\Windows\System32\Tasks is
#   unlistable. "None of 204 tasks" was a measurement with one possible answer.
#
#   And "no dump at 04:00" was read as "no automatic run", when the whole point
#   of StartWhenAvailable is that a missed run lands at some other time.
#   Get-Acl on the dumps distinguishes a hand-run from a scheduled one in one
#   command, and it was available the entire time.
#
# So: verify this task from an elevated shell. If you are stuck in an unelevated
# one, Test-Path inside that unlistable directory is the only discriminator that
# works — a made-up name returns a clean $false, a real one returns access
# denied.
#
# -StartWhenAvailable is set because Task Scheduler's default is to *skip* a
# missed run rather than catch it up, so on a machine that is off or asleep at
# 04:00 the job never happens and says nothing about it. The predecessor task
# had this too; it is the reason there was a backup at all.
#
# -WakeToRun is deliberately NOT set. Waking a desktop at 04:00 to take a 36 KB
# dump is a worse trade than taking it at breakfast, and the site is down while
# the machine sleeps anyway, so nothing has changed in the meantime.
#
# The battery settings are left at the cmdlet's defaults, which are
# DisallowStartIfOnBatteries and StopIfGoingOnBatteries both true. Checked
# rather than assumed, and they match the predecessor task exactly; this host
# reports no battery device, so neither can bite. On a host that has one, both
# would need reconsidering.

[CmdletBinding()]
param(
    [string] $TaskName = 'FootyBoard nightly backup',
    [string] $At = '04:00'
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell: registering a LOCAL SYSTEM task needs administrator.'
}

$script = Join-Path $PSScriptRoot 'backup.ps1' | Resolve-Path
if (-not (Test-Path $script)) { throw "backup.ps1 not found beside this script at $script" }

# -NoProfile because SYSTEM has no profile worth loading and loading one is a
# way for this to start failing later for a reason that has nothing to do with
# backups. -ExecutionPolicy Bypass because the file is not signed.
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`""

$trigger = New-ScheduledTaskTrigger -Daily -At $At

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null

# Read it back rather than trusting the call. A registration that succeeded and
# a task that will actually catch up a missed run are two different claims, and
# this file exists because the second one was asserted without the first.
$task = Get-ScheduledTask -TaskName $TaskName
Write-Output ("Registered '{0}': state={1} startWhenAvailable={2} user={3} at={4}" -f `
    $task.TaskName, $task.State, $task.Settings.StartWhenAvailable, $task.Principal.UserId, $At)

if (-not $task.Settings.StartWhenAvailable) {
    throw 'StartWhenAvailable did not stick, which is the one setting this was for.'
}

Write-Output 'Run it once now to confirm, then check C:\FootyBoardBackups for a fresh dump:'
Write-Output ("    Start-ScheduledTask -TaskName '{0}'" -f $TaskName)
