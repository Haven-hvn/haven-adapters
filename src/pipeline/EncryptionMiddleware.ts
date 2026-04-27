/**
 * Extension: EncryptionMiddleware
 * Role: REFERENCE EXTENSION — Inference pipeline middleware.
 * Priority: 30
 *
 * Direct TypeScript translation of spec/extensions/machines/EncryptionMiddleware.p
 * Mirrors lmstudio-bridge's taco-encrypt.ts middleware.
 *
 * Uses the same hybrid encryption scheme as lmstudio-bridge:
 *   1. AES-256-GCM encrypts the payload (fast, local, Node.js crypto)
 *   2. TACo (Threshold Access Control) wraps the AES key so only entities
 *      satisfying a DAO token-holder condition can decrypt it
 *
 * This enables auditors, DAO members, or other authorized entities to view
 * agent conversation logs — not just the agent itself. The AES key is never
 * stored in plaintext; it's threshold-encrypted via @nucypher/taco.
 *
 * Request stage: no-op pass-through.
 * Response stage: AES-256-GCM encrypt payload → TACo wrap key → store
 *   encrypted buffer + TACo metadata in context.
 * Fail-closed: emits eMiddlewareError if TACo not initialized or no key.
 *
 * Configuration (TacoEncryptConfig):
 *   - tacoDomain: TACo network domain (e.g., "lynx" for DEVNET)
 *   - ritualId: DKG ritual ID
 *   - daoContractAddress: ERC20/ERC721 contract for access gating
 *   - daoChain: Chain ID (e.g., 11155111 for Sepolia)
 *   - minimumBalance: Minimum token balance for decryption access
 *   - privateKey: Signer key for TACo operations (kept at Layer 2)
 *
 * States: Init → Ready
 */

import { Machine, MachineRegistry } from "haven-core/machine";
import type { PipelineContext } from "haven-core/types";
import { createCipheriv, randomBytes, createHash } from "crypto";

// ── AES-256-GCM constants (same as lmstudio-bridge) ────────────────────────

const AES_KEY_BYTES = 32; // 256 bits
const AES_IV_BYTES = 12;  // 96-bit nonce recommended for GCM
const AES_TAG_BYTES = 16; // 128-bit auth tag

// ── TACo Configuration ─────────────────────────────────────────────────────

export interface TacoEncryptConfig {
  /** TACo domain/network (e.g., "lynx" for DEVNET). */
  tacoDomain: string;
  /** DKG ritual ID. */
  ritualId: number;
  /** DAO token contract address for access gating. */
  daoContractAddress: string;
  /** Blockchain chain ID (e.g., 11155111 for Sepolia). */
  daoChain: number;
  /** Minimum token balance required for decryption (default: "1"). */
  minimumBalance?: string;
  /**
   * Private key for TACo signer. In production this would come from
   * WalletIdentity at Layer 2 via a signing request. For dev/testing
   * it can be provided directly.
   */
  privateKey?: string;
}

/**
 * TACo encryption metadata stored alongside the encrypted buffer.
 * Matches lmstudio-bridge's TacoEncryptionMetadata format for compatibility.
 */
export interface TacoEncryptionMetadata {
  version: "taco-v1";
  encryptedKey: string;  // Base64: TACo-wrapped AES key (ThresholdMessageKit)
  keyHash: string;       // SHA256 hex of the raw AES key (for verification)
  algorithm: "AES-GCM";
  keyLength: number;
  ivLengthBytes: number;
  tacoDomain: string;
  ritualId: number;
  condition: Record<string, unknown>;
  chain: number;
}

// ── AES helpers (same as lmstudio-bridge taco-encrypt.ts) ──────────────────

function aesEncrypt(
  plaintext: Buffer,
  key: Buffer,
  iv: Buffer,
): { ciphertext: Buffer; authTag: Buffer } {
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext: encrypted, authTag };
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// ── Machine ─────────────────────────────────────────────────────────────────

export class EncryptionMiddleware extends Machine {
  private pipeline: Machine;
  private tacoConfig: TacoEncryptConfig;

  /**
   * Session AES key — generated once per session, wrapped by TACo.
   * In lmstudio-bridge this is `cachedAESKey`.
   */
  private aesKey: Buffer | null = null;

  /** TACo-wrapped key metadata (stored with each encrypted payload). */
  private tacoMetadata: TacoEncryptionMetadata | null = null;

  /** Whether TACo SDK is available and initialized. */
  private tacoInitialized = false;

  /** TACo key wrapper — handles threshold encryption of the AES key. */
  private tacoKeyWrapper: any = null;

  constructor(
    registry: MachineRegistry,
    pipeline: Machine,
    tacoConfig: TacoEncryptConfig,
    id?: string,
  ) {
    super("EncryptionMiddleware", registry, id);
    this.pipeline = pipeline;
    this.tacoConfig = tacoConfig;
    this.defineStates();
  }

