/**
 * Extension: LoggerMiddleware
 * Role: REFERENCE EXTENSION — Inference pipeline middleware.
 * Priority: 10 (runs first on request, last on response)
 *
 * Direct TypeScript translation of spec/extensions/machines/LoggerMiddleware.p
 * Mirrors lmstudio-bridge's logger.ts middleware.
 *
 * States: Init → Ready
 */

import { Machine, MachineRegistry } from "haven-core/machine";
import type { PipelineContext } from "haven-core/types";

export class LoggerMiddleware extends Machine {
  private pipeline: Machine;
  private totalRequests = 0;
  private totalResponses = 0;

  constructor(registry: MachineRegistry, pipeline: Machine, id?: string) {
    super("LoggerMiddleware", registry, id);
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
          name: "logger", handler: this.id, priority: 10,
        });
        this.log("Initialized — registered with pipeline (priority 10)");
        this.goto("Ready");
      });

    this.defineState("Ready")
      .on("eMiddlewareRequest", (payload: { context: PipelineContext; request: any }) => {
        this.totalRequests++;
        const msgCount = payload.request.messages?.length ?? 0;
        this.log(`[REQ ${payload.context.requestId}] session=${payload.request.sessionKey} messages=${msgCount}`);

        const ctx = { ...payload.context, metadata: { ...payload.context.metadata } };
        ctx.metadata["logger:requestTimestamp"] = String(Date.now());
        ctx.metadata["logger:messageCount"] = String(msgCount);

        this.sendTo(this.pipeline, "eMiddlewareNext", ctx);
      })
      .on("eMiddlewareResponse", (payload: { context: PipelineContext; response: any }) => {
        this.totalResponses++;
        const toolCallCount = payload.response.response?.toolCalls?.length ?? 0;
        const contentLen = payload.response.response?.content?.length ?? 0;
        this.log(`[RESP ${payload.context.requestId}] type=${payload.response.response?.responseType} contentLen=${contentLen} toolCalls=${toolCallCount}`);
        this.log(`Totals — requests=${this.totalRequests} responses=${this.totalResponses}`);

        this.sendTo(this.pipeline, "eMiddlewareNext", payload.context);
      });
  }
}
