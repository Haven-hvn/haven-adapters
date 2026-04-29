# Migration Plan: Replace viem Signing with OWS in haven-adapters

## Goal

Replace the current `viem`-based Ethereum signing path in `haven-adapters` with an Open Wallet Standard (OWS) implementation using `@open-wallet-standard/core`, while preserving the `haven-core` `CryptoAdapter` contract and existing kernel wiring.

Primary target:
- `src/ethereum/EthereumCryptoAdapter.ts`

Non-goals:
- replacing `XmtpChannel` or `LmStudioProvider`
- rewriting chain-RPC reads, contract interactions, or broadcast flows outside the signing boundary

---

## Why This Migration

1. Standardized wallet access and policy-gated signing through OWS.
2. Better custody posture by avoiding direct raw private key handling in adapter code.
3. Cleaner path to multi-chain signing parity without duplicating chain-specific key management logic.

---

## Current State (as-is)

- `EthereumCryptoAdapter` uses `viem/accounts` (`privateKeyToAccount`) for:
  - key loading from `env:VAR` or direct `0x...` value
  - address derivation
  - `signMessage`
  - `signTransaction`
- Adapter implements `haven-core/interfaces` `CryptoAdapter` with:
  - `loadKey(keySource)`
  - `signMessage(keyMaterial, payload)`
  - `signTransaction(keyMaterial, payload)`

---

## Target State (to-be)

Introduce an OWS-backed adapter that still satisfies `CryptoAdapter`, but delegates cryptographic operations to `@open-wallet-standard/core`.

### Proposed adapter shape

- Add `src/ethereum/OwsEthereumCryptoAdapter.ts` implementing `CryptoAdapter`.
- Keep existing `setCryptoAdapter(...)` integration in host apps unchanged.
- Represent `keyMaterial` as a typed OWS session/context object (no `any`).

Example direction:
- `loadKey(keySource)` resolves wallet identity for OWS usage (wallet name/id mapping).
- `signMessage(...)` maps to OWS `signMessage`.
- `signTransaction(...)` maps to OWS `sign` (or `signAndSend` only if broadcast is explicitly required by caller semantics).

---

## Compatibility Strategy

Use a staged migration to avoid breakage:

1. Keep `EthereumCryptoAdapter` (viem) intact initially.
2. Add `OwsEthereumCryptoAdapter` alongside it.
3. Export both adapters from `src/index.ts`.
4. Optionally add a factory switch (`createEthereumCryptoAdapter({ backend: "viem" | "ows" })`) after OWS path is stable.
5. Deprecate viem adapter only after parity and soak time.

---

## Implementation Phases

### Phase 0: Dependency and interface prep

- Add `@open-wallet-standard/core` dependency.
- Define strict adapter-local types for OWS context:
  - wallet identifier
  - chain identifier mapping
  - credential mode assumptions
- Confirm no `any` usage in new code.

Exit criteria:
- package installs successfully in supported environments
- TypeScript build passes

### Phase 1: Implement OWS-backed CryptoAdapter

- Create `OwsEthereumCryptoAdapter` implementing:
  - `loadKey` (wallet resolution and typed key context creation)
  - `signMessage`
  - `signTransaction`
- Ensure errors are translated into adapter-level errors with actionable messages.

Exit criteria:
- Adapter compiles and is importable from package exports
- Manual smoke test signs at least one message and one transaction payload

### Phase 2: Contract parity tests

- Add unit tests to verify behavior parity with current contract:
  - `loadKey` rejects unsupported `keySource` formats
  - `signMessage` returns deterministic signature shape
  - `signTransaction` handles malformed payload input safely
  - clear error propagation for wallet-not-found / policy-denied paths
- Mock OWS SDK boundary for deterministic tests.

Exit criteria:
- New adapter tests pass with 100% coverage for files introduced/changed in this migration

### Phase 3: Host integration and rollout

- Update integration examples in `README.md` to show OWS adapter usage.
- Provide migration notes for host apps currently using env private keys.
- Keep viem adapter available during transition window.

Exit criteria:
- At least one host app boots kernel and signs via OWS adapter
- Documentation includes fallback path and rollback guidance

---

## Test Plan

1. Unit tests for all code paths in `OwsEthereumCryptoAdapter` (success + failure).
2. Contract conformance tests against `CryptoAdapter` expectations from `haven-core`.
3. Serialization tests for transaction payload handoff to OWS.
4. Error-mapping tests for common OWS failures:
   - wallet missing
   - invalid chain
   - policy denied
   - invalid input

Coverage requirement:
- 100% unit test coverage on newly added migration code.

---

## Risks and Mitigations

- Native binding/runtime constraints for `@open-wallet-standard/core`.
  - Mitigation: pin tested versions and validate install matrix early.
- Behavior differences vs `viem` for transaction payload expectations.
  - Mitigation: add explicit payload schema validation and fixtures.
- Credential model mismatch (`keySource` env style vs OWS wallet identity model).
  - Mitigation: introduce deterministic wallet resolution rules and document them.

---

## Open Decisions

1. Should `keySource` remain env-key compatible in OWS mode, or be reinterpreted as wallet alias/id?
2. Do we need a dual backend factory immediately, or is a separate OWS adapter export sufficient?
3. Should `signTransaction` remain sign-only, or support optional send behavior through a separate adapter method?

---

## Definition of Done

- OWS-backed Ethereum adapter exists and is exported.
- Existing host integration path (`setCryptoAdapter`) remains unchanged.
- README includes migration usage example.
- Tests pass with 100% coverage for new/changed adapter files.
- viem adapter remains available until explicit deprecation decision.
