function Update-OwnedProcesses {
  param([array]$Processes, [array]$Seeds, [hashtable]$Known, [hashtable]$History, [datetime]$Started)
  $byId = @{}
  foreach ($item in $Processes) { $byId[[int]$item.pid] = $item }
  foreach ($seed in $Seeds) {
    $item = $byId[[int]$seed.pid]
    if ($item -and $item.created -eq $seed.created -and [datetime]::Parse($item.created).ToUniversalTime() -ge $Started) {
      $Known[[int]$item.pid] = $item
      $History["$($item.pid)|$($item.created)"] = $item
    }
  }
  do {
    $added = 0
    foreach ($item in $Processes) {
      $previous = $Known[[int]$item.pid]
      if ($previous -and $previous.created -eq $item.created) { continue }
      $parent = $Known[[int]$item.parent]
      $liveParent = $byId[[int]$item.parent]
      if ($parent -and $liveParent -and $parent.created -eq $liveParent.created -and
          [datetime]::Parse($item.created).ToUniversalTime() -ge [datetime]::Parse($parent.created).ToUniversalTime() -and
          [datetime]::Parse($item.created).ToUniversalTime() -ge $Started) {
        $Known[[int]$item.pid] = $item
        $History["$($item.pid)|$($item.created)"] = $item
        $added++
      }
    }
  } while ($added -gt 0)
}
