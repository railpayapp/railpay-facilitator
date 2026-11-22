# Changelog

## [0.1.0] - 2026-11-22

First release: verification only. There is no `/settle` and no on-chain check yet.

- `POST /verify` for x402 v2, scheme `exact`, USDG on Robinhood Chain (`eip155:4663`): strict parsing of the request, then recipient, exact amount, validity window (with a safety margin) and the EIP-712 `TransferWithAuthorization` signature (domain "Global Dollar", version 1, chain 4663, USDG).
- `GET /supported` lists `exact` on `eip155:4663`.
- Every rejection uses an error code from the x402 v2 spec (section 9), with a readable `invalidMessage`.
- Hono app (`createApp`) and a Node server (`pnpm start`, `PORT`, `HOST`, `VALIDITY_MARGIN_SECONDS`).
