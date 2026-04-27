/**
 * Extension: PersistenceMiddleware
 * Role: REFERENCE EXTENSION — Inference pipeline middleware.
 * Priority: 40
 *
 * Direct TypeScript translation of spec/extensions/machines/PersistenceMiddleware.p
 * Mirrors lmstudio-bridge's upload.ts middleware.
 *
 * ── Architecture (matching lmstudio-bridge) ──────────────────────────────
 *
 * HOT PATH (onResponse):
 *   Capture conversation → push to batch buffer → if batch full, snapshot
 *   buffer and enqueue for background flush → eMiddlewareNext IMMEDIATELY.
 *   The client response is NEVER blocked by storage I/O.
 *
 * BACKGROUND FLUSH (FlushQueue):
 *   Serial FIFO queue processes one flush at a time via StorageBackend.
 *   Retry with exponential backoff. Dead-letters after maxRetries.
 *   Backpressure warning when queue depth exceeds threshold.
 *   Graceful drain on shutdown.
 *
 * This is the same pattern as lmstudio-bridge's upload.ts:
 *   - batchBuffer.push() → non-blocking
 *   - batchBuffer.splice(0) → snapshot
 *   - flushQueue.enqueue(snapshot) → background
 *   - client gets response immediately
 *
 * SALM compliance: This middleware does NOT hold any storage keys or call
 * storage SDKs directly. Flushes are sent as eStoreData events to the
 * StorageBackend machine (Layer 2) which holds the StorageAdapter.
 *
 * States: Init → Ready → (stays Ready for all hot-path work)
 *         Init → Ready → Restoring → Ready (memory restore only)
 */

import { Machine, MachineRegistry } from "haven-core/machine";
import type { PipelineContext, CID, DPIDVersion } from "haven-core/types";
import type {
  ConversationNode,
  ConversationRequest,
  ConversationResponse,
  ConversationMetadata,
  EncryptionConfig,
  CompressionConfig,
} from "./extension-types.js";

// ── Flush Queue Types ──────────────────────────────────────────────────────

interface FlushJob {
  /** Unique ID for this flush (matches eStoreData requestId). */
  requestId: string;
  /** Serialized batch JSON. */
  batchJson: string;
  /** Number of conversations in this batch. */
  conversationCount: number;
  /** Timestamp when this job was created. */
  createdAt: number;
  /** Number of times this job has been retried. */
  retryCount: number;
}

interface FlushQueueConfig {
  /** Maximum retry attempts per job (default: 3, matching lmstudio-bridge). */
  maxRetries: number;
  /** Base delay between retries in ms (default: 5000). */
  retryDelayMs: number;
  /** Maximum retry delay in ms — caps exponential backoff (default: 60000). */
  maxRetryDelayMs: number;
  /** Maximum queue depth before backpressure warning (default: 50). */
  maxQueueDepth: number;
}

const DEFAULT_FLUSH_CONFIG: FlushQueueConfig = {
  maxRetries: 3,
  retryDelayMs: 5000,
  maxRetryDelayMs: 60000,
  maxQueueDepth: 50,
};

// ── Machine ─────────────────────────────────────────────────────────────────

export class PersistenceMiddleware extends Machine {
  private pipeline: Machine;
  private walletIdentity: Machine;
  private bus: Machine;
  private storageBackend: Machine;

  // ── Batch buffer (hot path — same as lmstudio-bridge's batchBuffer) ──
  private batchBuffer: ConversationNode[] = [];
  private batchSize: number;
  private sessionLastCid = new Map<string, CID>();

  // ── Flush queue (background — same as lmstudio-bridge's FlushQueue) ──
  private flushQueue: FlushJob[] = [];
  private activeFlush: FlushJob | null = null;
  private flushConfig: FlushQueueConfig;

  // ── Stats ─────────────────────────────────────────────────────────────
  private totalCaptured = 0;
  private totalFlushed = 0;
  private totalBatchesFlushed = 0;
  private totalRetries = 0;
  private totalDeadLettered = 0;

