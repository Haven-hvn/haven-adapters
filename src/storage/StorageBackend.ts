/**
 * Machine: StorageBackend
 * Role: EXTENSION — Layer 2 (Identity & Persistence)
 *
 * The SALM-compliant storage boundary. All IPFS/content-addressed storage
 * I/O goes through this machine. Higher-layer machines (PersistenceMiddleware
 * at L5/6, StoragePinManager at L2/5) never hold storage keys or call
 * storage SDKs directly — they send events to this machine.
 *
 * Mirrors the CryptoAdapter pattern:
 *   - CryptoAdapter   → injected into WalletIdentity (signing boundary)
 *   - StorageAdapter   → injected into StorageBackend (persistence boundary)
 *
 * The StorageAdapter holds the private key / auth credentials for the
 * storage backend (Synapse, Helia, Pinata, etc.). This key NEVER leaves
 * Layer 2, per SALM rule: "The private key NEVER leaves this layer."
 *
 * Events consumed:
 *   eStoreData      → serialize + upload to IPFS → respond eDataStored { cid }
 *   eRetrieveData   → download from IPFS by CID → respond eDataRetrieved { data }
 *   ePinCheck       → check pin health → respond ePinStatus
 *   ePinRenew       → renew pin → respond ePinRenewed
 *
 * States: Init → Ready → Storing → Ready
 *                Ready → Retrieving → Ready
 *                Ready → CheckingPin → Ready
 *                Ready → RenewingPin → Ready
 */

import { Machine, MachineRegistry } from "haven-core/machine";
import type { StorageAdapter } from "haven-core/interfaces";
import type { CID } from "haven-core/types";

export class StorageBackend extends Machine {
  private adapter: StorageAdapter | null = null;

  /** Operation queues — StorageBackend serializes I/O to avoid concurrent SDK calls. */
  private opQueue: Array<{
    type: "store" | "retrieve" | "checkPin" | "renewPin";
    payload: any;
  }> = [];

  private totalStores = 0;
  private totalRetrieves = 0;
  private totalPinChecks = 0;
  private totalPinRenewals = 0;

  constructor(registry: MachineRegistry, id?: string) {
    super("StorageBackend", registry, id);
    this.defineStates();
  }

  async initialize(): Promise<void> {
    await this.init("Init");
  }

  /**
   * Inject a storage adapter. Must be called after construction, before initialize().
   * Same lifecycle as WalletIdentity.setCryptoAdapter().
   */
  setStorageAdapter(adapter: StorageAdapter): void {
    this.adapter = adapter;
    this.log("StorageAdapter injected");
  }

