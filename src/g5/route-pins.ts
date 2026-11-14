// V1.6 G5 evidence pins for the ONEchain -> BSC native CROSS route and the runtime-drift policy.
// Values come from evidence/otherbridge-v1-6/<run>/ (exact build reproduction, fresh chain pins).
// G5 is point-in-time: ANY observed difference from these pins makes the route REVIEW_REQUIRED.
// Execution stays globally disabled regardless of the G5 outcome (G7 needs separate approval).
import { CROSS, NATIVE } from "../core/model";

export const GLOBAL_EXECUTION_ENABLED = false as const;

export const G5_ROUTE_PINS = {
  evidence: "evidence/otherbridge-v1-6/v16-20261004T190436Z-210476",
  source: {
    chainId: 612055,
    proxy: "0xb81d6e000000000000000000000000000000c0de",
    proxyCodeHash:
      "0x0dac1e1deb9381d1139c43a9d49d022a4786242e90744abd0f77bf85375b548b",
    implementation: "0x2827865ad5330faf855af8b743c701ae9c818034",
    implementationCodeHash:
      "0x8bb2e9361035520a62a806cf78ff6f325d32c578a63f35ad49263524361e04bc",
    verifier: "0x4a508a3dde9ebe1a6b3c347fe4aced78500d2818",
    verifierCodeHash:
      "0x4d8c535dc98d27aa50e223becfca3acc31ab2f8bf7e03d5e43d0bd39cd932e9f",
    pair: { localToken: NATIVE, remoteToken: CROSS, isOrigin: false },
    settlement: {
      threshold: 2,
      validators: [
        "0x2af7f8fe5cd8e604b4767ed9ebb66768eec140dc",
        "0xa43aac00fd108d3a1fa195b0bb1403ecd57cce99",
        "0xdd89b36e3e81c881b62358c3ce2594054fd7c002",
      ],
      admins: ["0x22c1522276855b028c31a731ba10d125811af37c"],
      verifierRole: ["0xe7ba9776763c83810b9b227145277ebefa023f5b"],
    },
    build: {
      repository: "https://github.com/to-nexus/bridge-contracts",
      commit: "b3b025852a100d6b825a85ab26e7895fde65e633",
      tag: "v1.0.3",
      target: "src/CrossBridge.sol:CrossBridge",
      compiler: "0.8.28+commit.7893614a",
      settings: "optimizer runs=1, viaIR, evmVersion=prague, bytecodeHash=ipfs",
      metadataIpfs: "QmYddPkn9oBGqBhZXsBUpYzggKNhq8fbe3dGABAUocxaqL",
      standardJsonSha256:
        "70c61f29b02b7420c7aaea7a55a73854c4ef80d02535e343fd6eb7cc85a74139",
    },
  },
  destination: {
    chainId: 56,
    proxy: "0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5",
    proxyCodeHash:
      "0x25b30cfa97d56a7b846443ce92558cf31d86e95966c5afa22dacb0213c52ff9b",
    implementation: "0xac7b8ffed19d670930b8caa0693189b33454e8d8",
    implementationCodeHash:
      "0x47b60de2375276f3ead49ea41f35c58d068d6bd57625d3553db4257476f91f22",
    verifier: "0xf4dc7ff0ba7dd24060f5b4fc6c9133b6b4925d67",
    verifierCodeHash:
      "0x4d8c535dc98d27aa50e223becfca3acc31ab2f8bf7e03d5e43d0bd39cd932e9f",
    token: CROSS,
    tokenCodeHash:
      "0x94153b8b4d47e9794e833801f13d52ad780ed0d18ae41a7f741b5149fa671825",
    pair: { localToken: CROSS, remoteToken: NATIVE, isOrigin: true },
    settlement: {
      threshold: 2,
      validators: [
        "0x2af7f8fe5cd8e604b4767ed9ebb66768eec140dc",
        "0xa43aac00fd108d3a1fa195b0bb1403ecd57cce99",
        "0xdd89b36e3e81c881b62358c3ce2594054fd7c002",
      ],
      admins: ["0x22c1522276855b028c31a731ba10d125811af37c"],
      verifierRole: ["0xe7ba9776763c83810b9b227145277ebefa023f5b"],
    },
    build: {
      repository: "https://github.com/to-nexus/bridge-contracts",
      commit: "6da2fb2d7a2fee2414fea894fe521f6362884569",
      tag: null,
      target: "src/BSCBridgeV2.sol:BSCBridgeV2",
      compiler: "0.8.28+commit.7893614a",
      settings: "optimizer runs=1, viaIR, evmVersion=prague, bytecodeHash=ipfs",
      metadataIpfs: "QmcFRDCCv3aS14tYDZTG5d52VMv9Vj376TkEbh4AnXnU7X",
      standardJsonSha256:
        "a23403607286fd55feb7a5a7080381b898f696f798dcb64f04b5630d0679bdfa",
    },
  },
} as const;

