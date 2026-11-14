import { parseAbi } from "viem";
// Pinned source interface at 3a8347c; frontend's older six-field pair ABI is incompatible.
export const nativeReadAbi = parseAbi([
  "function paused() view returns (bool)",
  "function bridgeVerifier() view returns (address)",
  "function getTokenPair(uint256 remoteChainID,address token) view returns ((address localToken,address remoteToken,bool isOrigin,bool paused,uint256 pendingAmount,uint256 deposited,uint256 minted))",
  "function getNextInitiateIndex(uint256 remoteChainID) view returns (uint256)",
  "function getNextFinalizeIndex(uint256 remoteChainID) view returns (uint256)",
  "function isTokenFinalizePaused(uint256 remoteChainID,address token) view returns (bool)",
  "function calculateFee(uint256 remoteChainID,address token,uint256 value) view returns (uint256 minimumValue,uint256 networkFee,uint256 exFee)",
  "function getTokenConfig(uint256 remoteChainID,address token) view returns (uint256 minimumValue,uint256 networkFee,uint256 exFeeRate)",
  "function denominator() pure returns (uint256)",
  "event BridgeInitiated(uint256 indexed toChainID,uint256 indexed index,address fromToken,address toToken,address indexed from,address to,uint256 value,uint256 networkFee,uint256 exFee,bytes extraData,uint256 time)",
  "event BridgeFinalized(uint256 indexed fromChainID,uint256 indexed index,address indexed toToken,address to,uint256 value,uint256 time)",
  "event BridgePending(uint256 indexed fromChainID,uint256 indexed index,address indexed toToken,address to,uint256 value,uint256 time,uint8 status)",
]);
