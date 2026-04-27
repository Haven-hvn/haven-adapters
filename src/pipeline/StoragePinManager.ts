/**
 * Extension: StoragePinManager
 * Role: REFERENCE EXTENSION — Self-sustaining IPFS pin lifecycle.
 *
 * Direct TypeScript translation of spec/extensions/machines/StoragePinManager.p
 *
 * Monitors IPFS pin status and autonomously renews pins before expiry,
 * funded by Treasury via the STORAGE budget category.
 *
 * SALM compliance: This machine does NOT call IPFS/Synapse APIs directly.
 * All storage I/O goes through StorageBackend (Layer 2) via events:
 *   - ePinCheck → StorageBackend → ePinStatus
 *   - ePinRenew → StorageBackend → ePinRenewed
 *
 * States: Init → Monitoring → CheckingPins → Renewing → Monitoring
 */

import { Machine, MachineRegistry } from "haven-core/machine";
import type { CID, DPIDVersion, SessionKey, CostEstimate, Expense } from "haven-core/types";
import { BudgetCategory } from "haven-core/types";
import type { PinStatus } from "./extension-types.js";

export class StoragePinManager extends Machine {
  private treasury: Machine;
  private bus: Machine;
  private storageBackend: Machine;

  private rootCid: CID = "";
  private trackedCids: CID[] = [];
  private renewalThresholdDays: number;
  private storageProvider: string;

  private pendingAuthRequestId = "";
  private pendingRenewCid: CID = "";
  private pendingPinCheckRequestId = "";
  private pendingPinRenewRequestId = "";
  private totalRenewals = 0;
  private totalChecks = 0;

  constructor(
    registry: MachineRegistry,
    treasury: Machine,
    bus: Machine,
    storageBackend: Machine,
    storageProvider: string,
    renewalThresholdDays: number,
    id?: string
  ) {
    super("StoragePinManager", registry, id);
    this.treasury = treasury;
    this.bus = bus;
    this.storageBackend = storageBackend;
    this.storageProvider = storageProvider;
    this.renewalThresholdDays = renewalThresholdDays;
    this.defineStates();
  }

  async initialize(): Promise<void> {
    await this.init("Init");
  }

  private defineStates(): void {
    this.defineState("Init")
      .onEntry(() => {
        this.log(`Initialized — provider=${this.storageProvider} threshold=${this.renewalThresholdDays}d`);
        this.goto("Monitoring");
      });

    // ========================================================================
    // Monitoring — Waiting for heartbeat ticks and dPID updates
    // ========================================================================
    this.defineState("Monitoring")
      .onEntry(() => {
        this.log(`Monitoring — rootCid=${this.rootCid} tracked=${this.trackedCids.length}`);
      })
      .on("eHeartbeatTick" as any, () => {
        if (!this.rootCid) {
          this.log("No root CID — skipping pin check");
          return;
        }
        this.goto("CheckingPins");
      })
      .on("eDPIDUpdated", (version: DPIDVersion) => {
        const oldRoot = this.rootCid;
        this.rootCid = version.cid;
        if (oldRoot && oldRoot !== this.rootCid) {
          this.trackedCids.push(oldRoot);
        }
        this.log(`Root CID updated — ${oldRoot} → ${this.rootCid}`);
      })
      .on("eConversationStored" as any, (stored: { sessionKey: SessionKey; cid: CID }) => {
        this.trackedCids.push(stored.cid);
        this.log(`Tracking new conversation CID — ${stored.cid}`);
      });

    // ========================================================================
    // CheckingPins — Send ePinCheck to StorageBackend
    // ========================================================================
    this.defineState("CheckingPins")
      .onEntry(() => {
        this.totalChecks++;
        this.pendingPinCheckRequestId = `pincheck:${this.rootCid}:${this.totalChecks}`;
        this.log(`Checking pin status — rootCid=${this.rootCid}`);

        // Send to StorageBackend (Layer 2) — NOT directly to IPFS.
        this.sendTo(this.storageBackend, "ePinCheck", {
          cid: this.rootCid,
          requestor: this.id,
          requestId: this.pendingPinCheckRequestId,
        });
      })
      .on("ePinStatus", (status: PinStatus & { requestId?: string }) => {
        if (status.requestId && status.requestId !== this.pendingPinCheckRequestId) return;

        if (status.expiresAt === 0) {
          this.log(`Pin ${status.cid} is permanent — OK`);
          this.goto("Monitoring");
          return;
        }

        if (status.expiresAt > 0 && status.redundancy > 0) {
          this.log(`Pin ${status.cid} expires at ${status.expiresAt} — checking threshold`);
          this.sendTo(this.bus, "ePinExpiring" as any, { cid: status.cid, daysLeft: status.expiresAt });

          this.pendingRenewCid = status.cid;
          this.pendingAuthRequestId = `pin-renew:${status.cid}:${this.totalChecks}`;

          const estimate: CostEstimate = { amounts: [], category: BudgetCategory.STORAGE };
          this.sendTo(this.treasury, "eCostAuthorize", {
            requestId: this.pendingAuthRequestId,
            estimate,
            requestor: this.id,
          });

          this.goto("Renewing");
          return;
        }

        this.log(`Pin ${status.cid} is healthy — redundancy=${status.redundancy}`);
        this.goto("Monitoring");
      })
      .on("eError", () => {
        this.log("Pin check error");
        this.goto("Monitoring");
      });

    // ========================================================================
    // Renewing — Treasury-gated pin renewal via StorageBackend
    // ========================================================================
    this.defineState("Renewing")
      .onEntry(() => {
        this.log(`Awaiting Treasury authorization for pin renewal — ${this.pendingRenewCid}`);
      })
      .on("eCostAuthorized", (auth: { requestId: string; approved: boolean; reason: string }) => {
        if (auth.requestId !== this.pendingAuthRequestId) return;

        if (auth.approved) {
          this.log(`Treasury approved — renewing pin ${this.pendingRenewCid} via StorageBackend`);
          this.pendingPinRenewRequestId = `pinrenew:${this.pendingRenewCid}:${this.totalChecks}`;

          // Send to StorageBackend (Layer 2) — NOT directly to IPFS.
          this.sendTo(this.storageBackend, "ePinRenew", {
            cid: this.pendingRenewCid,
            requestor: this.id,
            requestId: this.pendingPinRenewRequestId,
          });
        } else {
          this.log(`Treasury denied pin renewal — ${this.pendingRenewCid}: ${auth.reason}`);
          this.pendingRenewCid = "";
          this.pendingAuthRequestId = "";
          this.goto("Monitoring");
        }
      })
      .on("ePinRenewed", (status: PinStatus & { requestId?: string }) => {
        if (status.requestId && status.requestId !== this.pendingPinRenewRequestId) return;

        this.totalRenewals++;
        this.log(`Pin renewed — cid=${status.cid} provider=${status.provider} (total renewals=${this.totalRenewals})`);

        const expense: Expense = {
          timestamp: Date.now(),
          category: BudgetCategory.STORAGE,
          token: "FIL",
          amount: 0,
          description: `Pin renewal: ${status.cid}`,
        };
        this.sendTo(this.treasury, "eExpenseRecord", expense);

        this.pendingRenewCid = "";
        this.pendingAuthRequestId = "";
        this.pendingPinRenewRequestId = "";
        this.goto("Monitoring");
      })
      .on("eError", () => {
        this.log("Pin renewal failed");
        this.pendingRenewCid = "";
        this.pendingAuthRequestId = "";
        this.pendingPinRenewRequestId = "";
        this.goto("Monitoring");
      });
  }
}
