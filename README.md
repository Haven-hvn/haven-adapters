# haven-adapters

Chain & provider adapters for the [Haven Core Sovereign Agent](https://github.com/Haven-hvn/haven-core)

Every adapter implements a kernel interface for a specific chain, messaging protocol, or inference provider. When someone builds an Ethereum adapter, every sovereign agent on Ethereum benefits. When someone builds a Solana adapter, the entire ecosystem gains Solana support.

## Adapters

| Adapter | Interface | Dependencies |
|---------|-----------|-------------|
| `EthereumCryptoAdapter` | `CryptoAdapter` | `viem` |
| `XmtpChannel` | `ChatChannel` (Machine) | `@xmtp/node-sdk`, `viem` |
| `LmStudioProvider` | LLM Provider (Machine) | `@lmstudio/sdk` |

## Usage

```typescript
import { SovereignAgentKernel } from "haven-core/kernel";
import { createEthereumCryptoAdapter, XmtpChannel, LmStudioProvider } from "haven-adapters";

const kernel = new SovereignAgentKernel();

// Inject Ethereum identity
kernel.wallet.setCryptoAdapter(createEthereumCryptoAdapter());

// Replace stub provider with LM Studio
const lmProvider = new LmStudioProvider(kernel.registry, "provider", {
  modelId: "qwen/qwen3-4b-2507",
  baseUrl: "http://127.0.0.1:1234",
});
await lmProvider.initialize();
kernel.agent.setProvider(lmProvider);

// Add XMTP messaging
const xmtp = new XmtpChannel(kernel.registry, kernel.bus, {
  privateKey: "0x...",
  xmtpEnv: "dev",
});
await xmtp.initialize();
xmtp.enqueue("eStart");
```

## Development

```bash
npm install
npm run build
```

Uses `file:../haven-core` for local development. For production, publish to npm or use git URLs.

## Adding New Adapters

1. Create a new directory under `src/` (e.g., `src/solana/`)
2. Implement the kernel interface (`CryptoAdapter`, `ChatChannel`, etc.)
3. Import types from `haven-core` — never import chain-specific libs in the kernel
4. Re-export from `src/index.ts`

## Related Repos

- **[haven-core](../haven-core)** — The sovereign agent kernel (5 core state machines)
- **[web3-shoutbox-platform](../../)** — Shoutbox web app + sovereign bot (first application)
