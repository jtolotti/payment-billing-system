-- Migration: ledger idempotency key + charge records + billing config
--
-- Three additive changes:
--   1. idempotency_key on ledger_transactions — defense-in-depth dedup for ledger writes
--   2. charge_records table — log every settled gateway charge for refund auto-population
--   3. billing_config table — runtime-configurable key/value parameters

-- #1 Ledger idempotency key
ALTER TABLE "ledger_transactions" ADD COLUMN "idempotency_key" VARCHAR(1000);
CREATE UNIQUE INDEX "ledger_transactions_idempotency_key_key" ON "ledger_transactions"("idempotency_key");

-- #2 Charge records
CREATE TABLE "charge_records" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "gateway_type" "PaymentGateway" NOT NULL,
    "gateway_transaction_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "plan" "SubscriptionPlan",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "charge_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "charge_records_gateway_type_gateway_transaction_id_key"
    ON "charge_records"("gateway_type", "gateway_transaction_id");

CREATE INDEX "charge_records_user_id_gateway_type_created_at_idx"
    ON "charge_records"("user_id", "gateway_type", "created_at");

ALTER TABLE "charge_records" ADD CONSTRAINT "charge_records_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- #3 Billing config
CREATE TABLE "billing_config" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_config_pkey" PRIMARY KEY ("key")
);

-- Default values
INSERT INTO "billing_config" ("key", "value", "updated_at") VALUES
    ('chargeback_fee_cents', '1500', NOW());
