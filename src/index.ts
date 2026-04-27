/**
 * haven-adapters — Chain & provider adapters for the Sovereign Agent kernel.
 *
 * Re-exports all adapters for convenient import:
 *   import { createEthereumCryptoAdapter, XmtpChannel, LmStudioProvider } from "haven-adapters";
 *   import { InferencePipeline, LoggerMiddleware, ... } from "haven-adapters";
 *   import { StorageBackend, createSynapseStorageAdapter } from "haven-adapters";
 */

export { createEthereumCryptoAdapter } from "./ethereum/EthereumCryptoAdapter.js";
export { XmtpChannel, type XmtpChannelConfig } from "./xmtp/XmtpChannel.js";
export { LmStudioProvider } from "./providers/LmStudioProvider.js";

// --- Pipeline & Middleware ---
export { InferencePipeline } from "./pipeline/InferencePipeline.js";
export { LoggerMiddleware } from "./pipeline/LoggerMiddleware.js";
export { CompressionMiddleware } from "./pipeline/CompressionMiddleware.js";
export { EncryptionMiddleware, type TacoEncryptConfig, type TacoEncryptionMetadata } from "./pipeline/EncryptionMiddleware.js";
export { PersistenceMiddleware } from "./pipeline/PersistenceMiddleware.js";
export { CIDRecorderMiddleware } from "./pipeline/CIDRecorderMiddleware.js";
export { StoragePinManager } from "./pipeline/StoragePinManager.js";

// --- Storage (Layer 2) ---
export { StorageBackend } from "./storage/StorageBackend.js";
export { createSynapseStorageAdapter, type SynapseStorageAdapterConfig } from "./storage/SynapseStorageAdapter.js";

// --- Extension Types ---
export type {
  MiddlewareEntry,
  ConversationNode,
  ConversationRequest,
  ConversationResponse,
  ConversationMetadata,
  EncryptionConfig,
  CompressionConfig,
  SessionDAGNode,
  SessionStatistics,
  ConversationIndexEntry,
  PinStatus,
} from "./pipeline/extension-types.js";
export { PinState } from "./pipeline/extension-types.js";
