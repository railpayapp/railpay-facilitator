![railpay-facilitator: RailPay](.github/banner.png)

# railpay-facilitator

A self-hostable [x402](https://www.x402.org) v2 facilitator for [RailPay](https://railpay.app) on Robinhood Chain.

An x402 seller answers `402 Payment Required`, the buyer signs a payment, and a **facilitator** checks that payment and settles it on-chain. This package is that facilitator for one network and one token: USDG (Global Dollar, 6 decimals) on Robinhood Chain (chain id 4663), scheme `exact`, with EIP-3009 `TransferWithAuthorization`.

> **Status: verification only, no `/settle` yet.** `/verify` checks the signature, recipient, amount, network and validity window, then reads the chain: the authorization nonce, the payer's USDG balance and a simulated `transferWithAuthorization`. A valid answer means the payment can settle right now, not that it has. Settlement is coming in the next release.

## Quick start (Node)

Node 22.13 or newer.

```sh
git clone https://github.com/railpayapp/railpay-facilitator
cd railpay-facilitator
pnpm install          # also builds dist/
pnpm start            # http://127.0.0.1:8787
```

```sh
curl -s http://127.0.0.1:8787/supported
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `HOST` | `127.0.0.1` | Listen address. Set `0.0.0.0` to accept outside connections |
| `RPC_URL` | `https://robinhood-rpc.publicnode.com` | Robinhood Chain JSON-RPC. Use your own (Alchemy, dRPC) in production. It may contain an API key: it is never logged or returned in an answer |
| `VALIDITY_MARGIN_SECONDS` | `6` | `validBefore` must be at least this far in the future |

## API

Request and response bodies follow the [x402 v2 specification](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md), section 7.

### `POST /verify`

```json
{ "x402Version": 2, "paymentPayload": { "...": "..." }, "paymentRequirements": { "...": "..." } }
```

Answers `200` with `{ "isValid": true, "payer": "0x…" }` or `{ "isValid": false, "invalidReason": "…", "invalidMessage": "…", "payer": "0x…" }`. `invalidReason` is always one of the spec's error codes (section 9). `invalidMessage` is a readable explanation; it is not in the spec table, and the x402 reference implementation uses the same field.

Checks, in order:

1. Request: x402 version 2; scheme `exact`; network `eip155:4663`; asset USDG with `extra.name` = `"Global Dollar"` and `extra.version` = `"1"`; `accepted` equal to the requirements; field formats.
2. Authorization: `to` = `payTo`; `value` = `amount` exactly; `validAfter` ≤ now; `validBefore` ≥ now + margin.
3. Signature: the EIP-712 `TransferWithAuthorization` signature recovers to `authorization.from` (EOA payers).
4. Chain: the RPC reports chain id 4663; `authorizationState(from, nonce)` is false; the payer holds at least `value` USDG; an `eth_call` of `transferWithAuthorization` succeeds. A revert is mapped to a spec code (`insufficient_funds`, `invalid_exact_evm_payload_signature`, otherwise `invalid_transaction_state` with the revert reason in `invalidMessage`). An RPC failure answers `unexpected_verify_error`.

`/verify` never writes state and never sends a transaction. The chain is not read when an offline check already failed.

Malformed JSON answers `400`, a body over 16 KiB `413`, both with the same `VerifyResponse` shape.

### `GET /supported`

```json
{ "kinds": [{ "x402Version": 2, "scheme": "exact", "network": "eip155:4663" }], "extensions": [], "signers": {} }
```

### Library

```ts
import { createFacilitator, createApp } from "railpay-facilitator";

const facilitator = createFacilitator({ rpcUrl: process.env.RPC_URL });
const result = await facilitator.verify(paymentPayload, paymentRequirements);
const app = createApp(facilitator); // a Hono app: app.fetch(request)
```

## Development

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
pnpm smoke   # read-only check against Robinhood Chain: chain id, USDG name and DOMAIN_SEPARATOR, authorizationState, a reverting simulation
```

Tests sign real EIP-3009 authorizations with throwaway keys and run against an in-memory chain (a viem custom transport), so they need no network.

## Links

- Website: https://railpay.app
- Docs: https://docs.railpay.app
- Dapp: https://dapp.railpay.app
- SDK: https://github.com/railpayapp/railpay-sdk
- MCP server: https://github.com/railpayapp/railpay-mcp
- X: https://x.com/railpayapp

## License

[MIT](LICENSE)