  private defineStates(): void {
    // ========================================================================
    // Init
    // ========================================================================
    this.defineState("Init")
      .onEntry(() => {
        if (!this.adapter) {
          this.log("WARNING: No StorageAdapter injected — storage operations will fail");
        } else {
          this.log("Initialized with StorageAdapter");
        }
        this.goto("Ready");
      });

    // ========================================================================
    // Ready — Accepting storage requests
    // ========================================================================
    this.defineState("Ready")
      .onEntry(() => {
        // Process queued operations.
        if (this.opQueue.length > 0) {
          const op = this.opQueue.shift()!;
          switch (op.type) {
            case "store": this.goto("Storing", op.payload); break;
            case "retrieve": this.goto("Retrieving", op.payload); break;
            case "checkPin": this.goto("CheckingPin", op.payload); break;
            case "renewPin": this.goto("RenewingPin", op.payload); break;
          }
          return;
        }
      })
      .on("eStoreData", (req: { data: string; requestor: string; requestId: string }) => {
        this.goto("Storing", req);
      })
      .on("eRetrieveData", (req: { cid: CID; requestor: string; requestId: string }) => {
        this.goto("Retrieving", req);
      })
      .on("ePinCheck", (req: { cid: CID; requestor: string; requestId: string }) => {
        this.goto("CheckingPin", req);
      })
      .on("ePinRenew", (req: { cid: CID; requestor: string; requestId: string }) => {
        this.goto("RenewingPin", req);
      });

    // ========================================================================
    // Storing — Upload data to IPFS via adapter
    // ========================================================================
    this.defineState("Storing")
      .onEntry(async (req: { data: string; requestor: string; requestId: string }) => {
        this.totalStores++;
        this.log(`Storing data — requestId=${req.requestId} size=${req.data.length}`);

        if (!this.adapter) {
          this.log(`Store FAILED — no adapter`);
          this.sendById(req.requestor, "eError", "StorageBackend: no adapter configured");
          this.goto("Ready");
          return;
        }

        try {
          const bytes = new TextEncoder().encode(req.data);
          const result = await this.adapter.store(bytes);
          this.log(`Stored — cid=${result.cid} (total=${this.totalStores})`);
          this.sendById(req.requestor, "eDataStored", {
            cid: result.cid,
            requestId: req.requestId,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.log(`Store FAILED — ${errMsg}`);
          this.sendById(req.requestor, "eError", `StorageBackend store failed: ${errMsg}`);
        }

        this.goto("Ready");
      })
      // Queue operations that arrive while storing.
      .on("eStoreData", (req) => { this.opQueue.push({ type: "store", payload: req }); })
      .on("eRetrieveData", (req) => { this.opQueue.push({ type: "retrieve", payload: req }); })
      .on("ePinCheck", (req) => { this.opQueue.push({ type: "checkPin", payload: req }); })
      .on("ePinRenew", (req) => { this.opQueue.push({ type: "renewPin", payload: req }); });

    // ========================================================================
    // Retrieving — Download data from IPFS by CID
    // ========================================================================
    this.defineState("Retrieving")
      .onEntry(async (req: { cid: CID; requestor: string; requestId: string }) => {
        this.totalRetrieves++;
        this.log(`Retrieving — cid=${req.cid}`);

        if (!this.adapter) {
          this.log(`Retrieve FAILED — no adapter`);
          this.sendById(req.requestor, "eError", "StorageBackend: no adapter configured");
          this.goto("Ready");
          return;
        }

        try {
          const result = await this.adapter.retrieve(req.cid);
          const text = new TextDecoder().decode(result.data);
          this.log(`Retrieved — cid=${req.cid} size=${text.length} (total=${this.totalRetrieves})`);
          this.sendById(req.requestor, "eDataRetrieved", {
            cid: req.cid,
            data: text,
            requestId: req.requestId,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.log(`Retrieve FAILED — ${errMsg}`);
          this.sendById(req.requestor, "eError", `StorageBackend retrieve failed: ${errMsg}`);
        }

        this.goto("Ready");
      })
      .on("eStoreData", (req) => { this.opQueue.push({ type: "store", payload: req }); })
      .on("eRetrieveData", (req) => { this.opQueue.push({ type: "retrieve", payload: req }); })
      .on("ePinCheck", (req) => { this.opQueue.push({ type: "checkPin", payload: req }); })
      .on("ePinRenew", (req) => { this.opQueue.push({ type: "renewPin", payload: req }); });

    // ========================================================================
    // CheckingPin — Check IPFS pin status
    // ========================================================================
    this.defineState("CheckingPin")
      .onEntry(async (req: { cid: CID; requestor: string; requestId: string }) => {
        this.totalPinChecks++;
        this.log(`Checking pin — cid=${req.cid}`);

        if (!this.adapter) {
          this.log(`Pin check FAILED — no adapter`);
          this.sendById(req.requestor, "eError", "StorageBackend: no adapter configured");
          this.goto("Ready");
          return;
        }

        try {
          const status = await this.adapter.checkPin(req.cid);
          this.log(`Pin status — cid=${req.cid} provider=${status.provider} expires=${status.expiresAt} redundancy=${status.redundancy}`);
          this.sendById(req.requestor, "ePinStatus", {
            cid: status.cid,
            provider: status.provider,
            expiresAt: status.expiresAt,
            redundancy: status.redundancy,
            requestId: req.requestId,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.log(`Pin check FAILED — ${errMsg}`);
          this.sendById(req.requestor, "eError", `StorageBackend pin check failed: ${errMsg}`);
        }

        this.goto("Ready");
      })
      .on("eStoreData", (req) => { this.opQueue.push({ type: "store", payload: req }); })
      .on("eRetrieveData", (req) => { this.opQueue.push({ type: "retrieve", payload: req }); })
      .on("ePinCheck", (req) => { this.opQueue.push({ type: "checkPin", payload: req }); })
      .on("ePinRenew", (req) => { this.opQueue.push({ type: "renewPin", payload: req }); });

    // ========================================================================
    // RenewingPin — Renew/extend an IPFS pin
    // ========================================================================
    this.defineState("RenewingPin")
      .onEntry(async (req: { cid: CID; requestor: string; requestId: string }) => {
        this.totalPinRenewals++;
        this.log(`Renewing pin — cid=${req.cid}`);

        if (!this.adapter) {
          this.log(`Pin renewal FAILED — no adapter`);
          this.sendById(req.requestor, "eError", "StorageBackend: no adapter configured");
          this.goto("Ready");
          return;
        }

        try {
          const status = await this.adapter.renewPin(req.cid);
          this.log(`Pin renewed — cid=${req.cid} provider=${status.provider} (total=${this.totalPinRenewals})`);
          this.sendById(req.requestor, "ePinRenewed", {
            cid: status.cid,
            provider: status.provider,
            expiresAt: status.expiresAt,
            redundancy: status.redundancy,
            requestId: req.requestId,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.log(`Pin renewal FAILED — ${errMsg}`);
          this.sendById(req.requestor, "eError", `StorageBackend pin renewal failed: ${errMsg}`);
        }

        this.goto("Ready");
      })
      .on("eStoreData", (req) => { this.opQueue.push({ type: "store", payload: req }); })
      .on("eRetrieveData", (req) => { this.opQueue.push({ type: "retrieve", payload: req }); })
      .on("ePinCheck", (req) => { this.opQueue.push({ type: "checkPin", payload: req }); })
      .on("ePinRenew", (req) => { this.opQueue.push({ type: "renewPin", payload: req }); });
  }
}
