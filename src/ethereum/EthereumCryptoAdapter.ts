/**
 * EthereumCryptoAdapter — viem-based CryptoAdapter for Ethereum wallets.
 *
 * Lives in the adapter layer — the kernel never imports viem.
 * Injected into WalletIdentity via setCryptoAdapter() after construction,
 * before initialize().
 *
 * Follows the pattern from shoutbox-bot/src/xmtpSigner.ts — uses
 * privateKeyToAccount() from viem/accounts.
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import type { CryptoAdapter } from "haven-core/interfaces";
import type { Address, Signature } from "haven-core/types";

/**
 * Create an Ethereum CryptoAdapter using viem.
 *
 * The adapter loads a private key, derives the Ethereum address, and
 * provides message/transaction signing via the viem Account API.
 *
 * Key source formats:
 *   - "env:VAR_NAME" — reads hex key from environment variable
 *   - "0x..." — raw hex private key (development only)
 */
export function createEthereumCryptoAdapter(): CryptoAdapter {
  return {
    async loadKey(
      keySource: string
    ): Promise<{ address: Address; keyMaterial: unknown }> {
      let hexKey: Hex;

      if (keySource.startsWith("env:")) {
        const envVar = keySource.slice(4);
        const raw = process.env[envVar];
        if (!raw) {
          throw new Error(
            `Environment variable ${envVar} not set`
          );
        }
        hexKey = raw as Hex;
      } else if (keySource.startsWith("0x")) {
        hexKey = keySource as Hex;
      } else {
        throw new Error(
          `Unsupported key source format: ${keySource} (expected "env:VAR" or "0x...")`
        );
      }

      const account = privateKeyToAccount(hexKey);
      return {
        address: account.address,
        keyMaterial: account,
      };
    },

    async signMessage(
      keyMaterial: unknown,
      payload: string
    ): Promise<Signature> {
      const account = keyMaterial as ReturnType<typeof privateKeyToAccount>;
      return await account.signMessage({ message: payload });
    },

    async signTransaction(
      keyMaterial: unknown,
      payload: string
    ): Promise<Signature> {
      const account = keyMaterial as ReturnType<typeof privateKeyToAccount>;
      const txParams = JSON.parse(payload);
      return await account.signTransaction(txParams);
    },
  };
}
