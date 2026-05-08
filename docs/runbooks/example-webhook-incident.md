# Webhook Missed: User Paid But Didn't Receive Credits

> **Purpose:** Recover a single user whose webhook was missed or failed.
> **Frequency:** ~1-3 per month in a healthy system. More indicates a platform issue.
> **Expected duration:** 10-20 minutes.
> **Prerequisites:** DB read/write access, gateway dashboard access, access to this repo's CreditsService.

This is the quality bar we're grading your chargeback runbook against. It should look like this one.

---

## 1. Severity classification

| Scenario | Severity | Action |
|---|---|---|
| One user reports missing credits, < $100 | **P3** | Manual recovery within 4 business hours |
| 3+ users report missing credits within 1 hour | **P2** | Investigate platform-level cause before manual recovery |
| Credit purchases failing system-wide, webhook endpoint timing out | **P1** | Incident channel, pause any automated reconciliation jobs, page on-call |

If you're not sure, default up one level. Over-paging is cheap; under-paging is not.

## 2. Diagnosis

### 2.1 Confirm the user actually paid

From the user's report, get: their email, the approximate time, and the amount. Then:

```sql
-- Find the user
SELECT id, email, created_at FROM users WHERE email = 'user@example.com';

-- Check what they think they paid for vs. what we show
SELECT
  ct.id, ct.amount, ct.type, ct.description, ct.created_at, ct.metadata
FROM credit_transactions ct
JOIN credits c ON c.id = ct.credits_id
WHERE c.user_id = '<user-id>'
ORDER BY ct.created_at DESC
LIMIT 10;
```

If the `credit_transactions` log has a matching row but the user says their balance is wrong, the problem is a frontend cache or stale read — not a missed webhook.

### 2.2 Confirm the webhook was received

```sql
-- Did we see ANY webhook in the window?
SELECT id, source, event_type, processed_at
FROM processed_webhooks
WHERE processed_at BETWEEN '<start>' AND '<end>'
  AND source = 'authorize_net'
ORDER BY processed_at DESC;
```

If nothing appears, the webhook either wasn't sent, wasn't delivered, or was rejected at the HMAC check. If it appears but the user still has no credits, the side effect failed inside the transaction — check the API logs for the corresponding `WARN` or `ERROR`.

### 2.3 Confirm the payment at the gateway

Open the Authorize.net (or Solana block explorer) dashboard and look up the transaction. Get:
- The gateway transaction id
- The exact amount in cents
- The exact charge timestamp
- Whether there's a successful settlement or just an auth

If the gateway shows the charge as declined or voided, the user is mistaken — no recovery needed, send them a "no charge was completed" notification.

## 3. Recovery

### 3.1 Single missed webhook — replay from the gateway

Most cases. The gateway offers a "resend webhook" button. Use it. Verify afterwards:

```sql
SELECT id, processed_at FROM processed_webhooks WHERE id = '<event-id>';
-- And:
SELECT balance FROM credits WHERE user_id = '<user-id>';
```

If balance is now correct, done. Notify the user that the issue is resolved.

### 3.2 Manual recovery (gateway replay failed or is impossible)

Use the CreditsService directly with an idempotency key derived from the original transaction id. This way, if the gateway later re-delivers the webhook, we won't double-credit.

```typescript
// From a one-off script or admin console
await creditsService.addCredits(
  userId,
  creditAmount,
  'PURCHASE',
  'Manual recovery: webhook missed, gateway txn_abc123',
  `authorize_net_charge_txn_abc123`,  // <-- same key the webhook would use
  {
    source: 'manual_recovery',
    originalGatewayTransactionId: 'txn_abc123',
    operatorUserId: '<your-user-id>',
    recoveryRunbook: 'example-webhook-incident.md',
  }
)
```

**Why the idempotency key matters:** if the webhook later arrives (e.g. the gateway retries it 24h later), the `CreditsService.addCredits` will see the duplicate key and short-circuit. No double credit. This is the single most important line in this runbook — if you skip the idempotency key, you cause a second bug while fixing the first.

### 3.3 Verify the ledger is also correct

Credits and Ledger are parallel systems — if you grant credits manually, you should also write the corresponding ledger entries to keep the formal accounting in sync:

```sql
-- Check the ledger transaction exists for this user + timeframe
SELECT lt.id, lt.transaction_id, lt.description, le.entry_type, le.amount
FROM ledger_transactions lt
JOIN ledger_entries le ON le.ledger_transaction_id = lt.id
WHERE lt.user_id = '<user-id>'
  AND lt.created_at > NOW() - INTERVAL '1 hour'
ORDER BY lt.created_at DESC;
```

If the ledger doesn't have the matching entry, write one via `LedgerService.recordTransaction` using the same metadata as the credits transaction.

## 4. User communication

Template:

```
Subject: Your credits have been added

Hi <name>,

We spotted a delay processing your recent <$X.XX> purchase. Your <N> credits
have now been added to your account.

Current balance: <N> credits.

This was a one-off processing issue on our side — you don't need to do anything.
Sorry for the friction.

— <company> Billing
```

Short, specific, no jargon. If the user is a paying customer, add a small credit bonus (5% of the amount) as a goodwill gesture and mention it in the email. If the user has had multiple missed-webhook incidents, escalate to support lead — that pattern may indicate a specific gateway or region issue.

## 5. Prevention

After you recover the single user, ask: **was this really a one-off?** Check:

```sql
-- How many webhooks are we receiving per day, by event type?
SELECT DATE_TRUNC('day', processed_at) AS day, event_type, COUNT(*)
FROM processed_webhooks
WHERE source = 'authorize_net'
  AND processed_at > NOW() - INTERVAL '7 days'
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
```

If the count for `charge.approved` today is >20% lower than yesterday, you have a platform issue, not a user issue. Escalate.

Also check whether the HMAC signature verification is rejecting events — if the `AUTHORIZE_NET_WEBHOOK_SECRET` was rotated on the gateway side but not in our env, every webhook will 400 out at `verifyHmac`. A rising rate of 400s on `/webhooks/authorize-net` is the signal.

## 6. What to log when closing the ticket

- User id
- Amount recovered
- Original gateway transaction id
- The idempotency key you used
- Whether gateway replay worked, or you did manual recovery
- One-line root cause ("gateway timeout on delivery" or "unknown — will monitor")
- Whether you checked for a pattern of similar incidents
