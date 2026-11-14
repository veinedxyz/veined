import { isAddress } from "viem";
import { base58, base32, bech32, bech32m } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Network, Ecosystem } from "./model";
function checked58(value: string, version: number, length: number) {
  const b = base58.decode(value),
    payload = b.slice(0, -4),
    digest = sha256(sha256(payload));
  return (
    b.length === length &&
    b[0] === version &&
    b.slice(-4).every((v, i) => v === digest[i]) &&
    payload.slice(1).some((v) => v !== 0)
  );
}
function bitcoin(value: string) {
  if (value.startsWith("bc1")) {
    const decoder = value.toLowerCase().startsWith("bc1q") ? bech32 : bech32m;
    const decoded = decoder.decode(value as `${string}1${string}`, 90);
    const version = decoded.words[0];
    const bytes = decoder.fromWords(decoded.words.slice(1));
    return (
      decoded.prefix === "bc" &&
      version >= 0 &&
      version <= 16 &&
      bytes.length >= 2 &&
      bytes.length <= 40 &&
      (version !== 0 || bytes.length === 20 || bytes.length === 32)
    );
  }
  return checked58(value, 0, 25) || checked58(value, 5, 25);
}
function stellar(value: string) {
  if (!/^G[A-Z2-7]{55}$/.test(value)) return false;
  const b = base32.decode(value),
    payload = b.slice(0, -2);
  let crc = 0;
  for (const byte of payload) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++)
      crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return (
    b.length === 35 &&
    b[0] === 48 &&
    b[33] === (crc & 255) &&
    b[34] === crc >> 8
  );
}
export function validAddress(
  ecosystem: Ecosystem,
  value: string,
  networkKey?: string,
): boolean {
  if (!value || value.length > 128 || value.trim() !== value) return false;
  try {
    switch (ecosystem) {
      case "EVM":
        return isAddress(value, { strict: true }) && !/^0x0{40}$/i.test(value);
      case "SVM": {
        const bytes = base58.decode(value);
        return bytes.length === 32 && bytes.some((v) => v !== 0);
      }
      case "MVM":
        return /^0x[0-9a-fA-F]{64}$/.test(value) && !/^0x0{64}$/.test(value);
      case "TVM":
        return checked58(value, 0x41, 25);
      case "STL":
        return stellar(value);
      case "UTXO":
        return networkKey === "btc" && bitcoin(value);
    }
  } catch {
    return false;
  }
}
export function ecosystemReason(
  network: Network,
  value: string,
): string | undefined {
  if (network.ecosystem === "UTXO" && network.key !== "btc")
    return "WALLET_ECOSYSTEM_UNSUPPORTED";
  return validAddress(network.ecosystem, value, network.key)
    ? undefined
    : "INVALID_ADDRESS";
}
