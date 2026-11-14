// V1.7 G7 controlled-pilot PREPARATION policy (prep only: no signing, no broadcast, no approval, no deploy).
// Nothing here enables execution: GLOBAL_EXECUTION_ENABLED, the frozen kill policy, the empty write registry
// and the 0 bps fee policy are read and asserted, never changed. Not imported by the application bundle.
import { CROSS, NATIVE } from "../core/model";
import { G5_ROUTE_PINS } from "../g5/route-pins";

export { CROSS, NATIVE };
export const G7_POLICY_VERSION = "otherbridge.g7-prep.v1" as const;

// Public address supplied by the owner; used only as read-only `from` and as the recipient.
// It is never used to request, derive or read key material.
// Owner change of 2026-10-05: the single authorized G7 pilot EOA (ONEchain source AND BSC recipient).
export const PILOT_EOA = "0xb6ded1b18464aed61db794dfc5cb031b45a7ca2c" as const;
// Earlier pilot EOA: kept only as historical evidence (SUPERSEDED_BY_G7_PILOT_EOA_CHANGE), never authorized.
export const SUPERSEDED_PILOT_EOAS = [
  "0x28136a77ec8ba3d918114712a588b4095ba12a6b",
] as const;

// V1.6 reference exposure (point-in-time; NEVER used as current truth — always re-read from the verifier).
export const REFERENCE = {
  minimum: 5_000_000_000_000_000_000n,
  networkFee: 180_000_000_000_000_000n,
  serviceFee: 0n,
  msgValue: 5_180_000_000_000_000_000n,
} as const;

// The project's accepted gas margin (native-service.ts): ceil(estimate * 120 / 100).
export const GAS_MARGIN = { numerator: 120n, denominator: 100n } as const;
export const QUOTE_MAX_AGE_MS = 60_000;
// Public ONE nodes are load-balanced; the head block can be unknown to the second backend.
export const ONE_PIN_LAG = 3;
export const OTHERBRIDGE_PLATFORM_FEE_BPS = 0 as const;

export const V16 = {
  evidence: G5_ROUTE_PINS.evidence,
  // Final pins of the accepted V1.6 runtime-drift recheck (gate J) and ledger reconciliation (gate E).
  driftRecheckTo: { one: 45673691, bsc: 125745889 },
  // Pins at which V1.6 read the route/role/reserve snapshot; every G7 event scan starts right after them.
  snapshotPin: { one: 45673482, bsc: 125745332 },
  ledgerPin: 125745332,
} as const;

// Vetted read-only endpoints (V1.6 policy): two official ONE endpoints; two independent BSC state operators;
// NodeReal public endpoint (DefiLlama/chainlist list) only for historical eth_getLogs, never as a state vote.
export const ENDPOINTS = {
  one: [
    "https://mainnet.crosstoken.io:22001",
    "https://mainnet.onechain.nexus:22001",
  ],
  bsc: ["https://bsc-dataseed.bnbchain.org", "https://bsc-rpc.publicnode.com"],
  bscLogs: [
    "https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3",
  ],
} as const;

// V1.11 P0 (RPC consensus reliability): vetted BSC STATE sources by operator group, in preference order. The first
// two are the unchanged V1.6 pair; the third is an independent fallback from the vetted provenance inventory
// (src/data/registry/rpc-provenance.json, witness-eligible, LEGAL_REVIEW_REQUIRED). Two sources of one operator
// group never count as independent. The BSC pin is the common finalized block of one independent pair
// (src/g7/common-pin.ts); NodeReal stays logs-only and is a pin witness, never a state vote.
export const BSC_STATE_SOURCES = [
  { url: ENDPOINTS.bsc[0], operatorGroup: "bnb-chain-bsc-dataseed" },
  { url: ENDPOINTS.bsc[1], operatorGroup: "allnodes-publicnode" },
  { url: "https://bnb.api.onfinality.io/public", operatorGroup: "onfinality" },
] as const;
export const BSC_LOGS_WITNESS = {
  url: ENDPOINTS.bscLogs[0],
  operatorGroup: "nodereal-logs-only",
} as const;
// BSC produces ~0.45 s blocks; finalized trails the head by a few blocks. A common pin older than 30 s means a
// lagging source and the next independent pair is tried; at most 16 blocks are stepped down per pair.
export const BSC_PIN_POLICY = {
  chainId: 56,
  maxPinAgeSec: 30,
  maxStepDown: 16,
  probeTimeoutMs: 8000,
} as const;

export const SLOTS = {
  implementation:
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeee9b4b1e0ae2c5d1d2c93ae",
} as const;

