# Broker access from the Wallet and Investments page

The browser uses the signed-in Shark AI account. The backend does not accept a broker account ID or owner ID from the request. The owner view displays up to five accounts, up to 20 broker-reconciled managed positions per account, and up to ten recent local order states per account. A receipt timestamp identifies the last provider observation when one is available. Orders still being submitted or reconciled stay labelled accordingly. A stale or incomplete snapshot leaves the positions field unavailable. The generic Shark AI finance status grant does not receive the browser's position and order list.

## Revocation behavior

The app revokes analysis access and broker trading in one PostgreSQL transaction. The broker's owner lock serializes revocation, order reservation, and submission claim. It persists the owner stop, disables their linked trading accounts, revokes their order consent, and voids reservations that have not entered submission. Other owners are unaffected. Accounts attached later still face the persistent owner stop. [PostgreSQL transaction-level locking](https://www.postgresql.org/docs/current/explicit-locking.html)

An order whose submission claim already committed can be in flight or at the provider. Its evidence stays in the ledger and still requires reconciliation. Stopping future submissions initiates no provider cancellation, sale, or withdrawal. The app has no automatic resumption path.

## Installation boundary

The private ledger is local source and isolated-test material. It needs an operator-reviewed same-database deployment and an exact registration of the app's physical *WalletInvestmentSettings* relation in *sharkai_broker.owner_application*. Before registration, the ledger refuses reservations and claims. A table in a different PostgreSQL database cannot be registered by its local relation identifier. Keep the order runner, same-database linking and provider scopes disabled until operator approval and authenticated broker reconciliation are available.

The [ledger SQL](../n8n/sql/investment-order-ledger.sql) grants no access to the application or a browser role. The server runtime needs narrowly scoped execution of the owner read/revoke functions after approval. The broker worker needs separate operator-reviewed ledger rights. The app can revoke its own analysis access while the broker schema is absent. A present but inaccessible, outdated, or mismatched broker boundary fails the revocation transaction so the app avoids reporting a stop it could not commit.
