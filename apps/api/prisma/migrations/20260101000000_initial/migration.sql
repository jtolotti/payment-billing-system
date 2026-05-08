-- Initial schema for Billing Trial
-- Hand-written idempotent migration matching schema.prisma

-- Enums -------------------------------------------------------------------

DO $$ BEGIN CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'CANCELED', 'TRIALING'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SubscriptionPlan" AS ENUM ('BASIC', 'STANDARD', 'PREMIUM'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CreditTransactionType" AS ENUM ('PURCHASE', 'BONUS', 'USAGE', 'REFUND', 'ADJUSTMENT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "LedgerAccountType" AS ENUM ('ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE', 'EQUITY'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "LedgerEntryType" AS ENUM ('DEBIT', 'CREDIT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "LedgerTransactionStatus" AS ENUM ('PENDING', 'ESCROWED', 'COMPLETED', 'REFUNDED', 'CANCELED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PaymentGateway" AS ENUM ('AUTHORIZE_NET', 'SOLANA'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "RefundType" AS ENUM ('CREDITS', 'PAYMENT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'PROCESSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'EVIDENCE_SUBMITTED', 'WON', 'LOST'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Users -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "users" (
  "id" TEXT PRIMARY KEY,
  "email" TEXT NOT NULL UNIQUE,
  "name" TEXT,
  "role" "UserRole" NOT NULL DEFAULT 'USER',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);

-- Plans -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "plans" (
  "id" TEXT PRIMARY KEY,
  "key" "SubscriptionPlan" NOT NULL UNIQUE,
  "display_name" TEXT NOT NULL,
  "price_cents" INTEGER NOT NULL,
  "monthly_credits" INTEGER NOT NULL,
  "description" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);

-- Subscriptions -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL UNIQUE REFERENCES "users"("id") ON DELETE CASCADE,
  "status" "SubscriptionStatus" NOT NULL DEFAULT 'INACTIVE',
  "plan" "SubscriptionPlan" NOT NULL DEFAULT 'BASIC',
  "current_period_start" TIMESTAMP(3),
  "current_period_end" TIMESTAMP(3),
  "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
  "canceled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);

CREATE INDEX IF NOT EXISTS "subscriptions_status_idx" ON "subscriptions"("status");
CREATE INDEX IF NOT EXISTS "subscriptions_current_period_end_idx" ON "subscriptions"("current_period_end");

CREATE TABLE IF NOT EXISTS "gateway_subscriptions" (
  "id" TEXT PRIMARY KEY,
  "subscription_id" TEXT NOT NULL UNIQUE REFERENCES "subscriptions"("id") ON DELETE CASCADE,
  "gateway_type" "PaymentGateway" NOT NULL,
  "gateway_subscription_id" TEXT,
  "gateway_customer_id" TEXT,
  "gateway_data" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);

CREATE INDEX IF NOT EXISTS "gateway_subscriptions_gateway_idx" ON "gateway_subscriptions"("gateway_type", "gateway_subscription_id");

CREATE TABLE IF NOT EXISTS "gateway_customers" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "gateway" "PaymentGateway" NOT NULL,
  "gateway_customer_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  UNIQUE ("user_id", "gateway"),
  UNIQUE ("gateway", "gateway_customer_id")
);

CREATE TABLE IF NOT EXISTS "vaulted_cards" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "last4" TEXT NOT NULL,
  "brand" TEXT NOT NULL,
  "exp_month" INTEGER NOT NULL,
  "exp_year" INTEGER NOT NULL,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);

CREATE INDEX IF NOT EXISTS "vaulted_cards_user_id_idx" ON "vaulted_cards"("user_id");

