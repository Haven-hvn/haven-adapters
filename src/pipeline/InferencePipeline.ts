/**
 * Machine: InferencePipeline
 * Role: EXTENSION — The middleware runner for the inference path.
 *
 * Direct TypeScript translation of spec/extensions/machines/InferencePipeline.p
 *
 * Manages an ordered list of middleware machines and orchestrates the
 * onion-model execution for every LLM request/response cycle. This is the
 * TypeScript implementation of lmstudio-bridge's MiddlewareRunner + Engine.
 *
 * The pipeline is a transparent proxy: AgentLoop sends eLLMRequest to
 * the pipeline and receives eLLMResponse — identical interface to talking
 * directly to a provider.
 *
 * States: Init → Ready → RunningRequestChain → AwaitingProvider →
 *         RunningResponseChain → Complete → Ready
 */

import { Machine, MachineRegistry } from "haven-core/machine";
import {
  type PipelineContext,
  type LLMResponse,
  type SessionKey,
  type ToolDefinition,
  type CostEstimate,
  type MiddlewareName,
  LLMResponseType,
} from "haven-core/types";
import type { MiddlewareEntry } from "./extension-types.js";

export class InferencePipeline extends Machine {
  /** The agent loop — receives eLLMResponse when pipeline completes. */
  private agentLoop: Machine;

  /** The actual LLM provider — receives eLLMRequest after request middleware. */
  private provider: Machine;

  /** Registered middleware, ordered by priority (lower = earlier in request chain). */
  private middleware: MiddlewareEntry[] = [];

  /** Current pipeline context for the active request. */
  private currentContext: PipelineContext | null = null;

  /** Current request being processed through the pipeline. */
  private currentRequest: any = null;

  /** Current response being processed through the pipeline. */
  private currentResponse: any = null;

  /** Index into the middleware list for chain walking. */
  private chainIndex = 0;

  /** Request counter for unique pipeline context IDs. */
  private requestCounter = 0;

  constructor(
    registry: MachineRegistry,
    agentLoop: Machine,
    provider: Machine,
    id?: string
  ) {
    super("InferencePipeline", registry, id);
    this.agentLoop = agentLoop;
    this.provider = provider;
    this.defineStates();
  }

  async initialize(): Promise<void> {
    await this.init("Init");
  }

