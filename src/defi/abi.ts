import { parseAbi, type Abi } from "viem";
// Minimal read interfaces derived from the pinned official source inventory. No transaction selectors.
export const views = {
  balanceOf: "function balanceOf(address) view returns (uint256)",
  decimals: "function decimals() view returns (uint8)",
  symbol: "function symbol() view returns (string)",
  asset: "function asset() view returns (address)",
  convertToAssets: "function convertToAssets(uint256) view returns (uint256)",
  getUserAccountData:
    "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
  getAllReservesTokens:
    "function getAllReservesTokens() view returns ((string symbol,address tokenAddress)[])",
  getUserReserveData:
    "function getUserReserveData(address,address) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint40,bool)",
  getReserveTokensAddresses:
    "function getReserveTokensAddresses(address) view returns (address,address,address)",
  getReserveConfigurationData:
    "function getReserveConfigurationData(address) view returns (uint256,uint256,uint256,uint256,uint256,bool,bool,bool,bool,bool)",
  getPool: "function getPool() view returns (address)",
  getPoolDataProvider: "function getPoolDataProvider() view returns (address)",
  getAllUserRewards:
    "function getAllUserRewards(address[],address) view returns (address[],uint256[])",
  baseToken: "function baseToken() view returns (address)",
  borrowBalanceOf: "function borrowBalanceOf(address) view returns (uint256)",
  numAssets: "function numAssets() view returns (uint8)",
  getAssetInfo:
    "function getAssetInfo(uint8) view returns ((uint8 offset,address asset,address priceFeed,uint64 scale,uint64 borrowCollateralFactor,uint64 liquidateCollateralFactor,uint64 liquidationFactor,uint128 supplyCap))",
  collateralBalanceOf:
    "function collateralBalanceOf(address,address) view returns (uint128)",
  isBorrowCollateralized:
    "function isBorrowCollateralized(address) view returns (bool)",
  isLiquidatable: "function isLiquidatable(address) view returns (bool)",
  position:
    "function position(bytes32,address) view returns (uint256,uint128,uint128)",
  market:
    "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
  idToMarketParams:
    "function idToMarketParams(bytes32) view returns (address,address,address,address,uint256)",
  borrowRateView:
    "function borrowRateView((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv),(uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)) view returns (uint256)",
  feeRecipient: "function feeRecipient() view returns (address)",
  price: "function price() view returns (uint256)",
  isMetaMorpho: "function isMetaMorpho(address) view returns (bool)",
  MORPHO: "function MORPHO() view returns (address)",
  getStETHByWstETH: "function getStETHByWstETH(uint256) view returns (uint256)",
  token0: "function token0() view returns (address)",
  token1: "function token1() view returns (address)",
  factory: "function factory() view returns (address)",
  getPair: "function getPair(address,address) view returns (address)",
  getReserves: "function getReserves() view returns (uint112,uint112,uint32)",
  totalSupply: "function totalSupply() view returns (uint256)",
  tokenOfOwnerByIndex:
    "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  ownerOf: "function ownerOf(uint256) view returns (address)",
  positions:
    "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
  poolFor: "function getPool(address,address,uint24) view returns (address)",
  slot0:
    "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  fee: "function fee() view returns (uint24)",
  tickSpacing: "function tickSpacing() view returns (int24)",
  // V1.14 exact Uniswap V3 fee growth (Tick.getFeeGrowthInside / Position.update) and Pancake V3 layout.
  feeGrowthGlobal0X128:
    "function feeGrowthGlobal0X128() view returns (uint256)",
  feeGrowthGlobal1X128:
    "function feeGrowthGlobal1X128() view returns (uint256)",
  ticks:
    "function ticks(int24) view returns (uint128,int128,uint256,uint256,int56,uint160,uint32,bool)",
  slot0Pancake:
    "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint32,bool)",
  deployer: "function deployer() view returns (address)",
  // V1.14 UniswapV2-family exact burn: protocol-fee mint before the share is taken.
  feeTo: "function feeTo() view returns (address)",
  kLast: "function kLast() view returns (uint256)",
  // V1.14 Morpho oracle registry: only factory-created MorphoChainlinkOracleV2 oracles have reviewed semantics.
  isMorphoChainlinkOracleV2:
    "function isMorphoChainlinkOracleV2(address) view returns (bool)",
  // V1.14 Lido withdrawal queue (read-only; no claim).
  getWithdrawalRequests:
    "function getWithdrawalRequests(address) view returns (uint256[])",
  getWithdrawalStatus:
    "function getWithdrawalStatus(uint256[]) view returns ((uint256 amountOfStETH,uint256 amountOfShares,address owner,uint256 timestamp,bool isFinalized,bool isClaimed)[])",
  getLastCheckpointIndex:
    "function getLastCheckpointIndex() view returns (uint256)",
  findCheckpointHints:
    "function findCheckpointHints(uint256[],uint256,uint256) view returns (uint256[])",
  getClaimableEther:
    "function getClaimableEther(uint256[],uint256[]) view returns (uint256[])",
  // V1.14 liquid staking exact conversions / protocol-reported rates (never an assumed 1:1).
  getEthValue: "function getEthValue(uint256) view returns (uint256)",
  exchangeRate: "function exchangeRate() view returns (uint256)",
  getEETHByWeETH: "function getEETHByWeETH(uint256) view returns (uint256)",
  mETHToETH: "function mETHToETH(uint256) view returns (uint256)",
  swETHToETHRate: "function swETHToETHRate() view returns (uint256)",
  rsETHPrice: "function rsETHPrice() view returns (uint256)",
  // V1.14 EigenLayer restaking.
  getDeposits:
    "function getDeposits(address) view returns (address[],uint256[])",
  getWithdrawableShares:
    "function getWithdrawableShares(address,address[]) view returns (uint256[],uint256[])",
  getQueuedWithdrawalRoots:
    "function getQueuedWithdrawalRoots(address) view returns (bytes32[])",
  podOwnerDepositShares:
    "function podOwnerDepositShares(address) view returns (int256)",
  sharesToUnderlyingView:
    "function sharesToUnderlyingView(uint256) view returns (uint256)",
  underlyingToken: "function underlyingToken() view returns (address)",
  // V1.14 Curve official registry (MetaRegistry / AddressProvider) and gauges.
  get_address: "function get_address(uint256) view returns (address)",
  get_pool_from_lp_token:
    "function get_pool_from_lp_token(address) view returns (address)",
  get_lp_token: "function get_lp_token(address) view returns (address)",
  get_n_coins: "function get_n_coins(address) view returns (uint256)",
  get_coins: "function get_coins(address) view returns (address[8])",
  get_balances: "function get_balances(address) view returns (uint256[8])",
  get_gauge: "function get_gauge(address) view returns (address)",
  is_meta: "function is_meta(address) view returns (bool)",
  get_base_pool: "function get_base_pool(address) view returns (address)",
  lp_token: "function lp_token() view returns (address)",
  // V1.14 Balancer V2 weighted pools.
  getPoolId: "function getPoolId() view returns (bytes32)",
  getPoolTokens:
    "function getPoolTokens(bytes32) view returns (address[],uint256[],uint256)",
  getVaultPool: "function getPool(bytes32) view returns (address,uint8)",
  getActualSupply: "function getActualSupply() view returns (uint256)",
  isPoolFromFactory: "function isPoolFromFactory(address) view returns (bool)",
  getVault: "function getVault() view returns (address)",
  // V1.14 Solidly-style (Aerodrome / Velodrome) basic pools and gauges.
  isPool: "function isPool(address) view returns (bool)",
  stable: "function stable() view returns (bool)",
  gauges: "function gauges(address) view returns (address)",
  earned: "function earned(address) view returns (uint256)",
  rewardToken: "function rewardToken() view returns (address)",
  stakingToken: "function stakingToken() view returns (address)",
} as const;
// View keys whose Solidity function name differs from the key (aliases for overloaded/conflicting names).
export const FUNCTION_NAME: Partial<Record<keyof typeof views, string>> = {
  poolFor: "getPool",
  slot0Pancake: "slot0",
  getVaultPool: "getPool",
};
export const functionName = (name: keyof typeof views) =>
  FUNCTION_NAME[name] ?? name;
export type ViewName = keyof typeof views;
const parsed = new Map<ViewName, Abi>();
// V1.14.1: each view ABI is parsed once (every coalesced read encodes and decodes through it).
export const abiFor = (name: ViewName): Abi => {
  let abi = parsed.get(name);
  if (!abi) parsed.set(name, (abi = parseAbi([views[name]])));
  return abi;
};
export const eventAbi = parseAbi([
  "event CreateMarket(bytes32 indexed id,(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams)",
  "event CreateMetaMorpho(address indexed metaMorpho,address indexed caller,address initialOwner,uint256 initialTimelock,address asset,string name,string symbol,bytes32 salt)",
  "event PairCreated(address indexed token0,address indexed token1,address pair,uint256)",
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
  "event Supply(bytes32 indexed id,address indexed caller,address indexed onBehalf,uint256 assets,uint256 shares)",
  "event Borrow(bytes32 indexed id,address caller,address indexed onBehalf,address indexed receiver,uint256 assets,uint256 shares)",
  "event SupplyCollateral(bytes32 indexed id,address indexed caller,address indexed onBehalf,uint256 assets)",
]);