export const ROLE_NAMES = [
  "DEFAULT_ADMIN_ROLE",
  "ADMIN_ROLE",
  "VALIDATOR_ROLE",
  "EDITOR_ROLE",
  "OPERATOR_ROLE",
  "PRICER_ROLE",
  "VERIFIER_ROLE",
  "BRIDGE_ROLE",
  "MINTER_ROLE",
  "EXECUTOR_ROLE",
  "INITIATOR_ROLE",
] as const;
export type RoleName = (typeof ROLE_NAMES)[number];
type RoleSets = Readonly<Record<RoleName, readonly string[]>>;

const ADMIN = "0x22c1522276855b028c31a731ba10d125811af37c";
const VALIDATORS = G5_ROUTE_PINS.source.settlement.validators;
const VERIFIER_OPERATOR = "0xe7ba9776763c83810b9b227145277ebefa023f5b";
const EDITOR = "0x833591e90f3f9146bb036a290f5a58ea77aa022d";
const PRICER_OR_EDITOR = "0xe199de5198b8358a613a1b04308df1268191c056";
const empty: readonly string[] = [];

// Extended G7 pins (stricter than the V1.6 route-drift policy, never weaker): every role set of both bridges and
// both verifiers, dev/fee recipient, executor, extraData limit, circuit-breaker thresholds and the price feed,
// exactly as read at the V1.6 pins (reserve/route-snapshot-final.json). Any difference blocks the preparation.
export const EXTENDED_PINS = {
  one: {
    dev: "0x90583a8f272c7782646e58e6bfc49933678fffb0",
    executor: "0x99028d75a83a21b59e239c9af23aa938277465b0",
    maxExtraDataLength: "1024",
    adminSlot: "0x" + "0".repeat(64),
    beaconSlot: "0x" + "0".repeat(64),
    bridgeRoles: {
      DEFAULT_ADMIN_ROLE: [ADMIN],
      ADMIN_ROLE: [ADMIN],
      VALIDATOR_ROLE: VALIDATORS,
      EDITOR_ROLE: [EDITOR],
      OPERATOR_ROLE: [VERIFIER_OPERATOR],
      PRICER_ROLE: empty,
      VERIFIER_ROLE: [VERIFIER_OPERATOR],
      BRIDGE_ROLE: empty,
      MINTER_ROLE: empty,
      EXECUTOR_ROLE: empty,
      INITIATOR_ROLE: empty,
    } satisfies RoleSets,
    verifierRoles: {
      DEFAULT_ADMIN_ROLE: [ADMIN],
      ADMIN_ROLE: [ADMIN],
      VALIDATOR_ROLE: empty,
      EDITOR_ROLE: [EDITOR],
      OPERATOR_ROLE: empty,
      PRICER_ROLE: [PRICER_OR_EDITOR],
      VERIFIER_ROLE: empty,
      BRIDGE_ROLE: [G5_ROUTE_PINS.source.proxy],
      MINTER_ROLE: empty,
      EXECUTOR_ROLE: empty,
      INITIATOR_ROLE: empty,
    } satisfies RoleSets,
    verifierThresholds: {
      verificationAmountThreshold: "0",
      periodTotalValueThreshold: "0",
    },
    priceFeed: "0xf90d3af823d8accc91c36c29b2691977f8171423",
    feeDenominator: "10000",
  },
  bsc: {
    dev: "0x90583a8f272c7782646e58e6bfc49933678fffb0",
    executor: "0x0000000000000000000000000000000000000000",
    maxExtraDataLength: "1024",
    adminSlot: "0x" + "0".repeat(64),
    beaconSlot: "0x" + "0".repeat(64),
    bridgeRoles: {
      DEFAULT_ADMIN_ROLE: [ADMIN],
      ADMIN_ROLE: [ADMIN],
      VALIDATOR_ROLE: VALIDATORS,
      EDITOR_ROLE: [EDITOR],
      OPERATOR_ROLE: [VERIFIER_OPERATOR],
      PRICER_ROLE: empty,
      VERIFIER_ROLE: [VERIFIER_OPERATOR],
      BRIDGE_ROLE: empty,
      MINTER_ROLE: empty,
      EXECUTOR_ROLE: empty,
      INITIATOR_ROLE: ["0xb8ac56bcdd60348f6b6f78469eb5f54242347892"],
    } satisfies RoleSets,
    verifierRoles: {
      DEFAULT_ADMIN_ROLE: [ADMIN],
      ADMIN_ROLE: [ADMIN],
      VALIDATOR_ROLE: empty,
      EDITOR_ROLE: [PRICER_OR_EDITOR],
      OPERATOR_ROLE: empty,
      PRICER_ROLE: [EDITOR],
      VERIFIER_ROLE: empty,
      BRIDGE_ROLE: [G5_ROUTE_PINS.destination.proxy],
      MINTER_ROLE: empty,
      EXECUTOR_ROLE: empty,
      INITIATOR_ROLE: empty,
    } satisfies RoleSets,
    verifierThresholds: {
      verificationAmountThreshold: "0",
      periodTotalValueThreshold: "0",
    },
    priceFeed: "0xf90d3af823d8accc91c36c29b2691977f8171423",
    feeDenominator: "10000",
    tokenDecimals: 18,
  },
} as const;

