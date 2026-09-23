-- A reservation may carry the caller's key. The service refuses to reserve an invoice again after
-- it was fully repaid unless the request brings a new key, so a delayed retry of the original
-- request cannot hold the same invoice's capacity twice (docs/architecture.md §2.6).

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "reservation_key" TEXT;

-- CreateIndex
CREATE INDEX "reservations_program_id_invoice_id_idx" ON "reservations"("program_id", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_program_id_invoice_id_reservation_key_key" ON "reservations"("program_id", "invoice_id", "reservation_key");

