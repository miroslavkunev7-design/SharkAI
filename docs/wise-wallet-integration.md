# Wise wallet balance pilot

The combined Wallet and Investments page can show the verified available balance of one explicitly approved Wise account and currency for its signed-in Shark AI owner. The amount is separate from broker cash, buying power, positions, and Stripe subscription payments. The app records when it reads the answer. A verified zero is a real provider response. [Wise balance response](https://docs.wise.com/api-reference/balance/balanceget)

| Status | Meaning |
| --- | --- |
| `provider_unconfigured` | This deployment has no active approved Wise integration or its configuration is invalid. OpenPayd is currently unsupported by this integration. |
| `provider_unlinked` | The signed-in owner has no approved link for the selected currency. |
| `verified` | Wise returned a visible, non-invested standard balance for the approved account and currency. |
| `unavailable` | Wise rejected the read, the request failed, or the response could not be verified. |
| `stale` | The approved OAuth token has expired. |

The pilot requires a provisioned partner client, a provider-created user/profile, enrollment for the Shark AI owner and a partner-approved token. In the provider-hosted review, the owner supplies identity documents directly to Wise. New user and profile enrollment currently takes place with the approved provider. [Wise partner access](https://docs.wise.com/guides/developer/auth-and-security) · [User OAuth token setup](https://docs.wise.com/guides/developer/auth-and-security/user-access-token)

**Отвори моя Wise** opens the owner's personal Wise Home in a separate window. Wise handles login and the browser determines whether to reuse an existing Wise session. Authorizing the application to synchronize private data requires the approved owner enrollment described below. If Wise has requested identity documents for an enrolled profile, the owner can open its hosted review from the wallet.

## Server-side configuration

For several approved owners use `WISE_WALLET_ENROLLMENTS`, a secret-store JSON array of objects with a validated `binding` and `token_secret_name`. Store each token separately under the named `WISE_WALLET_USER_TOKEN_*` environment variable. A Shark AI owner may have one approved balance per currency. Duplicate owner-currency selections and cross-owner reuse of a provider user, profile or balance invalidate the configuration. The single-owner configuration remains supported. Choose one configuration mode per deployment.

With no currency preference, the wallet automatically checks a single enrolled currency. Owners with several currencies can select one in the Wise connection panel. The display selection uses an owner-scoped, HTTP-only session cookie and the server checks it against the current enrollment on every request. The investment allocation keeps its own currency.

The following values belong only in a deployment secret store. The server operator must first verify the provider contract covers the live country, use of the named owner's account data, and the specific OAuth grant. The approver must confirm that Wise prevents all money movement using the enrolled token and that it permits the three required read calls. The token hash binds that approval to the enrolled token. Wise's documentation does not establish a universally available read-only scope for these endpoints. [Wise partner authentication](https://docs.wise.com/guides/developer/auth-and-security) · [Wise user access tokens](https://docs.wise.com/guides/developer/auth-and-security/user-access-token)

| Environment key | Expected value |
| --- | --- |
| `WALLET_PROVIDER` | `wise` once the partner agreement and owner opt-in are verified. |
| `WISE_WALLET_OWNER_BINDING` | Strict JSON with `owner_id`, `provider_user_id`, `profile_id`, `balance_id`, `currency`, `provider_read_approval_ref`, `token_sha256` and `token_expires_at`. IDs are strings and the expiry is a UTC ISO datetime supplied by Wise. The approval reference identifies the operator's verified provider and owner authorization. |
| `WISE_WALLET_OAUTH_ACCESS_TOKEN` | Wise user OAuth access token covered by that approval. The token stays in server configuration. |
| `WISE_WALLET_SERVER_CA_PEM` | Wise production trust certificate from its Developer Hub. |
| `WISE_WALLET_CLIENT_CERT_PEM` | Approved production mTLS client certificate. |
| `WISE_WALLET_CLIENT_KEY_PEM` | Matching private key. |

The adapter uses the fixed production mTLS origin and the `2026Q4` API. It verifies the authenticated, active Wise user with `GET /me`, checks the profile's `userId` and current state with `GET /profiles/{profileId}`, then matches the configured standard balance with `GET /profiles/{profileId}/balances/{balanceId}`. Application responses exclude Wise identity information and opaque provider IDs. Calls share a five-second deadline and never follow redirects. User token rotation requires re-enrolling the freshly issued, approved token and expiry. Wise revocation breaks the next read. Removing the binding or provider selection disables app-side wallet access. [Production mTLS](https://docs.wise.com/guides/developer/auth-and-security/mtls) · [Current user](https://docs.wise.com/api-reference/user/usergetbytoken) · [Profile owner](https://docs.wise.com/api-reference/profile/profileget) · [Balance read](https://docs.wise.com/api-reference/balance/balanceget)

The balance adapter takes the provider's `amount` field as the available balance. The same response also contains reserved funds, cash and total worth. [Wise balance fields](https://docs.wise.com/api-reference/balance/balanceget)

## Owner actions and n8n

W30, W31, W32 and W33 use the owner-scoped `/api/internal/wallet-investments/wallet/{operation}` endpoints. They require the service credential and a current short-lived grant for the same owner and settings revision. The owner-only dashboard adds two optional permissions to the existing `WISE_WALLET_OWNER_BINDING` enrollment.

* Add `statement_approval_ref` only when the partner has authorized statement access with the enrolled token. W32 reads the last seven days of the selected balance's Wise statement and checks the returned balance ID, currency and time window. Only posted `CREDIT` entries classified by Wise as `DEPOSIT` or `MONEY_ADDED` count. The response contains the count, the last credit's date and amount, and the statement window. Counterparty details and bank references remain outside the product response. If Wise requires renewed SCA, the result is unavailable until the owner authenticates with Wise. [Statement resource](https://docs.wise.com/api-reference/balance-statement/balancestatementget)
* Enroll `hosted_review: { "id": "<verified Wise review UUID>", "approval_ref": "<partner approval reference>" }` where the token has separate authorization for the named profile's KYC read and hosted-link call. A pre-balance enrollment omits `balance_id` until Wise provisions the balance. W30 checks current provider review status. Delegated read grants cannot create or see a KYC link. An authenticated same-origin owner POST checks the latest Wise status, requests the hosted link with the original application's return URL, validates the matching review, exact Wise destination and five-minute expiry, then redirects the owner's browser. The one-time link remains outside n8n and model context. Returning from Wise refreshes provider data. [Wise hosted flow](https://docs.wise.com/guides/product/account-setup/customer-onboarding/hosted-kyc) · [Wise single-use link](https://docs.wise.com/api-reference/kyc-review/kycreviewredirecturlupdate)
* For a verified wallet, W33 directs the owner to their Wise account. The owner selects a payment method or recipient, checks fees and timing and confirms within Wise. This action grants Shark AI no payment authority. [Wise owner withdrawal process](https://wise.com/help/articles/35lB9c1oCJY85UJPjH5Ihw/how-do-i-send-money-from-my-wise-account-to-my-bank)

The transfer and withdrawal buttons submit an empty same-origin form to `POST /api/wallet-investments/provider/transfer` or `/withdrawal`. The server checks the SharkAI session and reads the selected owner's Wise balance before redirecting to Wise Home. If the account check fails, the wallet opens its connection panel. The owner signs in to Wise, selects **Send**, reviews the recipient, fee and timing, and confirms there. Repeating the form opens the same Wise page. Wise displays the transfer status in its transaction history. SharkAI can subsequently display posted movements when that owner's statement access is approved. [Wise transfer instructions](https://wise.com/help/articles/2977959/how-do-i-send-money-with-wise)

## OpenPayd

Keep OpenPayd as an alternate for the platform contract. Its public partner API example includes both balance-read and payout authorities. The EEA terms and platform acceptance process control the actual account model. Availability of a linked vIBAN does not by itself establish a separate customer balance. End-user identity binding, single-account authorization, and credentials with zero payment authority need provider confirmation before adding a live adapter. [OpenPayd API](https://www.openpayd.com/api/) · [OpenPayd EEA terms](https://www.openpayd.com/legal/terms-of-use-eea-customers/) · [OpenPayd account structures](https://www.openpayd.com/blog/guide-how-to-issue-virtual-ibans-with-openpayd/)

## Event contract

The [normalized event schema](../schemas/wallet-provider-events.schema.json) covers the Wise `balances#update` v4 refresh hint. Future ingress must verify RSA-SHA256 over the original body using the correct environment's key, match the configured subscription, profile and balance, and atomically claim the Wise delivery ID before work. Treat test deliveries separately and make refreshes safe under replay and reordering. The verified balance read remains authoritative. This deliverable includes no public webhook receiver or webhook registration. [Wise signature and delivery header](https://docs.wise.com/guides/developer/webhooks/event-handling) · [Wise balance event example](https://docs.wise.com/guides/product/send-money/tracking/track-transfers) · [Wise ordering](https://docs.wise.com/guides/developer/webhooks/event-ordering)

Run the isolated fixtures with `npx --no-install tsx --test scripts/test-wise-wallet.mts`. Fixtures supply local provider responses and do not use an account, API token, or external network.
