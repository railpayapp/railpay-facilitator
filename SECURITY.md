# Security

Please report vulnerabilities privately to **founder@railpay.app**. Do not open a public issue.

Include what you found, how to reproduce it and what it affects. We will reply within a few days.

In scope: this facilitator, in particular anything that

- makes `/verify` or `/settle` accept a payment it should reject;
- makes `/settle` send two transactions for one authorization, or answer success twice or without the exact transfer on-chain;
- leaks the operator key or the RPC URL;
- lets a caller make the operator spend gas beyond what the documented limits allow.
