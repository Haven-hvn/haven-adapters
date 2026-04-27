/**
 * Extension: CIDRecorderMiddleware
 * Role: REFERENCE EXTENSION — Inference pipeline middleware.
 * Priority: 50
 *
 * Direct TypeScript translation of spec/extensions/machines/CIDRecorderMiddleware.p
 * Mirrors lmstudio-bridge's cid-recorder.ts middleware.
 *
 * Response stage: prepares index metadata in context.
 * Also listens for eConversationStored/eConversationCaptured events.
 *
 * States: Init → Ready
 */

import { Machine, MachineRegistry } from "haven-core/machine";
import type { PipelineContext, CID, SessionKey } from "haven-core/types";
import type { ConversationIndexEntry, ConversationNode } from "./extension-types.js";

export class CIDRecorderMiddleware extends Machine {
  private pipeline: Machine;
  private index: ConversationIndexEntry[] = [];
  private totalRecorded = 0;

  constructor(registry: MachineRegistry, pipeline: Machine, id?: string) {
    super("CIDRecorderMiddleware", registry, id);
    this.pipeline = pipeline;
    this.defineStates();
  }

  async initialize(): Promise<void> {
    await this.init("Init");
  }

  private defineStates(): void {
    this.defineState("Init")
      .onEntry(() => {
        this.sendTo(this.pipeline, "eRegisterMiddleware", {
          name: "cid-recorder", handler: this.id, priority: 50,
        });
        this.log("Initialized — registered with pipeline (priority 50)");
        this.goto("Ready");
      });

    this.defineState("Ready")
      .on("eMiddlewareRequest", (payload: { context: PipelineContext; request: any }) => {
        this.sendTo(this.pipeline, "eMiddlewareNext", payload.context);
      })
      .on("eMiddlewareResponse", (payload: { context: PipelineContext; response: any }) => {
        const ctx = { ...payload.context, metadata: { ...payload.context.metadata } };
        ctx.metadata["cidrecorder:sessionKey"] = payload.response.sessionKey ?? "";
        ctx.metadata["cidrecorder:responseType"] = String(payload.response.response?.responseType ?? "");
        ctx.metadata["cidrecorder:contentLength"] = String(payload.response.response?.content?.length ?? 0);
        ctx.metadata["cidrecorder:prepared"] = "true";

        this.log(`[RESP ${ctx.requestId}] Prepared index metadata`);
        this.sendTo(this.pipeline, "eMiddlewareNext", ctx);
      })
      // Listen for eConversationStored from PersistenceMiddleware.
      .on("eConversationStored" as any, (stored: { sessionKey: SessionKey; cid: CID }) => {
        const entry: ConversationIndexEntry = {
          conversationCid: stored.cid,
          timestamp: Date.now(),
          model: "",
          firstUserMessage: "",
          tokenCount: 0,
        };
        this.index.push(entry);
        this.totalRecorded++;
        this.log(`Recorded CID ${stored.cid} — total=${this.totalRecorded}`);
      })
      .on("eConversationCaptured" as any, (captured: { sessionKey: SessionKey; node: ConversationNode }) => {
        this.log(`Conversation captured for session ${captured.sessionKey}`);
      });
  }

  /** Get the current index (for inspection/testing). */
  getIndex(): ConversationIndexEntry[] {
    return [...this.index];
  }
}
