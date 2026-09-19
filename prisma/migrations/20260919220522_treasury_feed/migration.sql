-- AlterTable
ALTER TABLE "programs" ADD COLUMN     "treasury_sequence" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "treasury_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "program_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "applied" BOOLEAN NOT NULL,
    "reason" TEXT,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "treasury_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "treasury_events_event_id_key" ON "treasury_events"("event_id");

-- CreateIndex
CREATE INDEX "treasury_events_program_id_sequence_idx" ON "treasury_events"("program_id", "sequence");

-- AddForeignKey
ALTER TABLE "treasury_events" ADD CONSTRAINT "treasury_events_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------
-- Written by hand.
--
-- A program may now sit OVER its limit, so the invariant weakens from
-- `reserved <= limit` to `reserved >= 0`.
--
-- Treasury owns the credit limit and may cut it below what is already reserved. Existing
-- reservations are commitments that cannot be torn up to fit a smaller limit, so the
-- program holds more than it may newly lend: `availableCapacity` goes negative and every
-- new reservation is refused until repayments bring it back under. Refusing treasury's
-- instruction instead would leave this service and the system of record disagreeing about
-- the limit, which is worse than recording an over-limit state and reporting it.
-- ---------------------------------------------------------------------------------------

ALTER TABLE "programs"
    DROP CONSTRAINT "programs_reserved_within_limit",
    ADD CONSTRAINT "programs_reserved_non_negative" CHECK ("reserved_minor" >= 0),
    ADD CONSTRAINT "programs_treasury_sequence_non_negative" CHECK ("treasury_sequence" >= 0);

-- Treasury events are facts about what arrived; a correction is another message, never a
-- rewrite of the one before it.
CREATE TRIGGER "treasury_events_append_only"
    BEFORE UPDATE OR DELETE ON "treasury_events"
    FOR EACH ROW EXECUTE FUNCTION "capacity_movements_reject_change"();
