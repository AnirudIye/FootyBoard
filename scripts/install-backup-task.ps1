# Register the nightly backup as a scheduled task. Run once, elevated.
#
#     powershell -ExecutionPolicy Bypass -File .\scripts\install-backup-task.ps1
#
# **This exists because the task did not.** handoff.md recorded the backup as
# "nightly at 04:00 as SYSTEM" from 2026-08-01. Checked on 2026-08-02 against
# all 204 scheduled tasks on the deployment: not one of them referenced
# `backup.ps1` or FootyBoard, and `C:\FootyBoardBackups` held two dumps, at
# 18:45 and 12:44, neither of which is a 04:00 run. The script had been written
# and rehearsed by hand and never scheduled. Prose in a runbook is how that
# happens; a script that either registers the task or fails is how it stops.
#
# -StartWhenAvailable is the setting handoff.md's outstanding item 5 asked for,
# and it is the difference between a backup policy and a backup wish. Task
# Scheduler's default is to *skip* a missed run rather than catch up, so on a
# machine that is off or asleep at 04:00 the job simply never happens, and says
# nothing at all about it. With this, the run fires as soon as the machine is
# next available.
#
# -WakeToRun is deliberately NOT set. Waking a desktop at 04:00 to take a
# 36 KB dump is a worse trade than taking it at breakfast, and the site is down
# while the machine sleeps anyway, so nothing has changed in the meantime.

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
