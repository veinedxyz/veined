$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/process-ownership.ps1')
$started = [datetime]::Parse('2026-10-27T00:00:00Z').ToUniversalTime()
function Row([int]$Id, [int]$Parent, [int]$Second) {
  return @{pid=$Id;parent=$Parent;created=$started.AddSeconds($Second).ToString('o')}
}
$known=@{}; $history=@{}; $checks=@()
$root=Row 10 1 1; $child=Row 20 10 2; $foreign=Row 30 1 2
Update-OwnedProcesses @($root,$child,$foreign) @($root) $known $history $started
if($known.Count -ne 2 -or $known.ContainsKey(30)){throw 'INITIAL_OWNERSHIP'}
$checks+='owned child included; unrelated excluded'
$replacement=Row 20 10 3; $grandchild=Row 40 20 4
Update-OwnedProcesses @($root,$replacement,$grandchild,$foreign) @($root) $known $history $started
if($known[20].created -ne $replacement.created -or -not $known.ContainsKey(40) -or $history.Count -ne 4){throw 'OWNED_PID_REUSE'}
$checks+='owned PID reuse and descendants included; history retained'
$foreignReuse=Row 20 30 5; $foreignChild=Row 50 20 6
Update-OwnedProcesses @($root,$foreignReuse,$foreignChild,$foreign) @($root) $known $history $started
if($known[20].created -eq $foreignReuse.created -or $known.ContainsKey(50)){throw 'FOREIGN_PID_REUSE'}
$checks+='foreign PID reuse and descendants excluded'
$reusedRoot=Row 10 1 7; $reusedRootChild=Row 60 10 8
Update-OwnedProcesses @($reusedRoot,$reusedRootChild,$foreign) @($root) $known $history $started
if($known[10].created -eq $reusedRoot.created -or $known.ContainsKey(60)){throw 'ROOT_PID_REUSE'}
$checks+='root identity pinned after PID reuse'
$orphan=Row 70 999 9
Update-OwnedProcesses @($orphan,$foreign) @($orphan) $known $history $started
if($known[70].created -ne $orphan.created){throw 'EXACT_REGISTRATION'}
$checks+='explicit exact identity adopted after intermediary exit'
$oldChild=Row 80 70 1
Update-OwnedProcesses @($orphan,$oldChild) @() $known $history $started
if($known.ContainsKey(80)){throw 'CHILD_PREDATES_PARENT'}
$checks+='older process cannot inherit a reused parent PID'
@{pass=$true;checks=$checks;scope='synthetic identity snapshots; no process mutation'} | ConvertTo-Json -Depth 4