-- Credits -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "credits" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL UNIQUE REFERENCES "users"("id") ON DELETE CASCADE,
  "balance" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS "credit_transactions" (
  "id" TEXT PRIMARY KEY,
  "credits_id" TEXT NOT NULL REFERENCES "credits"("id") ON DELETE CASCADE,
  "amount" INTEGER NOT NULL,
  "type" "CreditTransactionType" NOT NULL,
  "description" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "credit_transactions_credits_id_created_at_idx" ON "credit_transactions"("credits_id", "created_at");

-- Ledger ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "ledger_accounts" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "account_type" "LedgerAccountType" NOT NULL,
  "balance" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  UNIQUE ("user_id", "account_type")
);

CREATE INDEX IF NOT EXISTS "ledger_accounts_user_id_idx" ON "ledger_accounts"("user_id");

CREATE TABLE IF NOT EXISTS "ledger_transactions" (
  "id" TEXT PRIMARY KEY,
  "transaction_id" TEXT NOT NULL,
  "user_id" TEXT REFERENCES "users"("id") ON DELETE CASCADE,
  "description" TEXT NOT NULL,
  "status" "LedgerTransactionStatus" NOT NULL DEFAULT 'COMPLETED',
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);

CREATE INDEX IF NOT EXISTS "ledger_transactions_user_id_status_idx" ON "ledger_transactions"("user_id", "status");
CREATE INDEX IF NOT EXISTS "ledger_transactions_transaction_id_idx" ON "ledger_transactions"("transaction_id");
CREATE INDEX IF NOT EXISTS "ledger_transactions_created_at_idx" ON "ledger_transactions"("created_at");

CREATE TABLE IF NOT EXISTS "ledger_entries" (
  "id" TEXT PRIMARY KEY,
  "ledger_transaction_id" TEXT NOT NULL REFERENCES "ledger_transactions"("id") ON DELETE CASCADE,
  "account_id" TEXT NOT NULL REFERENCES "ledger_accounts"("id") ON DELETE CASCADE,
  "entry_type" "LedgerEntryType" NOT NULL,
  "amount" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "ledger_entries_ledger_transaction_id_idx" ON "ledger_entries"("ledger_transaction_id");
CREATE INDEX IF NOT EXISTS "ledger_entries_account_id_idx" ON "ledger_entries"("account_id");

-- Webhook dedup -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS "processed_webhooks" (
  "id" TEXT PRIMARY KEY,
  "source" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "processed_webhooks_source_event_type_idx" ON "processed_webhooks"("source", "event_type");
CREATE INDEX IF NOT EXISTS "processed_webhooks_processed_at_idx" ON "processed_webhooks"("processed_at");

-- Refunds -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "refund_requests" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "type" "RefundType" NOT NULL,
  "amount" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
  "reviewed_by" TEXT REFERENCES "users"("id"),
  "reviewed_at" TIMESTAMP(3),
  "review_notes" TEXT,
  "payment_refund_id" TEXT,
  "gateway_type" "PaymentGateway",
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);

CREATE INDEX IF NOT EXISTS "refund_requests_user_id_status_idx" ON "refund_requests"("user_id", "status");
CREATE INDEX IF NOT EXISTS "refund_requests_status_created_at_idx" ON "refund_requests"("status", "created_at");

-- Disputes ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "disputes" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "gateway" "PaymentGateway" NOT NULL,
  "gateway_dispute_id" TEXT NOT NULL UNIQUE,
  "original_transaction_id" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "reason" TEXT,
  "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
  "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMP(3),
  "ledger_reversal_txn_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);

CREATE INDEX IF NOT EXISTS "disputes_user_id_status_idx" ON "disputes"("user_id", "status");
CREATE INDEX IF NOT EXISTS "disputes_status_opened_at_idx" ON "disputes"("status", "opened_at");

CREATE TABLE IF NOT EXISTS "dispute_evidence" (
  "id" TEXT PRIMARY KEY,
  "dispute_id" TEXT NOT NULL REFERENCES "disputes"("id") ON DELETE CASCADE,
  "submitted_by" TEXT NOT NULL,
  "evidence_type" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "metadata" JSONB,
  "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "dispute_evidence_dispute_id_idx" ON "dispute_evidence"("dispute_id");
