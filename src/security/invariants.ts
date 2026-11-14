import { executionGate } from "../routing/model";
import { platformFeePolicy } from "../routing/fee-policy";
import { contractRegistry, killPolicy } from "./firewall";
import { ROUTE } from "../core/model";
// V1.5 security invariants exported as monitoring gauges. They reflect frozen code constants; no
// environment variable is read here, so configuration cannot change what monitoring reports.
// Expected for this pre-release: gate 0, fees 0, write registry 0, global kill 1, drift 0.
export interface SecurityInvariants {
  execution_gate_open: 0 | 1;
  fee_collection_enabled: 0 | 1;
  write_registry_entries: number;
  global_kill_enabled: 0 | 1;
  contract_registry_drift: number;
}
export const EXPECTED_INVARIANTS: Readonly<SecurityInvariants> = Object.freeze({
  execution_gate_open: 0,
  fee_collection_enabled: 0,
  write_registry_entries: 0,
  global_kill_enabled: 1,
  contract_registry_drift: 0,
});
export function securityInvariants(): SecurityInvariants {
  const writeHandles = [
    executionGate.sign,
    executionGate.approve,
    executionGate.broadcast,
    executionGate.deploy,
  ].filter((v) => v !== null && v !== undefined).length;
  return {
    execution_gate_open: executionGate.enabled || writeHandles > 0 ? 1 : 0,
    fee_collection_enabled:
      platformFeePolicy.enabled || platformFeePolicy.bps !== 0 ? 1 : 0,
    write_registry_entries:
      contractRegistry.length +
      writeHandles +
      [ROUTE.sourceContract, ROUTE.destinationContract].filter(
        (v) => v !== null,
      ).length,
    global_kill_enabled: killPolicy.global ? 1 : 0,
    // Drift requires a registry entry whose runtime/implementation hash changed. The production
    // registry is empty, so there is nothing that can drift; a non-empty registry must replace this
    // with a live runtime-hash comparison before it can be released.
    contract_registry_drift: contractRegistry.filter(
      (e) => e.status !== "ACTIVE",
    ).length,
  };
}
export function invariantDeviations(v = securityInvariants()) {
  return (
    Object.keys(EXPECTED_INVARIANTS) as (keyof SecurityInvariants)[]
  ).filter((k) => v[k] !== EXPECTED_INVARIANTS[k]);
}
