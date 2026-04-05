/**
 * XmtpChannel — Extension machine bridging XMTP ↔ MessageBus.
 *
 * Lives in the adapter layer — the kernel never imports @xmtp/node-sdk.
 *
 * States: Disconnected → Connecting → Connected → Reconnecting → Connected
 *
 * Design:
 *   - Creates XMTP client using the agent's wallet key
 *   - Incoming XMTP messages → InboundMessage → ePublishInbound to MessageBus
 *   - eOutboundMessage from MessageBus → XMTP sendGroupText
 *   - Deduplicates messages before publishing (XMTP can deliver duplicates)
 *   - Handles consent auto-allow (from shoutbox-bot's syncAllowedConversations)
 *   - Reconnects on stream errors
 *
 * Adapted from shoutbox-bot/src/xmtpMessaging.ts and xmtpFactory.ts.
 * Key difference: The channel does NOT know about LLMs, replies, or context.
 * It only converts XMTP messages to/from the kernel's message format.
 */

import { Machine, MachineRegistry } from "haven-core/machine";
import type { InboundMessage, OutboundMessage, MessageId } from "haven-core/types";
import { generateSessionKey } from "haven-core/interfaces";
import {
  Client,
  ConsentState,
  isText,
  type ClientOptions,
  type Signer,
  type XmtpEnv,
  type DecodedMessage,
  createBackend,
  getInboxIdForIdentifier,
} from "@xmtp/node-sdk";
import { hexToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { IdentifierKind } from "@xmtp/node-sdk";

/** Configuration for XmtpChannel. */
export interface XmtpChannelConfig {
  privateKey: Hex;
  xmtpEnv: XmtpEnv;
  dbPath?: string;
  dbEncryptionKey?: Uint8Array;
  /** Channel name used in MessageBus routing (default: "xmtp"). */
  channelName?: string;
  /** Max reconnect attempts before giving up (default: 10). */
  maxReconnectAttempts?: number;
  /** Reconnect delay in ms (default: 5000). */
  reconnectDelayMs?: number;
}

export class XmtpChannel extends Machine {
  private config: XmtpChannelConfig;
  private channelName: string;
  private bus: Machine;
  private client: Client | null = null;
  private streamClose: (() => Promise<void>) | null = null;
  private consentSweepTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private reconnectDelayMs: number;

  /** Deduplication set — XMTP can deliver the same message twice on reconnect. */
  private processedMessageIds = new Set<MessageId>();

  /** Maximum dedup set size before pruning oldest entries. */
  private maxDedupSize = 5000;

  /** XMTP inbox ID — available after connecting. */
  private _inboxId = "";

  /** Active group ID — set by host via setActiveGroupId(). */
  private _activeGroupId = "";

  constructor(
    registry: MachineRegistry,
    bus: Machine,
    config: XmtpChannelConfig,
    id?: string
  ) {
    super("XmtpChannel", registry, id);
    this.config = config;
    this.bus = bus;
    this.channelName = config.channelName || "xmtp";
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 10;
    this.reconnectDelayMs = config.reconnectDelayMs ?? 5000;
    this.defineStates();
  }

  async initialize(): Promise<void> {
    await this.init("Disconnected");
  }

  private defineStates(): void {
    // ========================================================================
    // DISCONNECTED — Not connected to XMTP
    // ========================================================================
    this.defineState("Disconnected")
      .onEntry(() => {
        this.log("Disconnected — awaiting eStart");
      })
      .on("eStart", () => {
        this.goto("Connecting");
      });

    // ========================================================================
    // CONNECTING — Creating XMTP client and starting stream
    // ========================================================================
    this.defineState("Connecting")
      .onEntry(async () => {
        this.log("Connecting to XMTP...");
        try {
          // Create XMTP signer from private key (same pattern as shoutbox-bot xmtpSigner.ts)
          const account = privateKeyToAccount(this.config.privateKey);
          const signer: Signer = {
            type: "EOA",
            getIdentifier: () => ({
              identifier: account.address.toLowerCase(),
              identifierKind: IdentifierKind.Ethereum,
            }),
            signMessage: async (message: string) => {
              const sig = await account.signMessage({ message });
              return hexToBytes(sig);
            },
          };

          const options: ClientOptions = {
            env: this.config.xmtpEnv,
            dbPath: this.config.dbPath,
            dbEncryptionKey: this.config.dbEncryptionKey,
          };

          // Create client with installation limit handling (from xmtpFactory.ts)
          try {
            this.client = (await Client.create(signer, options)) as Client;
          } catch (err) {
            if (this.isInstallationLimitError(err)) {
              this.log("Installation limit reached — revoking old installations...");
              await this.revokeAllInstallations(signer, this.config.xmtpEnv);
              this.client = (await Client.create(signer, options)) as Client;
            } else {
              throw err;
            }
          }

          this._inboxId = this.client.inboxId ?? "";
          this.log(`XMTP client created — inbox=${this._inboxId.slice(0, 12)}...`);

          // Auto-allow all conversations
          await this.syncAllowedConversations();

          // Start message stream
          await this.startStream();

          // Register channel with MessageBus
          this.sendTo(this.bus, "eRegisterChannel", {
            name: this.channelName,
            handler: this.id,
          });

          // Periodic consent sweep (every 15s, same as shoutbox-bot)
          this.consentSweepTimer = setInterval(() => {
            this.syncAllowedConversations().catch((e) => {
              this.log(`consent sweep error: ${e instanceof Error ? e.message : String(e)}`);
            });
          }, 15_000);

          this.reconnectAttempts = 0;
          this.goto("Connected");
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.log(`Connection failed: ${errMsg}`);
          this.goto("Reconnecting");
        }
      })
      .on("eStop", () => {
        this.goto("Disconnected");
      });

    // ========================================================================
    // CONNECTED — Streaming messages
    // ========================================================================
    this.defineState("Connected")
      .onEntry(() => {
        this.log(`Connected — streaming messages on channel "${this.channelName}"`);
      })
      .on("eOutboundMessage", async (msg: OutboundMessage) => {
        if (!this.client) return;
        if (!msg.chatId) return;
        try {
          const conv = await this.client.conversations.getConversationById(
            msg.chatId
          );
          if (conv) {
            await conv.sendText(msg.content);
            this.log(`Sent to XMTP group ${msg.chatId.slice(0, 8)}...`);
          } else {
            this.log(`XMTP conversation not found: ${msg.chatId}`);
          }
        } catch (err) {
          this.log(
            `Send failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      })
      .on("eStop", async () => {
        await this.cleanup();
        this.goto("Disconnected");
      });

    // ========================================================================
    // RECONNECTING — Stream dropped, retrying
    // ========================================================================
    this.defineState("Reconnecting")
      .onEntry(async () => {
        this.reconnectAttempts++;
        if (this.reconnectAttempts > this.maxReconnectAttempts) {
          this.log(
            `Max reconnect attempts (${this.maxReconnectAttempts}) reached — giving up`
          );
          await this.cleanup();
          this.goto("Disconnected");
          return;
        }

        this.log(
          `Reconnecting (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${this.reconnectDelayMs}ms...`
        );

        await this.sleep(this.reconnectDelayMs);

        if (this.client) {
          try {
            // Close old stream if still open
            if (this.streamClose) {
              await this.streamClose().catch(() => {});
              this.streamClose = null;
            }

            // Re-sync and restart stream
            await this.syncAllowedConversations();
            await this.startStream();

            this.reconnectAttempts = 0;
            this.goto("Connected");
          } catch (err) {
            this.log(
              `Reconnect failed: ${err instanceof Error ? err.message : String(err)}`
            );
            this.goto("Reconnecting");
          }
        } else {
          // Client is gone — full reconnect
          this.goto("Connecting");
        }
      })
      .on("eStop", async () => {
        await this.cleanup();
        this.goto("Disconnected");
      });
  }

  // ==========================================================================
  // Stream management
  // ==========================================================================

  private async startStream(): Promise<void> {
    if (!this.client) throw new Error("No XMTP client");

    const stream = await this.client.conversations.streamAllMessages({
      consentStates: [ConsentState.Allowed, ConsentState.Unknown],
      onValue: (msg: DecodedMessage) => {
        this.handleIncoming(msg);
      },
      onError: (err: Error) => {
        this.log(`Stream error: ${err.message}`);
        // Trigger reconnect
        this.sendSelf("eError", `Stream error: ${err.message}`);
        this.goto("Reconnecting");
      },
    });

    this.streamClose = async () => {
      await stream.end();
    };
  }

  private handleIncoming(msg: DecodedMessage): void {
    // Skip non-text messages
    if (!isText(msg) || typeof msg.content !== "string") return;

    // Skip own messages
    if (msg.senderInboxId === this._inboxId) return;

    // Skip messages not in the active group (if one is set)
    if (this._activeGroupId && msg.conversationId !== this._activeGroupId) {
      return;
    }

    // Deduplication — XMTP can deliver the same message twice on reconnect
    if (this.processedMessageIds.has(msg.id)) return;
    this.processedMessageIds.add(msg.id);

    // Prune dedup set if it's getting too large
    if (this.processedMessageIds.size > this.maxDedupSize) {
      const entries = Array.from(this.processedMessageIds);
      const toRemove = entries.slice(0, entries.length - this.maxDedupSize / 2);
      for (const id of toRemove) {
        this.processedMessageIds.delete(id);
      }
    }

    // Convert to kernel InboundMessage
    const chatId = msg.conversationId;
    const inbound: InboundMessage = {
      id: msg.id,
      channel: this.channelName,
      senderId: msg.senderInboxId,
      chatId,
      content: msg.content as string,
      timestamp: msg.sentAt.getTime(),
      sessionKey: generateSessionKey(this.channelName, chatId),
      metadata: {
        conversationId: msg.conversationId,
        senderInboxId: msg.senderInboxId,
      },
    };

    this.log(
      `← ${msg.senderInboxId.slice(0, 8)}... in ${chatId.slice(0, 8)}...: "${(msg.content as string).slice(0, 60)}"`
    );

    // Publish to MessageBus
    this.sendTo(this.bus, "ePublishInbound", inbound);
  }

  // ==========================================================================
  // XMTP helpers (adapted from shoutbox-bot)
  // ==========================================================================

  private async syncAllowedConversations(): Promise<void> {
    if (!this.client) return;
    await this.client.conversations.sync();
    const allConvos = await this.client.conversations.list();
    for (const convo of allConvos) {
      try {
        const state = convo.consentState();
        if (state !== ConsentState.Allowed) {
          await convo.updateConsentState(ConsentState.Allowed);
        }
      } catch {
        // Ignore individual consent errors
      }
    }
  }

  private isInstallationLimitError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /registered\s+\d+\/\d+\s+installations/i.test(msg);
  }

  private async revokeAllInstallations(
    signer: Signer,
    env: XmtpEnv
  ): Promise<void> {
    const backend = await createBackend({ env });
    const identifier = await signer.getIdentifier();
    const inboxId = await getInboxIdForIdentifier(backend, identifier);
    if (!inboxId) {
      throw new Error(`Cannot resolve inboxId for ${identifier.identifier}`);
    }
    const [inboxState] = await Client.fetchInboxStates([inboxId], backend);
    if (!inboxState || inboxState.installations.length === 0) return;
    const installationIds = inboxState.installations.map((i) => i.bytes);
    this.log(`Revoking ${installationIds.length} old installation(s)...`);
    await Client.revokeInstallations(signer, inboxId, installationIds, backend);
    this.log("Old installations revoked");
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  private async cleanup(): Promise<void> {
    if (this.consentSweepTimer) {
      clearInterval(this.consentSweepTimer);
      this.consentSweepTimer = null;
    }
    if (this.streamClose) {
      await this.streamClose().catch(() => {});
      this.streamClose = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /** Get the XMTP inbox ID (available after connection). */
  get inboxId(): string {
    return this._inboxId;
  }

  /** Set the active group ID (from GunDB group window subscription). */
  setActiveGroupId(groupId: string): void {
    this._activeGroupId = groupId;
    this.log(`Active group set: ${groupId ? groupId.slice(0, 8) + "..." : "(none)"}`);
  }

  /** Get the XMTP client (for advanced use like fetching context). */
  getClient(): Client | null {
    return this.client;
  }
}
