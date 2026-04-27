/**
 * Extension: CompressionMiddleware
 * Role: REFERENCE EXTENSION — Inference pipeline middleware.
 * Priority: 20
 *
 * Direct TypeScript translation of spec/extensions/machines/CompressionMiddleware.p
 * Mirrors lmstudio-bridge's gzip.ts middleware.
 *
 * Request stage: captures the raw request in context metadata.
 * Response stage: combines request + response, compresses with real gzip,
 * stores compressed buffer in context metadata.
 *
 * Uses Node.js built-in zlib for real gzip compression.
 *
 * States: Init → Ready
 */

import { Machine, MachineRegistry } from "haven-core/machine";
import type { PipelineContext } from "haven-core/types";
import { gzipSync } from "zlib";

export class CompressionMiddleware extends Machine {
  private pipeline: Machine;

  constructor(registry: MachineRegistry, pipeline: Machine, id?: string) {
    super("CompressionMiddleware", registry, id);
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
          name: "compress", handler: this.id, priority: 20,
        });
        this.log("Initialized — registered with pipeline (priority 20)");
        this.goto("Ready");
      });

    this.defineState("Ready")
      .on("eMiddlewareRequest", (payload: { context: PipelineContext; request: any }) => {
        const ctx = { ...payload.context, metadata: { ...payload.context.metadata } };
        const msgCount = payload.request.messages?.length ?? 0;
        ctx.metadata["capturedRequest"] = `messages:${msgCount}`;
        this.log(`[REQ ${ctx.requestId}] Captured request (${msgCount} messages)`);
        this.sendTo(this.pipeline, "eMiddlewareNext", ctx);
      })
      .on("eMiddlewareResponse", (payload: { context: PipelineContext; response: any }) => {
        const ctx = { ...payload.context, metadata: { ...payload.context.metadata } };
        const capturedRequest = ctx.metadata["capturedRequest"] ?? "";
        const responseContent = payload.response.response?.content ?? "";
        const plaintext = `${capturedRequest}\n${responseContent}`;
        const originalSize = Buffer.byteLength(plaintext, "utf-8");

        // Real gzip compression using Node.js zlib.
        const compressed = gzipSync(Buffer.from(plaintext, "utf-8"));
        const compressedB64 = compressed.toString("base64");

        ctx.metadata["compressedBuffer"] = compressedB64;
        ctx.metadata["compression:algorithm"] = "gzip";
        ctx.metadata["compression:originalSize"] = String(originalSize);
        ctx.metadata["compression:compressedSize"] = String(compressed.length);

        const ratio = originalSize > 0 ? ((1 - compressed.length / originalSize) * 100).toFixed(1) : "0";
        this.log(`[RESP ${ctx.requestId}] Compressed — ${originalSize} → ${compressed.length} bytes (${ratio}% reduction)`);
        this.sendTo(this.pipeline, "eMiddlewareNext", ctx);
      });
  }
}
