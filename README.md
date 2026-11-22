![railpay-facilitator: RailPay](.github/banner.png)

# railpay-facilitator

A self-hostable [x402](https://www.x402.org) v2 facilitator for [RailPay](https://railpay.app) on Robinhood Chain.

An x402 seller answers `402 Payment Required`, the buyer signs a payment, and a **facilitator** checks that payment and settles it on-chain. This package is that facilitator for one network and one token: USDG (Global Dollar, 6 decimals) on Robinhood Chain (chain id 4663), scheme `exact`, with EIP-3009 `TransferWithAuthorization`.

> **Status: v0.1, verification only.** This release checks payments offline: EIP-712 signature, recipient, amount, network and validity window. It does not read the chain yet and it has **no `/settle`**. Do not use it to decide whether to serve a paid resource on its own.

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
| `VALIDITY_MARGIN_SECONDS` | `6` | `validBefore` must be at least this far in the future |

## API

Request and response bodies follow the [x402 v2 specification](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md), section 7.

### `POST /verify`

```json
{ "x402Version": 2, "paymentPayload": { "...": "..." }, "paymentRequirements": { "...": "..." } }
```

Answers `200` with `{ "isValid": true, "payer": "0x…" }` or `{ "isValid": false, "invalidReason": "…", "invalidMessage": "…", "payer": "0x…" }`. `invalidReason` is always one of the spec's error codes (section 9). `invalidMessage` is a readable explanation; it is not in the spec table, and the x402 reference implementation uses the same field.

Checks, in order: x402 version; scheme `exact`; network `eip155:4663`; asset USDG with `extra.name` = `"Global Dollar"` and `extra.version` = `"1"`; `accepted` equal to the requirements; field formats; `authorization.to` = `payTo`; `authorization.value` = `amount` exactly; `validAfter` ≤ now; `validBefore` ≥ now + margin; the EIP-712 signature recovers to `authorization.from`.

Malformed JSON answers `400`, a body over 16 KiB `413`, both with the same `VerifyResponse` shape.

### `GET /supported`

```json
{ "kinds": [{ "x402Version": 2, "scheme": "exact", "network": "eip155:4663" }], "extensions": [], "signers": {} }
```

### Library

```ts
import { createFacilitator, createApp } from "railpay-facilitator";

const facilitator = createFacilitator();
const result = await facilitator.verify(paymentPayload, paymentRequirements);
const app = createApp(facilitator); // a Hono app: app.fetch(request)
```

## Development

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

Tests sign real EIP-3009 authorizations with throwaway keys.

## Links

- Website: https://railpay.app
- Docs: https://docs.railpay.app
- Dapp: https://dapp.railpay.app
- SDK: https://github.com/railpayapp/railpay-sdk
- MCP server: https://github.com/railpayapp/railpay-mcp
- X: https://x.com/railpayapp

## License

[MIT](LICENSE)
