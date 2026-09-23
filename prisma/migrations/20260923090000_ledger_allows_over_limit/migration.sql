-- A program may sit over its limit after treasury cuts it below what is reserved (see
-- 20260919220522_treasury_feed), so the availability a ledger row records may be negative.
-- The old check refused exactly the repayments that bring such a program back under: a
-- partial repayment leaving it still over limit failed with a check violation.
--
-- The amount moved is still never negative.

ALTER TABLE "capacity_movements"
    DROP CONSTRAINT "capacity_movements_amounts_non_negative",
    ADD CONSTRAINT "capacity_movements_amount_non_negative" CHECK ("amount_minor" >= 0);