  async initialize(): Promise<void> {
    await this.init("Init");
  }

  private defineStates(): void {
    this.defineState("Init")
      .onEntry(async () => {
        this.sendTo(this.pipeline, "eRegisterMiddleware", {
          name: "encrypt", handler: this.id, priority: 30,
        });

        // Generate a fresh AES-256 session key.
        this.aesKey = randomBytes(AES_KEY_BYTES);
        const keyHash = sha256Hex(this.aesKey);

        // Build the DAO token-holder condition (same format as lmstudio-bridge).
        const condition: Record<string, unknown> = {
          contractAddress: this.tacoConfig.daoContractAddress.toLowerCase(),
          standardContractType: "ERC20",
          chain: this.tacoConfig.daoChain,
          method: "balanceOf",
          parameters: [":userAddress"],
          returnValueTest: {
            comparator: ">=",
            value: this.tacoConfig.minimumBalance || "1",
          },
        };

        // Initialize TACo SDK and wrap the AES key.
        // FAIL-CLOSED: If TACo is not available, encryption refuses to proceed.
        // We do NOT fall back to local-only encryption — without TACo wrapping,
        // nobody outside the agent could decrypt the logs, defeating the purpose.
        try {
          await this.initializeTaco(this.aesKey, condition);
          this.log(`TACo initialized — domain=${this.tacoConfig.tacoDomain} ritual=${this.tacoConfig.ritualId}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.log(`FATAL: TACo initialization failed — ${errMsg}`);
          this.log(`Encryption middleware will REJECT all payloads (fail-closed)`);

          // Wipe the AES key — no encryption without TACo wrapping.
          this.aesKey?.fill(0);
          this.aesKey = null;
          this.tacoMetadata = null;
        }

        this.log(`Initialized — tacoWrapped=${this.tacoInitialized} keyAvailable=${!!this.aesKey}`);
        this.goto("Ready");
      });

    this.defineState("Ready")
      .on("eMiddlewareRequest", (payload: { context: PipelineContext; request: any }) => {
        // Encryption only operates on the response stage.
        this.sendTo(this.pipeline, "eMiddlewareNext", payload.context);
      })
      .on("eMiddlewareResponse", (payload: { context: PipelineContext; response: any }) => {
        const ctx = { ...payload.context, metadata: { ...payload.context.metadata } };

        // Fail-closed if no AES key.
        if (!this.aesKey) {
          this.log(`[RESP ${ctx.requestId}] FAILED — no encryption key`);
          this.sendTo(this.pipeline, "eMiddlewareError", {
            middleware: "encrypt",
            error: "No encryption key available",
            context: ctx,
          });
          return;
        }

        // Determine what to encrypt: compressed buffer preferred, raw response as fallback.
        let plaintext: string;
        if (ctx.metadata["compressedBuffer"]) {
          plaintext = ctx.metadata["compressedBuffer"];
          this.log(`[RESP ${ctx.requestId}] Encrypting compressed buffer (${plaintext.length} chars)`);
        } else {
          plaintext = payload.response.response?.content ?? "";
          this.log(`[RESP ${ctx.requestId}] Encrypting raw response (no compression)`);
        }

        try {
          // Real AES-256-GCM encryption (same as lmstudio-bridge).
          const iv = randomBytes(AES_IV_BYTES);
          const plaintextBuf = Buffer.from(plaintext, "utf-8");
          const { ciphertext, authTag } = aesEncrypt(plaintextBuf, this.aesKey, iv);

          // Pack as: iv (12 bytes) + ciphertext + authTag (16 bytes)
          // Same layout as lmstudio-bridge: Buffer.concat([iv, ciphertext, authTag])
          const encryptedBuffer = Buffer.concat([iv, ciphertext, authTag]);
          const encryptedB64 = encryptedBuffer.toString("base64");

          ctx.metadata["encryptedBuffer"] = encryptedB64;
          ctx.metadata["encryption:algorithm"] = "aes-256-gcm";
          ctx.metadata["encryption:ivLength"] = String(AES_IV_BYTES);
          ctx.metadata["encryption:authTagLength"] = String(AES_TAG_BYTES);

          // Include TACo metadata so decryptors know how to unwrap the AES key.
          if (this.tacoMetadata) {
            ctx.metadata["encryption:tacoVersion"] = this.tacoMetadata.version;
            ctx.metadata["encryption:tacoDomain"] = this.tacoMetadata.tacoDomain;
            ctx.metadata["encryption:tacoRitualId"] = String(this.tacoMetadata.ritualId);
            ctx.metadata["encryption:tacoKeyHash"] = this.tacoMetadata.keyHash;
            ctx.metadata["encryption:tacoWrapped"] = String(this.tacoInitialized);
            ctx.metadata["encryption:publicKeyFingerprint"] = this.tacoMetadata.keyHash.slice(0, 16);

            // The wrapped key itself — needed by decryptors to recover the AES key.
            if (this.tacoMetadata.encryptedKey) {
              ctx.metadata["encryption:tacoEncryptedKey"] = this.tacoMetadata.encryptedKey;
            }
          }

          this.log(`[RESP ${ctx.requestId}] Encrypted — AES-256-GCM ${plaintextBuf.length} → ${encryptedBuffer.length} bytes, tacoWrapped=${this.tacoInitialized}`);
          this.sendTo(this.pipeline, "eMiddlewareNext", ctx);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.log(`[RESP ${ctx.requestId}] Encryption FAILED — ${errMsg}`);
          this.sendTo(this.pipeline, "eMiddlewareError", {
            middleware: "encrypt",
            error: `Encryption failed: ${errMsg}`,
            context: ctx,
          });
        }
      });
  }

  // ============================================================================
  // TACo SDK integration
  // ============================================================================

  /**
   * Initialize TACo and wrap the AES key via threshold encryption.
   * This makes the key recoverable by any wallet satisfying the DAO condition.
   *
   * Mirrors lmstudio-bridge's TacoKeyWrapper.initialize() + encryptKey().
   */
  private async initializeTaco(
    aesKey: Buffer,
    condition: Record<string, unknown>,
  ): Promise<void> {
    // Dynamic imports — TACo SDK is a required dependency.
    // If not installed, init fails and encryption refuses all payloads (fail-closed).
    const nucypherCore = await import("@nucypher/nucypher-core" as string);
    const tacoModule = await import("@nucypher/taco" as string);
    const ethersModule = await import("ethers" as string);

    const { encrypt, domains } = tacoModule;
    const ethers = ethersModule.ethers || ethersModule.default || ethersModule;

    // Initialize WASM if needed.
    if (nucypherCore.initSync) {
      const fs = await import("fs" as string);
      const path = await import("path" as string);
      const wasmPath = path.join(
        require.resolve("@nucypher/nucypher-core"),
        "..", "..", "nucypher_core_wasm_bg.wasm",
      );
      const wasmBytes = fs.readFileSync(wasmPath);
      nucypherCore.initSync(wasmBytes);
    }

    // Connect to Amoy (L2 chain for DEVNET Coordinator contract).
    const provider = new ethers.providers.JsonRpcProvider(
      "https://rpc-amoy.polygon.technology",
    );

    let signer: any = null;
    if (this.tacoConfig.privateKey) {
      const pk = this.tacoConfig.privateKey.startsWith("0x")
        ? this.tacoConfig.privateKey
        : `0x${this.tacoConfig.privateKey}`;
      const wallet = new ethers.Wallet(pk);
      signer = wallet.connect(provider);
    }

    if (!signer) {
      throw new Error("TACo requires a signer (privateKey in TacoEncryptConfig)");
    }

    // Build TACo condition object.
    const { ERC20Balance } = (tacoModule as any).conditions?.predefined?.erc20 ?? {};
    let conditionObj: any;
    if (ERC20Balance) {
      conditionObj = new ERC20Balance({
        contractAddress: this.tacoConfig.daoContractAddress.toLowerCase(),
        chain: this.tacoConfig.daoChain,
        returnValueTest: {
          comparator: ">=",
          value: this.tacoConfig.minimumBalance || "1",
        },
      });
    } else {
      // Fallback: use raw Condition class.
      const TacoCondition = (tacoModule as any).Condition;
      conditionObj = new TacoCondition(condition);
    }

    // Threshold-encrypt the AES key.
    const domain = (domains as any).DEVNET || this.tacoConfig.tacoDomain;
    const messageKit = await encrypt(
      provider, domain, aesKey, conditionObj,
      this.tacoConfig.ritualId, signer,
    );

    const encryptedKeyB64 = Buffer.from(messageKit.toBytes()).toString("base64");
    const keyHash = sha256Hex(aesKey);

    this.tacoMetadata = {
      version: "taco-v1",
      encryptedKey: encryptedKeyB64,
      keyHash,
      algorithm: "AES-GCM",
      keyLength: 256,
      ivLengthBytes: AES_IV_BYTES,
      tacoDomain: this.tacoConfig.tacoDomain,
      ritualId: this.tacoConfig.ritualId,
      condition,
      chain: this.tacoConfig.daoChain,
    };

    this.tacoInitialized = true;
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /** Get TACo encryption metadata (for external key recovery / auditing). */
  getTacoMetadata(): TacoEncryptionMetadata | null {
    return this.tacoMetadata ? { ...this.tacoMetadata } : null;
  }

  /** Check if TACo threshold wrapping is active. */
  isTacoWrapped(): boolean {
    return this.tacoInitialized;
  }
}