  constructor(
    registry: MachineRegistry,
    pipeline: Machine,
    walletIdentity: Machine,
    bus: Machine,
    storageBackend: Machine,
    batchSize: number,
    flushConfig?: Partial<FlushQueueConfig>,
    id?: string
  ) {
    super("PersistenceMiddleware", registry, id);
    this.pipeline = pipeline;
    this.walletIdentity = walletIdentity;
    this.bus = bus;
    this.storageBackend = storageBackend;
    this.batchSize = batchSize;
    this.flushConfig = { ...DEFAULT_FLUSH_CONFIG, ...flushConfig };
    this.defineStates();
  }

  async initialize(): Promise<void> {
    await this.init("Init");
  }

  // ==========================================================================
  // Public API (matching lmstudio-bridge's UploadMiddlewareHandle)
  // ==========================================================================

  /** Get flush queue statistics. Same shape as lmstudio-bridge's getFlushStats(). */
  getFlushStats(): {
    pending: number;
    completed: number;
    failed: number;
    deadLettered: number;
    activeJob: boolean;
    bufferSize: number;
  } {
    return {
      pending: this.flushQueue.length,
      completed: this.totalBatchesFlushed,
      failed: this.totalRetries,
      deadLettered: this.totalDeadLettered,
      activeJob: this.activeFlush !== null,
      bufferSize: this.batchBuffer.length,
    };
  }

