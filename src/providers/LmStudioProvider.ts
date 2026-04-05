/**
 * Machine: LmStudioProvider
 * Role: ADAPTER — Local LLM inference via LM Studio (dev/testing).
 *
 * Handles eLLMRequest events by sending messages to a locally running
 * LM Studio instance and returning eLLMResponse. Drop-in replacement
 * for ProviderStub.
 *
 * Uses the official @lmstudio/sdk for communication with LM Studio.
 *
 * Design principles:
 *   - LOOSELY COUPLED: Boots without requiring LM Studio to be running.
 *     The SDK connection is lazy — established on the first eLLMRequest.
 *     If LM Studio is unavailable, returns an error eLLMResponse instead
 *     of crashing the kernel. The agent stays alive and can retry later.
 *   - No streaming. Request/response. One event in, one event out.
 *   - ALWAYS sends eLLMResponse, even on failure. Never throws.
 *   - Converts LM Studio's tool call format to the kernel's canonical ToolCall type.
 *   - Configurable model via constructor param or SOVEREIGN_AGENT_MODEL env var.
 *   - Must use kernel.registry (same registry as other machines).
 *
 * State: Ready
 *   on eLLMRequest → ensureModel() → model.respond() → parse → send eLLMResponse
 */

import { Machine, MachineRegistry } from "haven-core/machine";
import {
  type LLMResponse,
  type ToolCall,
  type ToolDefinition,
  LLMResponseType,
} from "haven-core/types";
import { LMStudioClient } from "@lmstudio/sdk";
import type {
  LLM,
  LLMTool,
  FunctionToolCallRequest,
} from "@lmstudio/sdk";

export class LmStudioProvider extends Machine {
  private modelId: string;
  private wsUrl: string;
  private client: LMStudioClient | null = null;
  private model: LLM | null = null;

  constructor(
    registry: MachineRegistry,
    id?: string,
    options?: { modelId?: string; baseUrl?: string }
  ) {
    super("LmStudioProvider", registry, id);
    this.modelId =
      options?.modelId ||
      process.env.SOVEREIGN_AGENT_MODEL ||
      "qwen/qwen3-4b-2507";

    // Resolve the base URL. The SDK uses WebSocket, so we need ws:// protocol.
    // The .env may have an HTTP URL, so we convert it.
    let rawUrl =
      options?.baseUrl ||
      process.env.SOVEREIGN_AGENT_LM_STUDIO_URL ||
      "http://127.0.0.1:1234";
    rawUrl = rawUrl.replace(/\/+$/, ""); // strip trailing slashes
    if (rawUrl.endsWith("/v1")) {
      rawUrl = rawUrl.slice(0, -3);
    }
    // Convert http(s):// to ws(s):// for the SDK
    this.wsUrl = rawUrl
      .replace(/^https:\/\//, "wss://")
      .replace(/^http:\/\//, "ws://");

    this.defineStates();
  }

  /**
   * Initialize the state machine only — no network calls.
   * The SDK connection is deferred to the first eLLMRequest so the
   * kernel boots even if LM Studio is offline.
   */
  async initialize(): Promise<void> {
    await this.init("Ready");
  }

  /**
   * Lazily connect to LM Studio and acquire a model handle.
   * If already connected, returns the cached handle.
   * Throws on failure — caller must catch and return an error eLLMResponse.
   */
  private async ensureModel(): Promise<LLM> {
    if (this.model) return this.model;

    this.log(`Connecting to LM Studio at ${this.wsUrl}...`);
    this.client = new LMStudioClient({ baseUrl: this.wsUrl });
    this.model = await this.client.llm.model(this.modelId);
    this.log(`Connected — model=${this.modelId}`);
    return this.model;
  }

  private defineStates(): void {
    this.defineState("Ready")
      .onEntry(() => {
        this.log(`Ready — model=${this.modelId} (connection deferred)`);
      })
      .on("eLLMRequest", async (req) => {
        try {
          const response = await this.callLmStudio(req.messages, req.tools);
          this.sendById(req.requestor, "eLLMResponse", {
            sessionKey: req.sessionKey,
            response,
          });
        } catch (err) {
          // CRITICAL: Always send eLLMResponse, even on failure.
          // If we throw instead, AgentLoop hangs in Iterating forever.
          //
          // Connection failures land here — the agent stays alive and
          // can retry on the next message.
          const errorMsg =
            err instanceof Error ? err.message : String(err);
          this.log(`ERROR: ${errorMsg}`);

          // Reset connection state so the next request retries from scratch
          this.model = null;
          this.client = null;

          this.sendById(req.requestor, "eLLMResponse", {
            sessionKey: req.sessionKey,
            response: {
              responseType: LLMResponseType.ERROR,
              content: `LM Studio error: ${errorMsg}`,
              toolCalls: [],
              reasoning: "",
            },
          });
        }
      });
  }

  /**
   * Call LM Studio via the official SDK.
   * Uses model.respond() with rawTools for tool-call support and
   * onToolCallRequestEnd callback to capture tool calls.
   */
  private async callLmStudio(
    messages: Record<string, string>[],
    tools: ToolDefinition[]
  ): Promise<LLMResponse> {
    const model = await this.ensureModel();

    // Convert kernel messages to SDK ChatInput format
    const chatInput = messages.map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    }));

