"use client";
import ScanCenter from "./scan-center";
export default function WalletActivity({
  account,
  onConnect,
}: {
  account?: string;
  onConnect?: () => void;
}) {
  return <ScanCenter account={account} onConnect={onConnect} compact />;
}
