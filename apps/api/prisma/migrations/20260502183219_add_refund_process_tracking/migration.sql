-- AlterTable: Add process attempt tracking for operational visibility
ALTER TABLE "refund_requests" ADD COLUMN     "last_process_error" TEXT,
ADD COLUMN     "process_attempts" INTEGER NOT NULL DEFAULT 0;