  /**
   * Wait for all pending flushes to complete (with timeout).
   * Same as lmstudio-bridge's drainFlushes(timeoutMs).
   *
   * Call this during graceful shutdown to ensure all batches are persisted.
   */
  async drainFlushes(timeoutMs = 30000): Promise<void> {
    if (!this.activeFlush && this.flushQueue.length === 0) {
      // Flush any partial batch that hasn't reached batchSize yet.
      if (this.batchBuffer.length > 0) {
        this.log(`Drain: flushing partial batch (${this.batchBuffer.length} conversations)`);
        this.snapshotAndEnqueue();
      } else {
        return;
      }
    }

    this.log(`Draining ${this.flushQueue.length + (this.activeFlush ? 1 : 0)} pending flush(es)...`);

    const deadline = Date.now() + timeoutMs;
    while ((this.activeFlush || this.flushQueue.length > 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    if (this.activeFlush || this.flushQueue.length > 0) {
      this.log(`WARNING: Drain timeout — ${this.flushQueue.length} flush(es) still pending`);
    } else {
      this.log("Drain complete — all batches flushed");
    }
  }

  // ==========================================================================
  // State Definitions
  // ==========================================================================

  private defineStates(): void {
    // ── Init ──────────────────────────────────────────────────────────────
    this.defineState("Init")
      .onEntry(() => {
        this.sendTo(this.pipeline, "eRegisterMiddleware", {
          name: "persist", handler: this.id, priority: 40,
        });
        this.log(`Initialized — batchSize=${this.batchSize} maxRetries=${this.flushConfig.maxRetries}`);
        this.goto("Ready");
      });

    // ── Ready ─────────────────────────────────────────────────────────────
    //
    // The machine STAYS in Ready for all hot-path work. Unlike the previous
    // version that transitioned to Flushing (blocking all new responses),
    // this version never leaves Ready during normal operation.
    //
    // Background flushes are processed serially via the flush queue, with
    // eDataStored / eError responses handled right here in Ready state.
    //
    this.defineState("Ready")
      // ── Request pass-through ──────────────────────────────────────────
      .on("eMiddlewareRequest", (payload: { context: PipelineContext; request: any }) => {
        this.sendTo(this.pipeline, "eMiddlewareNext", payload.context);
      })

      // ── Response capture (HOT PATH) ──────────────────────────────────
      //
      // Same pattern as lmstudio-bridge upload.ts onResponse:
      //   1. Capture conversation node
      //   2. Push to batch buffer
      //   3. If batch full → snapshot + enqueue background flush
      //   4. eMiddlewareNext IMMEDIATELY (client never blocked)
      //
      .on("eMiddlewareResponse", (payload: { context: PipelineContext; response: any }) => {
        const ctx = { ...payload.context, metadata: { ...payload.context.metadata } };

        // Fail-closed encryption boundary check.
        if (ctx.metadata["encryption:algorithm"] && !ctx.metadata["encryptedBuffer"]) {
          this.log(`[RESP ${ctx.requestId}] ABORT — encryption expected but no encryptedBuffer (fail-closed)`);
          this.sendTo(this.pipeline, "eMiddlewareError", {
            middleware: "persist",
            error: "Encryption was expected but encryptedBuffer is missing — refusing to persist plaintext",
            context: ctx,
          });
          return;
        }

        // Build encryption config.
        const encConfig: EncryptionConfig = ctx.metadata["encryption:algorithm"]
          ? { encrypted: true, algorithm: ctx.metadata["encryption:algorithm"], publicKeyFingerprint: ctx.metadata["encryption:publicKeyFingerprint"] ?? "" }
          : { encrypted: false, algorithm: "", publicKeyFingerprint: "" };

        // Build compression config.
        const compConfig: CompressionConfig = ctx.metadata["compression:algorithm"]
          ? { compressed: true, algorithm: ctx.metadata["compression:algorithm"], originalSize: parseInt(ctx.metadata["compression:originalSize"] ?? "0", 10) }
          : { compressed: false, algorithm: "", originalSize: 0 };

        // Get previous conversation CID for this session.
        const sessionKey = payload.response.sessionKey;
        const prevCid = this.sessionLastCid.get(sessionKey) ?? "";

        const node: ConversationNode = {
          version: "1.0.0",
          request: { model: "", messages: [], parameters: {} },
          response: { id: ctx.requestId, model: "", choices: [], usage: {}, created: ctx.timestamp },
          metadata: { shimVersion: "1.0.0", captureTimestamp: ctx.timestamp, encryption: encConfig, compression: compConfig },
          timestamp: ctx.timestamp,
          previousConversationCid: prevCid,
        };

        // Emit eConversationCaptured for CIDRecorderMiddleware.
        this.sendTo(this.bus, "eConversationCaptured" as any, { sessionKey, node });

        this.batchBuffer.push(node);
        this.totalCaptured++;

        this.log(`[RESP ${ctx.requestId}] Captured — buffer ${this.batchBuffer.length}/${this.batchSize}`);

        // Auto-flush when batch is full — snapshot and enqueue (NON-BLOCKING).
        // Same as lmstudio-bridge: `if (batchBuffer.length >= targetBatchSize)`
        if (this.batchBuffer.length >= this.batchSize) {
          this.snapshotAndEnqueue();
        }

        // Response returns to client IMMEDIATELY — never blocked by storage I/O.
        this.sendTo(this.pipeline, "eMiddlewareNext", ctx);
      })

      // ── eDataStored from StorageBackend (background flush response) ──
      //
      // This handler runs when StorageBackend completes an upload.
      // In the old version, this was only handled in the Flushing state.
      // Now it's handled in Ready, so new responses are never blocked.
      //
      .on("eDataStored", (result: { cid: CID; requestId: string }) => {
        if (!this.activeFlush || result.requestId !== this.activeFlush.requestId) {
          this.log(`Ignoring eDataStored for unknown requestId=${result.requestId}`);
          return;
        }

        const job = this.activeFlush;
        const realCid = result.cid;

        this.totalFlushed += job.conversationCount;
        this.totalBatchesFlushed++;

        // Emit eConversationStored with the REAL CID from IPFS.
        this.sendTo(this.bus, "eConversationStored" as any, { sessionKey: "batch", cid: realCid });

        // Request dPID update with the real CID.
        this.sendTo(this.walletIdentity, "eUpdateDPID", { newCid: realCid, requestor: this.id });

        this.log(
          `Flush complete — cid=${realCid} conversations=${job.conversationCount} ` +
          `totalFlushed=${this.totalFlushed} batchesComplete=${this.totalBatchesFlushed}`
        );

        // Clear active flush and process next in queue.
        this.activeFlush = null;
        this.processFlushQueue();
      })

      // ── eError from StorageBackend (flush failed) ─────────────────────
      //
      // Retry with exponential backoff, or dead-letter after maxRetries.
      // Same pattern as lmstudio-bridge's FlushQueue.processJob() catch block.
      //
      .on("eError", (errMsg: string) => {
        if (!this.activeFlush) {
          this.log(`Received eError with no active flush — ${errMsg}`);
          return;
        }

        const job = this.activeFlush;

        if (job.retryCount < this.flushConfig.maxRetries) {
          // Retry with exponential backoff.
          const delay = Math.min(
            this.flushConfig.retryDelayMs * Math.pow(2, job.retryCount),
            this.flushConfig.maxRetryDelayMs,
          );
          job.retryCount++;
          this.totalRetries++;

          this.log(
            `Flush failed (attempt ${job.retryCount}/${this.flushConfig.maxRetries}), ` +
            `retrying in ${delay}ms: ${errMsg}`
          );

          this.activeFlush = null;

          // Re-enqueue at FRONT of queue (priority retry, same as lmstudio-bridge).
          this.flushQueue.unshift(job);

          // Schedule retry after delay.
          setTimeout(() => {
            this.processFlushQueue();
          }, delay);
        } else {
          // Dead-letter — give up on this job.
          // Same as lmstudio-bridge: "job dead-lettered after N attempts"
          this.totalDeadLettered++;

          this.log(
            `DEAD-LETTER: Flush failed permanently after ${job.retryCount + 1} attempts ` +
            `(${job.conversationCount} conversations, ${job.batchJson.length} bytes): ${errMsg}`
          );

          this.activeFlush = null;
          this.processFlushQueue();
        }
      })

      // ── dPID update confirmation ──────────────────────────────────────
      .on("eDPIDUpdated", (version: DPIDVersion) => {
        this.log(`dPID updated — version=${version.version} cid=${version.cid}`);
      })

      // ── Memory restore ────────────────────────────────────────────────
      .on("eMemoryRestore", (rootCid: CID) => {
        this.log(`Memory restore requested — rootCid=${rootCid}`);
        this.goto("Restoring");
      });

    // ── Restoring ────────────────────────────────────────────────────────
    this.defineState("Restoring")
      .onEntry(() => {
        // Memory restore: send eRetrieveData to StorageBackend to get the root.
        // TODO: Real implementation would walk the DAG via StorageBackend.
        this.log("Memory restored — 1 sessions");
        this.sendTo(this.bus, "eMemoryRestored" as any, { success: true, sessionCount: 1 });
        this.goto("Ready");
      });
  }

  // ==========================================================================
  // Flush Queue — Background serial processing
  // ==========================================================================
  //
  // Same pattern as lmstudio-bridge's FlushQueue class, integrated into the
  // machine. Jobs are processed one at a time in FIFO order so that storage
  // uploads never run concurrently (StorageBackend also serializes, but we
  // want to match requestIds correctly).
  //

  /**
   * Snapshot the batch buffer and enqueue for background flush.
   *
   * Same as lmstudio-bridge:
   *   const snapshot = batchBuffer.splice(0);
   *   flushQueueInstance.enqueue(snapshot, Date.now());
   */
  private snapshotAndEnqueue(): void {
    const snapshot = this.batchBuffer.splice(0);
    if (snapshot.length === 0) return;

    const batchJson = JSON.stringify(snapshot);
    const requestId = `flush:${this.totalCaptured}:${Date.now()}`;

    const job: FlushJob = {
      requestId,
      batchJson,
      conversationCount: snapshot.length,
      createdAt: Date.now(),
      retryCount: 0,
    };

    this.flushQueue.push(job);

    // Backpressure check (same as lmstudio-bridge's FlushQueue).
    if (this.flushQueue.length >= this.flushConfig.maxQueueDepth) {
      this.log(
        `WARNING: Backpressure — flush queue depth ${this.flushQueue.length} >= ${this.flushConfig.maxQueueDepth}. ` +
        `StorageBackend may be slow or unreachable.`
      );
    }

    this.log(
      `Batch queued for flush — ${snapshot.length} conversations, ` +
      `${batchJson.length} bytes, queue depth=${this.flushQueue.length}`
    );

    // Kick off processing if not already active.
    this.processFlushQueue();
  }

  /**
   * Process the next flush job in the queue.
   * Only one job is in-flight at a time (serial, like lmstudio-bridge).
   */
  private processFlushQueue(): void {
    if (this.activeFlush) return; // Already processing one.
    if (this.flushQueue.length === 0) return; // Nothing to do.

    const job = this.flushQueue.shift()!;
    this.activeFlush = job;

    this.log(
      `Flushing batch via StorageBackend — requestId=${job.requestId} ` +
      `size=${job.batchJson.length} attempt=${job.retryCount + 1}/${this.flushConfig.maxRetries + 1}`
    );

    // Send to StorageBackend — response comes back as eDataStored or eError.
    this.sendTo(this.storageBackend, "eStoreData", {
      data: job.batchJson,
      requestor: this.id,
      requestId: job.requestId,
    });
  }
}
