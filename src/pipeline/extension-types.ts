/**
 * Extension type definitions for the inference pipeline.
 *
 * Direct TypeScript translation of spec/extensions/Types.p
 *
 * Types used by reference extension machines. These are NOT part of the
 * core kernel — they exist to support the reference implementations of
 * middleware, persistence, pin management, and IPLD conversation storage.
 */

import type { CID, MiddlewareName, SessionKey } from "haven-core/types";

// ============================================================================
// MIDDLEWARE PIPELINE TYPES
// ============================================================================

/** Registered middleware entry in the InferencePipeline's ordered list. */
export interface MiddlewareEntry {
  name: MiddlewareName;
  handler: string;         // Machine ID
  priority: number;        // Lower = earlier in request chain, later in response chain
}

// ============================================================================
// IPLD CONVERSATION TYPES (for PersistenceMiddleware)
// ============================================================================

/** A single persisted conversation (request + response pair). */
export interface ConversationNode {
  version: string;
  request: ConversationRequest;
  response: ConversationResponse;
  metadata: ConversationMetadata;
  timestamp: number;
  previousConversationCid: CID;
}

/** The LLM request that was sent (captured by middleware). */
export interface ConversationRequest {
  model: string;
  messages: Record<string, string>[];
  parameters: Record<string, string>;
}

/** The LLM response that was received. */
export interface ConversationResponse {
  id: string;
  model: string;
  choices: Record<string, string>[];
  usage: Record<string, number>;
  created: number;
}

/** Metadata about the capture — what processing was applied. */
export interface ConversationMetadata {
  shimVersion: string;
  captureTimestamp: number;
  encryption: EncryptionConfig;
  compression: CompressionConfig;
}

/** Encryption state for a persisted conversation. */
export interface EncryptionConfig {
  encrypted: boolean;
  algorithm: string;
  publicKeyFingerprint: string;
}

/** Compression state for a persisted conversation. */
export interface CompressionConfig {
  compressed: boolean;
  algorithm: string;
  originalSize: number;
}

/** A session DAG node — aggregates conversations into a session. */
export interface SessionDAGNode {
  sessionId: string;
  timestamp: number;
  conversations: CID[];
  statistics: SessionStatistics;
  previousSessionCid: CID;
}

/** Aggregate session statistics. */
export interface SessionStatistics {
  totalRequests: number;
  totalTokens: number;
  totalSize: number;
  duration: number;
}

/** Conversation index entry — for efficient lookup without walking the full DAG. */
export interface ConversationIndexEntry {
  conversationCid: CID;
  timestamp: number;
  model: string;
  firstUserMessage: string;
  tokenCount: number;
}

// ============================================================================
// PIN / STORAGE TYPES (for StoragePinManager)
// ============================================================================

/** IPFS pin status for a specific CID. */
export interface PinStatus {
  cid: CID;
  provider: string;
  expiresAt: number;
  redundancy: number;
}

/** Pin lifecycle state. */
export enum PinState {
  PINNED = "PINNED",
  EXPIRING = "EXPIRING",
  EXPIRED = "EXPIRED",
  UNPINNED = "UNPINNED",
}