    // Convert kernel ToolDefinition[] to SDK LLMTool[] format
    const sdkTools: LLMTool[] = tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: "object" as const,
          properties: {} as Record<string, unknown>,
        },
      },
    }));

    this.log(
      `Sending request to LM Studio (${messages.length} messages, ${tools.length} tools)`
    );

    // Collect tool calls via callback
    const collectedToolCalls: ToolCall[] = [];

    const prediction = model.respond(chatInput, {
      // Enable tool calling if tools are provided
      ...(sdkTools.length > 0
        ? {
            rawTools: {
              type: "toolArray" as const,
              tools: sdkTools,
            },
          }
        : {}),
      // Capture tool call requests as they complete
      onToolCallRequestEnd: (_callId, info) => {
        const tc = info.toolCallRequest as FunctionToolCallRequest;
        collectedToolCalls.push({
          id:
            tc.id ||
            `call_${Math.random().toString(36).slice(2, 10)}`,
          name: tc.name,
          arguments: this.normalizeArguments(tc.arguments),
        });
      },
    });

    // Await the full result (non-streaming)
    const result = await prediction;

    // The SDK exposes three content fields:
    //   result.content          — raw output, may include thinking tokens
    //                             (e.g. <|channel>thought...<channel|>)
    //   result.reasoningContent — just the chain-of-thought reasoning
    //   result.nonReasoningContent — the clean user-facing answer
    //
    // We use nonReasoningContent for the response and fall back to
    // content (with manual tag stripping) if the SDK doesn't split them.
    const cleanContent = this.extractCleanContent(result);

    // If tool calls were captured, return as TOOL_CALLS
    if (collectedToolCalls.length > 0) {
      return {
        responseType: LLMResponseType.TOOL_CALLS,
        content: cleanContent,
        toolCalls: collectedToolCalls,
        reasoning: result.reasoningContent || "",
      };
    }

    // Content response
    if (!cleanContent || cleanContent.length === 0) {
      return {
        responseType: LLMResponseType.ERROR,
        content: "LM Studio returned empty content",
        toolCalls: [],
        reasoning: "",
      };
    }

    return {
      responseType: LLMResponseType.CONTENT,
      content: cleanContent,
      toolCalls: [],
      reasoning: result.reasoningContent || "",
    };
  }

  /**
   * Extract clean user-facing content from an LM Studio prediction result.
   *
   * Models with reasoning capabilities (Gemma 4, Qwen3, etc.) may embed
   * chain-of-thought tokens in result.content. The SDK splits them into:
   *   - nonReasoningContent: clean user-facing answer (preferred)
   *   - reasoningContent: the thinking/planning portion
   *   - content: raw output (may include both)
   *
   * We prefer nonReasoningContent when available. If the SDK didn't split
   * them (older SDK versions or models without reasoning), we fall back to
   * manual stripping of known thinking token patterns.
   */
  private extractCleanContent(result: {
    content: string;
    reasoningContent?: string;
    nonReasoningContent?: string;
  }): string {
    // Prefer the SDK's clean split when available
    if (result.nonReasoningContent && result.nonReasoningContent.trim().length > 0) {
      return result.nonReasoningContent.trim();
    }

    // Fallback: manually strip known thinking token patterns from raw content
    let clean = result.content || "";

    // Gemma 4 style: <|channel>thought...<channel|>
    clean = clean.replace(/<\|channel>[\s\S]*?<channel\|>/g, "");

    // Qwen/DeepSeek style: <think>...</think>
    clean = clean.replace(/<think>[\s\S]*?<\/think>/g, "");

    // Generic: <|thinking>...<|/thinking>
    clean = clean.replace(/<\|thinking>[\s\S]*?<\|\/thinking>/g, "");

    return clean.trim();
  }

  /**
   * Normalize tool call arguments to Record<string, string>.
   * The SDK returns arguments as Record<string, any> or undefined.
   */
  private normalizeArguments(
    raw: Record<string, any> | undefined
  ): Record<string, string> {
    if (!raw || typeof raw !== "object") {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      result[k] = String(v);
    }
    return result;
  }
}
