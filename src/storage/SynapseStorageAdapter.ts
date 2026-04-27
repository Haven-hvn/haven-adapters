/**
 * SynapseStorageAdapter — StorageAdapter implementation backed by Synapse SDK.
 *
 * Lives at Layer 2 (Identity & Persistence). The Synapse private key stays
 * inside this adapter — it never leaks to higher layers.
 *
 * Follows the same pattern as EthereumCryptoAdapter:
 *   - Factory function creates the adapter
 *   - Injected into StorageBackend via setStorageAdapter()
 *   - The adapter holds all SDK-specific state (client, auth, etc.)
 *
 * The Synapse SDK authenticates uploads with a private key. This key is
 * distinct from the agent's identity key (WalletIdentity) — it's a
 * storage-specific credential. Both live at Layer 2 per SALM.
 *
 * Key source formats:
 *   - "env:VAR_NAME" — reads hex key from environment variable
 *   - "0x..." — raw hex private key (development only)
 *
 * Configuration:
 *   - synapseUrl: URL of the Synapse node (default: http://127.0.0.1:5001)
 *   - storageKey: Private key source for Synapse auth
 *
 * NOTE: This is a scaffold for the real Synapse SDK integration.
 * The actual SDK calls (synapse.upload, synapse.retrieve, etc.) will be
 * filled in when the Synapse SDK package is added as a dependency.
 * For now, the adapter uses fetch-based IPFS HTTP API as a reference
 * implementation that works with any Kubo/IPFS node.
 */

import type { StorageAdapter } from "haven-core/interfaces";

export interface SynapseStorageAdapterConfig {
  /** URL of the Synapse/IPFS node HTTP API. Default: "http://127.0.0.1:5001" */
  synapseUrl?: string;
  /** Private key source for Synapse authentication (e.g., "env:SYNAPSE_KEY" or "0x...") */
  storageKey?: string;
}

/**
 * Create a Synapse-backed StorageAdapter.
 *
 * The returned adapter implements the StorageAdapter interface from haven-core.
 * All IPFS I/O and authentication is encapsulated — higher layers only see
 * store(bytes) → cid, retrieve(cid) → bytes, checkPin(cid) → status.
 */
export function createSynapseStorageAdapter(
  config: SynapseStorageAdapterConfig = {}
): StorageAdapter {
  const baseUrl = (config.synapseUrl || "http://127.0.0.1:5001").replace(/\/+$/, "");
  const storageKey = resolveKey(config.storageKey || "");

  return {
    async store(data: Uint8Array): Promise<{ cid: string }> {
      // POST /api/v0/add — standard IPFS HTTP API
      // When Synapse SDK is available, replace with: synapse.upload(data)
      const formData = new FormData();
      formData.append("file", new Blob([data]));

      const response = await fetch(`${baseUrl}/api/v0/add?cid-version=1`, {
        method: "POST",
        body: formData,
        headers: buildAuthHeaders(storageKey),
      });

      if (!response.ok) {
        throw new Error(`IPFS add failed: ${response.status} ${response.statusText}`);
      }

      const result = await response.json() as { Hash: string; Size: string };
      return { cid: result.Hash };
    },

    async retrieve(cid: string): Promise<{ data: Uint8Array }> {
      // POST /api/v0/cat — standard IPFS HTTP API
      // When Synapse SDK is available, replace with: synapse.retrieve(cid)
      const response = await fetch(`${baseUrl}/api/v0/cat?arg=${cid}`, {
        method: "POST",
        headers: buildAuthHeaders(storageKey),
      });

      if (!response.ok) {
        throw new Error(`IPFS cat failed: ${response.status} ${response.statusText}`);
      }

      const buffer = await response.arrayBuffer();
      return { data: new Uint8Array(buffer) };
    },

    async checkPin(cid: string): Promise<{
      cid: string;
      provider: string;
      expiresAt: number;
      redundancy: number;
    }> {
      // POST /api/v0/pin/ls — check if CID is pinned
      // When Synapse SDK is available, replace with: synapse.pinStatus(cid)
      try {
        const response = await fetch(`${baseUrl}/api/v0/pin/ls?arg=${cid}&type=all`, {
          method: "POST",
          headers: buildAuthHeaders(storageKey),
        });

        if (!response.ok) {
          return { cid, provider: "synapse", expiresAt: -1, redundancy: 0 };
        }

        const result = await response.json() as { Keys: Record<string, { Type: string }> };
        const pinned = result.Keys && result.Keys[cid];

        if (pinned) {
          return {
            cid,
            provider: "synapse",
            expiresAt: 0, // Local pins don't expire (0 = permanent)
            redundancy: 1,
          };
        }

        return { cid, provider: "synapse", expiresAt: -1, redundancy: 0 };
      } catch {
        return { cid, provider: "synapse", expiresAt: -1, redundancy: 0 };
      }
    },

    async renewPin(cid: string): Promise<{
      cid: string;
      provider: string;
      expiresAt: number;
      redundancy: number;
    }> {
      // POST /api/v0/pin/add — re-pin the CID
      // When Synapse SDK is available, replace with: synapse.renewPin(cid)
      const response = await fetch(`${baseUrl}/api/v0/pin/add?arg=${cid}`, {
        method: "POST",
        headers: buildAuthHeaders(storageKey),
      });

      if (!response.ok) {
        throw new Error(`IPFS pin/add failed: ${response.status} ${response.statusText}`);
      }

      return {
        cid,
        provider: "synapse",
        expiresAt: 0, // Renewed = permanent for local node
        redundancy: 1,
      };
    },
  };
}

// =============================================================================
// Internal helpers
// =============================================================================

function resolveKey(keySource: string): string {
  if (!keySource) return "";

  if (keySource.startsWith("env:")) {
    const envVar = keySource.slice(4);
    return process.env[envVar] || "";
  }

  if (keySource.startsWith("0x")) {
    return keySource;
  }

  return "";
}

function buildAuthHeaders(key: string): Record<string, string> {
  if (!key) return {};
  // Synapse SDK authentication header format.
  // When the real SDK is integrated, this becomes: synapse.authHeaders(key)
  return { "Authorization": `Bearer ${key}` };
}
