param([string]$Directory)
$ErrorActionPreference = 'Stop'
$registry = Join-Path $Directory 'owned-processes.json'
$stopped = @()
$remaining = @()
$known = @()
if (Test-Path -LiteralPath $registry) { $parsed = Get-Content -LiteralPath $registry -Raw | ConvertFrom-Json; $known += $parsed }
$registrations = Join-Path $Directory 'process-registrations'
if (Test-Path -LiteralPath $registrations) {
  foreach ($file in (Get-ChildItem -LiteralPath $registrations -Filter '*.json')) {
    $known += Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
  }
}
if ($known.Count -gt 0) {
  $liveIds = @{}
  foreach ($process in (Get-CimInstance Win32_Process)) { $liveIds[[int]$process.ProcessId] = $true }
  # Newest descendants first. A reused PID is never considered owned.
  foreach ($row in ($known | Sort-Object created -Descending)) {
    if (-not $liveIds.ContainsKey([int]$row.pid)) { continue }
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($row.pid)"
    if ($current -and $current.CreationDate.ToUniversalTime().ToString('o') -eq $row.created) {
      Stop-Process -Id $row.pid -Force -ErrorAction SilentlyContinue
      $stopped += $row.pid
    }
  }
  $remainingById = @{}
  foreach ($process in (Get-CimInstance Win32_Process)) { $remainingById[[int]$process.ProcessId] = $process }
  foreach ($row in $known) {
    $current = $remainingById[[int]$row.pid]
    if ($current -and $current.CreationDate.ToUniversalTime().ToString('o') -eq $row.created) { $remaining += $row.pid }
  }
}
ConvertTo-Json -InputObject @{stopped=$stopped; remaining=$remaining; registryPresent=(Test-Path -LiteralPath $registry); scope='registered runner descendants; PID and creation-time equality'} -Depth 3 -Compress