export interface ObservedPair {
  localToken: string;
  remoteToken: string;
  isOrigin: boolean;
  paused: boolean;
}
// Settlement trust read live: validator set + threshold, admin (upgrade authority) and VERIFIER_ROLE
// (manual release to any recipient). All are single EOAs at the V1.6 pin; any change needs review.
export interface ObservedTrust {
  threshold: number;
  validators: string[];
  admins: string[];
  verifierRole: string[];
}
export interface ObservedSide {
  chainId: number;
  trust: ObservedTrust;
  proxyCodeHash: string;
  implementation: string;
  implementationCodeHash: string;
  verifier: string;
  verifierCodeHash: string;
  pair: ObservedPair;
  paused: boolean;
  finalizePaused: boolean;
}
export interface ObservedRoute {
  source: ObservedSide;
  destination: ObservedSide & { tokenCodeHash: string };
}
export type RouteState = "VERIFIED_READ_ONLY" | "PAUSED" | "REVIEW_REQUIRED";
export interface RouteDrift {
  state: RouteState;
  reasons: string[];
  executable: false;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// Fail closed: any identity/code/pair mismatch -> REVIEW_REQUIRED; a pause -> PAUSED. Never executable here.
export function evaluateRouteDrift(o: ObservedRoute): RouteDrift {
  const reasons: string[] = [];
  const sides = [
    ["SOURCE", o.source, G5_ROUTE_PINS.source],
    ["DESTINATION", o.destination, G5_ROUTE_PINS.destination],
  ] as const;
  for (const [name, seen, pin] of sides) {
    if (seen.chainId !== pin.chainId) reasons.push(`${name}_CHAIN_MISMATCH`);
    if (!same(seen.proxyCodeHash, pin.proxyCodeHash))
      reasons.push(`${name}_PROXY_CODE_CHANGED`);
    if (!same(seen.implementation, pin.implementation))
      reasons.push(`${name}_IMPLEMENTATION_CHANGED`);
    if (!same(seen.implementationCodeHash, pin.implementationCodeHash))
      reasons.push(`${name}_IMPLEMENTATION_CODE_CHANGED`);
    if (!same(seen.verifier, pin.verifier))
      reasons.push(`${name}_VERIFIER_CHANGED`);
    if (!same(seen.verifierCodeHash, pin.verifierCodeHash))
      reasons.push(`${name}_VERIFIER_CODE_CHANGED`);
    const set = (xs: readonly string[]) =>
      [...xs]
        .map((x) => x.toLowerCase())
        .sort()
        .join(",");
    if (seen.trust.threshold !== pin.settlement.threshold)
      reasons.push(`${name}_THRESHOLD_CHANGED`);
    if (set(seen.trust.validators) !== set(pin.settlement.validators))
      reasons.push(`${name}_VALIDATORS_CHANGED`);
    if (set(seen.trust.admins) !== set(pin.settlement.admins))
      reasons.push(`${name}_ADMINS_CHANGED`);
    if (set(seen.trust.verifierRole) !== set(pin.settlement.verifierRole))
      reasons.push(`${name}_VERIFIER_ROLE_CHANGED`);
    if (
      !same(seen.pair.localToken, pin.pair.localToken) ||
      !same(seen.pair.remoteToken, pin.pair.remoteToken) ||
      seen.pair.isOrigin !== pin.pair.isOrigin
    )
      reasons.push(`${name}_PAIR_CHANGED`);
  }
  if (
    !same(o.destination.tokenCodeHash, G5_ROUTE_PINS.destination.tokenCodeHash)
  )
    reasons.push("DESTINATION_TOKEN_CODE_CHANGED");
  if (reasons.length)
    return { state: "REVIEW_REQUIRED", reasons, executable: false };
  const paused = [
    o.source.paused && "SOURCE_PAUSED",
    o.source.pair.paused && "SOURCE_PAIR_PAUSED",
    o.destination.paused && "DESTINATION_PAUSED",
    o.destination.pair.paused && "DESTINATION_PAIR_PAUSED",
    o.destination.finalizePaused && "DESTINATION_FINALIZE_PAUSED",
  ].filter((x): x is string => typeof x === "string");
  if (paused.length)
    return { state: "PAUSED", reasons: paused, executable: false };
  return { state: "VERIFIED_READ_ONLY", reasons: [], executable: false };
}

// CBU-09 (fixed upstream only after the live builds): a payout to the bridge itself strands the credit.
// Self-bridging already requires an empty-code EOA recipient; this is an explicit second guard.
export function isBridgeContract(address: string): boolean {
  const known = [
    G5_ROUTE_PINS.source.proxy,
    G5_ROUTE_PINS.source.implementation,
    G5_ROUTE_PINS.source.verifier,
    G5_ROUTE_PINS.destination.proxy,
    G5_ROUTE_PINS.destination.implementation,
    G5_ROUTE_PINS.destination.verifier,
    G5_ROUTE_PINS.destination.token,
    NATIVE,
  ];
  return known.some((k) => same(k, address));
}