// Accounts whose key controls settlement/upgrade (trust model). Their code must still be empty (plain EOAs)
// for the owner-facing trust statement to stay true; non-empty code is a trust-model change.
export const TRUST_ACCOUNTS = [
  ADMIN,
  ...VALIDATORS,
  VERIFIER_OPERATOR,
] as const;

// Configuration / privileged events: any occurrence after the V1.6 pins is route drift (fail closed).
export const WATCHED_EVENTS = [
  "Upgraded(address)",
  "AdminChanged(address,address)",
  "BeaconUpgraded(address)",
  "Initialized(uint64)",
  "RoleGranted(bytes32,address,address)",
  "RoleRevoked(bytes32,address,address)",
  "RoleAdminChanged(bytes32,bytes32,bytes32)",
  "ThresholdChanged(uint8)",
  "BridgeVerifierSet(address)",
  "DevSet(address)",
  "BridgeExecutorSet(address)",
  "Paused(address)",
  "Unpaused(address)",
  "TokenPauseSet(uint256,address,bool,bool)",
  "TokenPauseSet(uint256,address,bool)",
  "ChainPauseSet(uint256,bool)",
  "TokenPairRegistered(uint256,address,address,bool)",
  "TokenPairUnregistered(uint256,address)",
  "MaxExtraDataLengthSet(uint256)",
  "PostCallGasReserveSet(uint256,uint256)",
  "VerificationDelaySet(uint256)",
  "VerificationDelayExpirationSet(uint256,uint256,uint256)",
  "CrossMintableERC20CodeSet(address,address)",
  "CrossMintableERC20CodeSet(address)",
  "EIP712DomainChanged()",
  "PendingRemoved(uint256,uint256)",
  "ManualReleased(uint256,uint256)",
] as const;

// Exact custom errors of the live ONE build (CrossBridge @ b3b0258) expected for the negative controls.
export const NEGATIVE_CONTROLS = [
  { name: "belowMinimumByOneWei", error: "BaseBridgeInvalidAmount" },
  { name: "msgValueMinusOneWei", error: "BaseBridgeInvalidValue" },
  { name: "networkFeeBelowRequiredByOneWei", error: "BaseBridgeInvalidAmount" },
  { name: "zeroRecipient", error: "BaseBridgeCanNotZeroAddress" },
  { name: "unsupportedTokenCrossOnOne", error: "RegistryNotExistToken" },
  { name: "unsupportedDestinationChain97", error: "RegistryNotExistToken" },
] as const;

// Read-only JSON-RPC allowlist of the G7 preparation and tracking tools. Anything else is refused before I/O.
export const G7_READ_METHODS = [
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_call",
  "eth_estimateGas",
  "eth_getLogs",
  "eth_getBalance",
  "eth_getTransactionCount",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
] as const;

export const PREP_STATUSES = [
  "READY_FOR_OWNER_SIGNATURE",
  "BLOCKED",
  "OWNER_REAPPROVAL_REQUIRED",
] as const;
export type PrepStatus = (typeof PREP_STATUSES)[number];

export const TRUST_STATEMENT =
  "The bridge contract/build/reserve/settlement route was technically verified at the current pins, but settlement and upgrade authority are controlled by EOAs. This is a centralized trust assumption, not a trustless bridge.";
export const TRUST_STATEMENT_TR =
  "Köprü kontratı/build/rezerv/settlement rotası mevcut pinlerde teknik olarak doğrulandı; ancak settlement ve upgrade yetkisi EOA'lar tarafından kontrol ediliyor. Bu merkezi bir güven varsayımıdır, trustless bir köprü değildir.";
export const TRUST_ACCEPTANCE_SENTENCE =
  "I understand that the verified ONEbridge route has centralized upgrade/settlement trust: single admin EOA and 2-of-3 validator EOAs.";
