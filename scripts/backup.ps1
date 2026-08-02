# Nightly database dump for FootyBoard.
#
# Registered by `install-backup-task.ps1` beside this file. Runs as LOCAL
# SYSTEM, which is why nothing here depends on a user profile, a PATH entry, or
# a working directory.
#
# **This lived only on the deployment until 2026-08-02**, at
# `A:\FootyBoard\backup.ps1`, untracked by either repository. It is here now for
# the reason `check-deployed-headers.mjs` is here: it is not application code,
# it is run against a deployment, so it belongs in the repository the deployment
# is built from. `scripts/` is already in the shipped set, so it reaches the
# mirror with no change to the archive command. A fresh clone used to come up
# with no backup job and say nothing about it.
#
# Two things are deliberate:
#
#   The credential is never in this file. DATABASE_URL is read out of
#   server/.env at run time, so the password lives in exactly one place and
#   rotating it does not mean remembering this script exists. SYSTEM has read
#   access to that file, granted in step 12 of plans/008.
#
#   Retention is not optional here. The dumps land on C:, which had 16 GB free
#   when this was written, and an unbounded nightly dump on the system disk
#   eventually fills it and takes Windows down with it -- a worse outcome than
#   having no backup at all.
#
# **The dump alone is not a recovery.** Board payloads are sealed with
# ENCRYPTION_KEY, which lives in a password manager and nowhere in either
# repository. The dump and that key are two halves and neither works without
# the other.

[CmdletBinding()]
param(
    # Absolute, because SYSTEM has no PATH worth relying on and this is not on
    # it in any case. Overridable so the script is not pinned to one install.
    [string] $PgDump = 'A:\PostgreSQL\18\bin\pg_dump.exe',
    # A different physical disk from the deployment, on purpose.
    [string] $Dest = 'C:\FootyBoardBackups',
    [int] $KeepDays = 14
)

$ErrorActionPreference = 'Stop'

# Relative to this script rather than hard-coded to A:. The whole point of
# tracking this file is that a clone anywhere comes up with a working backup,
# and an absolute path to the one machine it was written on would have kept the
# defect it was moved here to fix.
$EnvFile = Join-Path $PSScriptRoot '..\server\.env'
if (-not (Test-Path $EnvFile)) {
    throw "No server\.env beside this checkout at $EnvFile. This runs on a deployment, not on a dev clone."
}

New-Item -ItemType Directory -Force -Path $Dest | Out-Null

# The connection string, straight from the file the API uses. If this line ever
# stops matching, the dump should fail loudly rather than back up the wrong thing.
$match = Select-String -Path $EnvFile -Pattern '^DATABASE_URL=(.+)$'
if (-not $match) { throw "DATABASE_URL not found in $EnvFile" }
$DatabaseUrl = $match.Matches[0].Groups[1].Value.Trim()

$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$out   = Join-Path $Dest "footyboard-$stamp.dump"

# -Fc is the custom format: compressed, and restorable selectively with
# pg_restore rather than all-or-nothing.
& $PgDump --dbname=$DatabaseUrl --format=custom --file=$out
if ($LASTEXITCODE -ne 0) { throw "pg_dump exited $LASTEXITCODE" }

if (-not (Test-Path $out) -or (Get-Item $out).Length -eq 0) {
    throw "pg_dump reported success but produced no output at $out"
}

# Prune old dumps only after a new one has been confirmed on disk, so a run of
# failures can never delete the last good copy.
Get-ChildItem -Path $Dest -Filter 'footyboard-*.dump' |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } |
    Remove-Item -Force

$kept = @(Get-ChildItem -Path $Dest -Filter 'footyboard-*.dump')
$mb   = [math]::Round(($kept | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
Write-Output ("{0}  wrote {1} ({2:N0} bytes); {3} dumps kept, {4} MB total" -f `
    (Get-Date -Format s), (Split-Path $out -Leaf), (Get-Item $out).Length, $kept.Count, $mb)
