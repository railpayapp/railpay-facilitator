/** Package version. Kept equal to package.json (a test checks it). */
export const VERSION = "0.1.0";

/** Robinhood Chain mainnet (Arbitrum Orbit L2, gas in ETH). */
export const CHAIN_ID = 4663;
/** CAIP-2 network id used by x402 v2. */
export const NETWORK = "eip155:4663";

/** USDG (Global Dollar) on Robinhood Chain: 6 decimals, EIP-3009 transferWithAuthorization. */
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
export const USDG_DECIMALS = 6;
/**
 * USDG's EIP-712 domain. USDG has no `version()` getter: the version is confirmed by recomputing the domain
 * separator and comparing it with `DOMAIN_SEPARATOR()` on-chain (see the smoke check).
 */
export const USDG_EIP712 = { name: "Global Dollar", version: "1" } as const;

export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;

/** EIP-3009 TransferWithAuthorization typed data. */
export const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
