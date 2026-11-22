![railpay-facilitator: RailPay](.github/banner.png)

# railpay-facilitator

A self-hostable [x402](https://www.x402.org) v2 facilitator for [RailPay](https://railpay.app) on Robinhood Chain.

An x402 seller answers `402 Payment Required`, the buyer signs a payment, and a **facilitator** checks that payment and settles it on-chain. This package is that facilitator for one network and one token: USDG (Global Dollar, 6 decimals) on Robinhood Chain (chain id 4663), scheme `exact`, with EIP-3009 `TransferWithAuthorization`.

- `POST /verify` checks a payment without touching it: request shape, signature, recipient, amount, validity window, then the chain (authorization nonce, payer balance, a simulated `transferWithAuthorization`).
- `POST /settle` verifies again, sends `transferWithAuthorization` from your **operator** key (which pays the gas), waits for the receipt and answers success only when the exact USDG `Transfer` log is on-chain.
- One authorization never gets two transactions from this facilitator, and never two success answers.

## Quick start (Node)

Node 22.13 or newer. You need an **operator key**: a fresh private key used only for this, holding a little ETH on Robinhood Chain for gas. It never holds USDG: the payment goes from the payer straight to `payTo`. Never use a treasury or personal key.

```sh
git clone https://github.com/railpayapp/railpay-facilitator
cd railpay-facilitator
pnpm install                 # also builds dist/
read -rs OPERATOR_KEY; export OPERATOR_KEY    # paste the key, it is not echoed
pnpm start                   # node dist/node.js on http://127.0.0.1:8787
```

```sh
curl -s http://127.0.0.1:8787/supported
```

Point a RailPay SDK seller at it:

```ts
import { createPaywall } from "railpay-sdk";

const paywall = createPaywall({
  payTo: "0xYourWallet",
  price: "0.01",
  facilitators: ["http://localhost:8787"],
});
```

The SDK seller calls `POST /settle` only, then reads the receipt and the `Transfer` log itself before serving. A facilitator's word alone is not trusted, which is the right design: this facilitator checks the same thing on its side.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `OPERATOR_KEY` | required | Operator private key, 64 hex characters (optional `0x`). Pays the gas. Never logged or returned |
| `RPC_URL` | `https://robinhood-rpc.publicnode.com` | Robinhood Chain JSON-RPC. Use your own (Alchemy, dRPC) in production. It may contain an API key: it is never logged or returned in an answer |
| `VALIDITY_MARGIN_SECONDS` | `6` | `validBefore` must be at least this far in the future, at verification and again right before sending |
| `RECEIPT_TIMEOUT_MS` | `20000` | How long `/settle` waits for the receipt before answering `settlement_pending` (minimum 1000) |
| `MAX_GAS` | `300000` | Refuse to send when the gas estimate is above this. A USDG settlement estimates at about 48,000 |
| `STORE` | `sqlite` | Node: `sqlite` (survives restarts) or `memory` (lost on restart) |
| `SQLITE_PATH` | `./railpay-facilitator.db` | Node: SQLite file for settlement records |
| `PORT` | `8787` | Node: listen port |
| `HOST` | `127.0.0.1` | Node: listen address. Set `0.0.0.0` to accept outside connections |

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

`/verify` also refuses an authorization that this facilitator is settling or has settled (`invalid_payload`).

### `POST /settle`

Same request body as `/verify`. Answers the spec's `SettleResponse`:

```json
{ "success": true, "transaction": "0x…", "network": "eip155:4663", "payer": "0x…", "amount": "10000" }
{ "success": false, "errorReason": "…", "errorMessage": "…", "transaction": "", "network": "eip155:4663", "payer": "0x…" }
```

What happens:

1. Every `/verify` check runs again, and the simulation runs from the operator address.
2. The authorization is **claimed** in the store (an atomic insert): a concurrent or repeated call for the same authorization stops here.
3. One sender at a time per process: estimate gas, read EIP-1559 fees (max fee = 2 × base fee + priority fee) and the operator's pending nonce, check the operator can pay `gas × maxFee`, sign.
4. The signed transaction and its hash are **written to the store before broadcast**, so the store always knows any hash that may be on the wire.
5. Broadcast, then wait for the receipt (`RECEIPT_TIMEOUT_MS`). Success requires status 1 **and** exactly one USDG `Transfer(payer → payTo, amount)` log.

| Outcome | HTTP | Body |
|---|---|---|
| Confirmed with the exact transfer | 200 | `success: true`, `transaction` |
| A check failed, nothing sent | 200 | `success: false`, the spec code, `transaction: ""` |
| Broadcast, not confirmed yet | 200 | `errorReason: "settlement_pending"`, `transaction` = the hash |
| Mined but reverted, or no exact `Transfer` log | 200 | `errorReason: "invalid_transaction_state"`, `transaction` = the hash. Terminal |
| Already settled by this facilitator | 200 | `errorReason: "invalid_payload"`, `transaction: ""` |
| Operator cannot pay the gas, gas estimate over `MAX_GAS`, sender busy | 503 + `Retry-After` | `errorReason: "unexpected_settle_error"`, nothing sent |
| The RPC refused the transaction (it was not broadcast) | 502 | `errorReason: "unexpected_settle_error"`, the claim is released |

**Retrying is safe.** Call `/settle` again with the same payload after `settlement_pending` (or a timeout, or a restart) and it reconciles instead of sending anew: it looks for the receipt, rebroadcasts the **identical signed bytes** (same hash, so never a second transaction) and waits again. It starts a new transaction only when the old one provably can never be mined (another transaction took its operator nonce), and then only one caller can do it. If the chain clock passes `validBefore` before the transaction is mined, the answer is `invalid_exact_evm_payload_authorization_valid_before`: mined later, the token reverts it and nothing moves.

A success answer is handed out once per authorization. A later call answers `invalid_payload` with the transaction hash in `errorMessage`.

### `GET /supported`

```json
{ "kinds": [{ "x402Version": 2, "scheme": "exact", "network": "eip155:4663" }], "extensions": [], "signers": { "eip155:*": ["0xOperator…"] } }
```

## Stores

The store remembers each authorization this facilitator touched (claimed, submitted with its signed transaction, settled, failed).

| Store | Survives restart | Safe for several instances |
|---|---|---|
| `memoryStore()` | no | no: one process only |
| `sqliteStore(path)` (`railpay-facilitator/sqlite`, Node) | yes | claims are atomic across processes on the same file, but run **one Node process per operator key**: the nonce sender is per process |

Whatever the store, an authorization can land on-chain only once (the token's own nonce check). The store is what keeps this facilitator from spending gas on duplicates and from answering success twice.

### Library

```ts
import { createFacilitator, createApp } from "railpay-facilitator";
import { sqliteStore } from "railpay-facilitator/sqlite";

const facilitator = createFacilitator({
  operatorKey: process.env.OPERATOR_KEY as `0x${string}`,
  rpcUrl: process.env.RPC_URL,
  store: sqliteStore("./settlements.db"),
});
await facilitator.verify(paymentPayload, paymentRequirements);
await facilitator.settle(paymentPayload, paymentRequirements);
const app = createApp(facilitator); // a Hono app: app.fetch(request)
```

## Security model (so far)

- The operator key signs one kind of transaction: `transferWithAuthorization` on USDG, with `value: 0`. It cannot move anyone's funds without their EIP-3009 signature, and it holds no USDG. What it can lose is its ETH, spent as gas.
- Gas is spent only after every check and a successful simulation. A transaction can still revert if the payer moves funds between the simulation and the block; that gas is lost and the answer says so.
- `/settle` has no authentication. Anyone who can reach it can make the operator pay gas for valid payments to any `payTo`. Keep it on `127.0.0.1` or a private network until the next release adds amount limits, a `payTo` allowlist, rate limits and a low-gas guard.
- The RPC URL and the operator key never appear in logs, errors or answers.

## Development

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
pnpm smoke   # read-only check against Robinhood Chain: chain id, USDG name and DOMAIN_SEPARATOR, authorizationState, a reverting simulation
```

Tests sign real EIP-3009 authorizations and operator transactions with throwaway keys and run against an in-memory chain (a viem custom transport) that mines, reverts, drops and rebroadcasts transactions. One suite runs the real `railpay-sdk` seller (`createPaywall`) against this facilitator. No network needed.

## Links

- Website: https://railpay.app
- Docs: https://docs.railpay.app
- Dapp: https://dapp.railpay.app
- SDK: https://github.com/railpayapp/railpay-sdk
- MCP server: https://github.com/railpayapp/railpay-mcp
- X: https://x.com/railpayapp

## License

[MIT](LICENSE)
