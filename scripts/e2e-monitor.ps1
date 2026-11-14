param([int]$OwnerPid, [string]$Directory, [string]$Since, [string]$OwnerCreated, [switch]$Stream)
$ErrorActionPreference = 'Stop'
[System.Threading.Thread]::CurrentThread.CurrentCulture = [cultureinfo]::InvariantCulture
$started = [datetime]::Parse($Since).ToUniversalTime()
$known = @{}
$history = @{}
. (Join-Path $PSScriptRoot 'lib/process-ownership.ps1')
# The guards read memory.psv every second. Add-Content denies readers while it writes and fails with a
# sharing violation while a reader has the file open, which terminated this sampler. Append one complete
# line per write with read/write sharing instead.
function Add-SharedLine([string]$Path, [string]$Line) {
  $bytes = [Text.Encoding]::ASCII.GetBytes($Line + "`r`n")
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
}
# -Stream: the guards take telemetry from this process's stdout and persist the evidence files themselves.
# A file-system stall (a file close was observed blocking for seconds) must never delay a sample, so this
# mode performs no file write at all: sample lines, "#owned <json>" ownership snapshots and "#error" lines.
$stdout = [Console]::Out
$lastOwned = $null
$owner = $null
if ($OwnerCreated) { $owner = @{pid=$OwnerPid;created=$OwnerCreated} }
while ($true) {
  try {
    $all = @(Get-CimInstance Win32_Process)
    $byId = @{}
    foreach ($item in $all) { $byId[[int]$item.ProcessId] = $item }
    # Legacy callers pin the root once. New callers supply its captured birth time.
    if (-not $owner -and $byId.ContainsKey($OwnerPid)) {
      $owner = @{pid=$OwnerPid;created=$byId[$OwnerPid].CreationDate.ToUniversalTime().ToString('o')}
    }
    $seeds = @()
    if ($owner) { $seeds += $owner }
    $registration = Join-Path $Directory 'server-processes.json'
    if (Test-Path -LiteralPath $registration) {
      try { $seeds += @((Get-Content -LiteralPath $registration -Raw | ConvertFrom-Json).processes) | Where-Object { $_.pid -and $_.created } } catch {}
    }
    $registrations = Join-Path $Directory 'process-registrations'
    if (Test-Path -LiteralPath $registrations) {
      foreach ($file in (Get-ChildItem -LiteralPath $registrations -Filter '*.json')) {
        try { $seed = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json; if($seed.pid -and $seed.created){$seeds += $seed} } catch {}
      }
    }
    $identities = @($all | ForEach-Object { @{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o')} })
    Update-OwnedProcesses -Processes $identities -Seeds $seeds -Known $known -History $history -Started $started
    $owned = @($all | Where-Object { $row=$known[[int]$_.ProcessId]; $row -and $_.CreationDate.ToUniversalTime().ToString('o') -eq $row.created })
    $os = Get-CimInstance Win32_OperatingSystem
    $nodes = @($owned | Where-Object Name -eq 'node.exe')
    $browsers = @($owned | Where-Object Name -match '^(chrome|chrome-headless-shell|headless_shell)\.exe$')
    $memory = '{0}|{1}|{2}|{3}|{4}|{5}|{6}' -f ([DateTimeOffset]::Now.ToUnixTimeMilliseconds()), [math]::Round($os.FreePhysicalMemory/1MB,3), [math]::Round(($os.TotalVirtualMemorySize-$os.FreeVirtualMemory)/1MB,3), [math]::Round($os.TotalVirtualMemorySize/1MB,3), [math]::Round((($nodes | Measure-Object WorkingSetSize -Sum).Sum)/1GB,3), [math]::Round((($browsers | Measure-Object WorkingSetSize -Sum).Sum)/1GB,3), $owned.Count
    $json = ConvertTo-Json -InputObject @($history.Values) -Depth 3 -Compress
    if ($Stream) {
      $stdout.WriteLine($memory)
      if ($json -ne $lastOwned) { $stdout.WriteLine('#owned ' + $json); $lastOwned = $json }
      $stdout.Flush()
    } else {
      Add-SharedLine (Join-Path $Directory 'memory.psv') $memory
      [IO.File]::WriteAllText((Join-Path $Directory 'owned-processes.json'), $json)
    }
  } catch {
    # A failed iteration writes no sample, so the guards see the telemetry age and stop the run (fail-closed).
    $entry = '{0}|{1}|{2}' -f ([DateTimeOffset]::Now.ToUnixTimeMilliseconds()), $_.Exception.GetType().FullName, ($_.Exception.Message -replace '[\r\n|]', ' ')
    if ($Stream) { try { [Console]::Error.WriteLine('#error ' + $entry); [Console]::Error.Flush() } catch {} }
    else { try { Add-SharedLine (Join-Path $Directory 'sampler-errors.log') $entry } catch {} }
  }
  Start-Sleep -Seconds 2
}