  private defineStates(): void {
    // ========================================================================
    // Init
    // ========================================================================
    this.defineState("Init")
      .onEntry(() => {
        this.log("Initialized — no middleware registered");
        this.goto("Ready");
      });

    // ========================================================================
    // Ready — Accepting middleware registrations and LLM requests
    // ========================================================================
    this.defineState("Ready")
      .onEntry(() => {
        this.log(`Ready with ${this.middleware.length} middleware`);
      })
      .on("eRegisterMiddleware", (reg: { name: MiddlewareName; handler: string; priority: number }) => {
        // Insert middleware in priority order.
        const entry: MiddlewareEntry = { name: reg.name, handler: reg.handler, priority: reg.priority };
        const newList: MiddlewareEntry[] = [];
        let inserted = false;
        for (const mw of this.middleware) {
          if (!inserted && reg.priority < mw.priority) {
            newList.push(entry);
            inserted = true;
          }
          newList.push(mw);
        }
        if (!inserted) newList.push(entry);
        this.middleware = newList;
        this.log(`Middleware registered — ${reg.name} (priority ${reg.priority})`);
      })
      .on("eUnregisterMiddleware", (name: MiddlewareName) => {
        this.middleware = this.middleware.filter((mw) => mw.name !== name);
        this.log(`Middleware unregistered — ${name}`);
      })
      .on("eLLMRequest", (req: any) => {
        this.currentRequest = req;
        this.requestCounter++;
        this.currentContext = {
          requestId: `pipeline:${this.requestCounter}`,
          sessionKey: req.sessionKey,
          timestamp: Date.now(),
          metadata: {},
        };

        this.log(`Processing request ${this.currentContext.requestId} for session ${req.sessionKey}`);

        if (this.middleware.length === 0) {
          this.sendTo(this.provider, "eLLMRequest", req);
          this.goto("AwaitingProvider");
          return;
        }

        this.chainIndex = 0;
        this.goto("RunningRequestChain");
      });

    // ========================================================================
    // RunningRequestChain — Walk middleware in priority order (forward)
    // ========================================================================
    this.defineState("RunningRequestChain")
      .onEntry(() => {
        if (this.chainIndex >= this.middleware.length) {
          this.sendTo(this.provider, "eLLMRequest", this.currentRequest);
          this.goto("AwaitingProvider");
          return;
        }

        const mw = this.middleware[this.chainIndex];
        this.log(`Request chain [${this.chainIndex + 1}/${this.middleware.length}] → ${mw.name}`);
        this.sendById(mw.handler, "eMiddlewareRequest", {
          context: this.currentContext!,
          request: this.currentRequest,
        });
      })
      .on("eMiddlewareNext", (ctx: PipelineContext) => {
        this.currentContext = ctx;
        this.chainIndex++;

        if (this.chainIndex >= this.middleware.length) {
          this.sendTo(this.provider, "eLLMRequest", this.currentRequest);
          this.goto("AwaitingProvider");
          return;
        }

        const mw = this.middleware[this.chainIndex];
        this.log(`Request chain [${this.chainIndex + 1}/${this.middleware.length}] → ${mw.name}`);
        this.sendById(mw.handler, "eMiddlewareRequest", {
          context: this.currentContext!,
          request: this.currentRequest,
        });
      })
      .on("eMiddlewareError", (err: { middleware: MiddlewareName; error: string; context: PipelineContext }) => {
        this.log(`Request middleware ${err.middleware} failed — ${err.error}`);
        const errorResponse: LLMResponse = {
          responseType: LLMResponseType.ERROR,
          content: `Pipeline error in ${err.middleware}: ${err.error}`,
          toolCalls: [],
          reasoning: "",
        };
        this.sendTo(this.agentLoop, "eLLMResponse", {
          sessionKey: this.currentRequest.sessionKey,
          response: errorResponse,
        });
        this.goto("Ready");
      });

    // ========================================================================
    // AwaitingProvider — Waiting for the actual LLM response
    // ========================================================================
    this.defineState("AwaitingProvider")
      .onEntry(() => {
        this.log("Awaiting provider response");
      })
      .on("eLLMResponse", (resp: { sessionKey: SessionKey; response: LLMResponse }) => {
        this.currentResponse = resp;

        if (this.middleware.length === 0) {
          this.sendTo(this.agentLoop, "eLLMResponse", resp);
          this.goto("Ready");
          return;
        }

        // Start the response middleware chain in REVERSE order (onion model).
        this.chainIndex = this.middleware.length - 1;
        this.goto("RunningResponseChain");
      })
      .on("eLLMProviderError", (err: { provider: string; error: string }) => {
        this.log(`Provider error — ${err.provider}: ${err.error}`);
        const errorResponse: LLMResponse = {
          responseType: LLMResponseType.ERROR,
          content: `Provider error: ${err.error}`,
          toolCalls: [],
          reasoning: "",
        };
        this.sendTo(this.agentLoop, "eLLMResponse", {
          sessionKey: this.currentRequest.sessionKey,
          response: errorResponse,
        });
        this.goto("Ready");
      });

    // ========================================================================
    // RunningResponseChain — Walk middleware in REVERSE priority order
    // ========================================================================
    this.defineState("RunningResponseChain")
      .onEntry(() => {
        if (this.chainIndex < 0) {
          this.goto("Complete");
          return;
        }

        const mw = this.middleware[this.chainIndex];
        this.log(`Response chain [${this.middleware.length - this.chainIndex}/${this.middleware.length}] → ${mw.name}`);
        this.sendById(mw.handler, "eMiddlewareResponse", {
          context: this.currentContext!,
          response: this.currentResponse,
        });
      })
      .on("eMiddlewareNext", (ctx: PipelineContext) => {
        this.currentContext = ctx;
        this.chainIndex--;

        if (this.chainIndex < 0) {
          this.goto("Complete");
          return;
        }

        const mw = this.middleware[this.chainIndex];
        this.log(`Response chain [${this.middleware.length - this.chainIndex}/${this.middleware.length}] → ${mw.name}`);
        this.sendById(mw.handler, "eMiddlewareResponse", {
          context: this.currentContext!,
          response: this.currentResponse,
        });
      })
      .on("eMiddlewareError", (err: { middleware: MiddlewareName; error: string; context: PipelineContext }) => {
        // Response middleware errors are non-fatal — skip and continue.
        this.log(`Response middleware ${err.middleware} failed — ${err.error} (non-fatal)`);
        this.chainIndex--;
        if (this.chainIndex < 0) {
          this.goto("Complete");
          return;
        }
        const mw = this.middleware[this.chainIndex];
        this.sendById(mw.handler, "eMiddlewareResponse", {
          context: this.currentContext!,
          response: this.currentResponse,
        });
      });

    // ========================================================================
    // Complete — Forward final response to AgentLoop and return to Ready
    // ========================================================================
    this.defineState("Complete")
      .onEntry(() => {
        this.log(`Complete — returning response for ${this.currentResponse.sessionKey}`);
        this.sendTo(this.agentLoop, "eLLMResponse", this.currentResponse);
        this.goto("Ready");
      });
  }

  /** Get the list of registered middleware (for inspection/testing). */
  getMiddleware(): MiddlewareEntry[] {
    return [...this.middleware];
  }
}
