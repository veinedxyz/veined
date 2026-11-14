import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const memoryProfiles = Object.freeze({
  standard: {
    minimumFreeGb: 5,
    minimumCommitHeadroomGb: 8,
    heapMiB: 3072,
    ownedGiB: 4,
  },
  small: {
    minimumFreeGb: 2,
    minimumCommitHeadroomGb: 4,
    heapMiB: 512,
    ownedGiB: 0.75,
  },
  checks: {
    minimumFreeGb: 2.5,
    minimumCommitHeadroomGb: 6,
    heapMiB: 768,
    ownedGiB: 1.5,
  },
  focused: {
    minimumFreeGb: 4,
    minimumCommitHeadroomGb: 8,
    heapMiB: 2048,
    ownedGiB: 3,
  },
  // Owner-authorized (2026-11-04) validation profile, explicit selection only: a lower start threshold; commit
  // headroom, heap and the owned-process cap equal standard, and the runtime guard limits are unchanged.
  LOW_MEMORY_SERIAL: {
    minimumFreeGb: 3,
    minimumCommitHeadroomGb: 8,
    heapMiB: 3072,
    ownedGiB: 4,
  },
});

// Admission only: never stop another task to obtain host memory.
export async function waitForHostMemory(directory, profile = "standard") {
  if (!Object.hasOwn(memoryProfiles, profile))
    throw Error("MEMORY_PROFILE_INVALID");
  // Small non-browser checks also enforce a 768 MiB owned-process cap and a
  // 512 MiB Node heap in v1201-owned-run. Browser/build admission stays intact.
  const { minimumFreeGb, minimumCommitHeadroomGb } = memoryProfiles[profile];
  mkdirSync(directory, { recursive: true });
  const started = Date.now();
  const observations = [];
  let readySamples = 0;
  while (Date.now() - started < 600000) {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$memory = Get-CimInstance Win32_OperatingSystem; @{ freeGb = $memory.FreePhysicalMemory / 1MB; commitHeadroomGb = $memory.FreeVirtualMemory / 1MB } | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.status !== 0) throw Error("MEMORY_ADMISSION_UNAVAILABLE");
    const memory = JSON.parse(result.stdout);
    const ready =
      memory.freeGb >= minimumFreeGb &&
      memory.commitHeadroomGb >= minimumCommitHeadroomGb;
    readySamples = ready ? readySamples + 1 : 0;
    observations.push({ at: new Date().toISOString(), ...memory, ready });
    writeFileSync(
      join(directory, "memory-admission.json"),
      JSON.stringify(
        {
          profile,
          minimumFreeGb,
          minimumCommitHeadroomGb,
          requiredConsecutiveSamples: 2,
          sampleSpacingMs: 5000,
          timeoutMs: 600000,
          admitted: readySamples >= 2,
          observations,
        },
        null,
        2,
      ),
    );
    if (readySamples >= 2) return;
    if (!ready)
      console.log(
        `Waiting for test memory: ${memory.freeGb.toFixed(2)}GiB free, ${memory.commitHeadroomGb.toFixed(2)}GiB commit headroom; no other process is stopped`,
      );
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw Error("HOST_MEMORY_ADMISSION_TIMEOUT");
}
