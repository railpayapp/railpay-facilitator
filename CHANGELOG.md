# Changelog

## [0.3.0] - 2026-11-22

Settlement with your own operator key.

- `POST /settle`: verifies again (simulation from the operator), claims the authorization, sends `transferWithAuthorization` with EIP-1559 fees from the operator key, waits for the receipt and answers success only with status 1 and exactly one matching USDG `Transfer` log. Answers the spec's `SettleResponse`.
- Idempotent: an atomic claim per authorization, the signed transaction stored before broadcast, and a single success answer per authorization, also across facilitators that share a store.
- One sender per process (FIFO queue), so operator nonces never collide. 503 with `Retry-After` when the operator cannot pay the gas, the estimate is above `MAX_GAS` or the queue is busy.
- Reconcile: calling `/settle` again after `settlement_pending`, a timeout or a restart rebroadcasts the identical signed bytes and waits again. A new transaction is sent only when the old one provably can never be mined, and only by one caller. An authorization that expires before mining is reported, never retried.
- Stores: `memoryStore()` and `sqliteStore(path)` (`railpay-facilitator/sqlite`, `node:sqlite`). The Node server uses SQLite by default (`STORE`, `SQLITE_PATH`).
- New settings: `OPERATOR_KEY` (required), `RECEIPT_TIMEOUT_MS`, `MAX_GAS`. `/supported` lists the operator as signer.
- Tests run the real `railpay-sdk` v0.1.0 seller (`createPaywall`) against this facilitator.

## [0.2.0] - 2026-11-22

On-chain checks. Still no `/settle`.

- `/verify` now reads Robinhood Chain after the offline checks pass: the RPC's chain id, `authorizationState(from, nonce)`, the payer's USDG balance, and an `eth_call` of `transferWithAuthorization` that catches anything else the token would refuse.
- Token reverts are decoded (USDG's `InsufficientFunds()` and `InvalidSignature()`, `Error(string)`, `Panic`) and mapped to spec codes. RPC failures answer `unexpected_verify_error`.
- `RPC_URL` setting (default publicnode). RPC errors are reduced to the node's own message: the URL, which may hold an API key, and request bodies never reach an answer or a log.
- `pnpm smoke`: a read-only check against the live chain (chain id, USDG `name()` and `DOMAIN_SEPARATOR()` against the EIP-712 domain, `authorizationState`, a reverting simulation, `verify` end to end).
- Exports `createChain`, `decodeRevert`, `transferCalldata` and `RpcError`.

## [0.1.0] - 2026-11-22

First release: verification only. There is no `/settle` and no on-chain check yet.

- `POST /verify` for x402 v2, scheme `exact`, USDG on Robinhood Chain (`eip155:4663`): strict parsing of the request, then recipient, exact amount, validity window (with a safety margin) and the EIP-712 `TransferWithAuthorization` signature (domain "Global Dollar", version 1, chain 4663, USDG).
- `GET /supported` lists `exact` on `eip155:4663`.
- Every rejection uses an error code from the x402 v2 spec (section 9), with a readable `invalidMessage`.
- Hono app (`createApp`) and a Node server (`pnpm start`, `PORT`, `HOST`, `VALIDITY_MARGIN_SECONDS`).
