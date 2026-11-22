# Changelog

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
