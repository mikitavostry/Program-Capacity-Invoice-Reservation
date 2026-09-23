-- A program's currency never changes. With ON UPDATE CASCADE, changing it by hand would have
-- relabelled every reservation's held amount (and every ledger row) with the new currency
-- without converting it: $109,000 would silently become €109,000. RESTRICT refuses the change.
--
-- DropForeignKey
ALTER TABLE "capacity_movements" DROP CONSTRAINT "capacity_movements_program_id_currency_fkey";

-- DropForeignKey
ALTER TABLE "reservations" DROP CONSTRAINT "reservations_program_id_reserved_currency_fkey";

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_program_id_reserved_currency_fkey" FOREIGN KEY ("program_id", "reserved_currency") REFERENCES "programs"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "capacity_movements" ADD CONSTRAINT "capacity_movements_program_id_currency_fkey" FOREIGN KEY ("program_id", "currency") REFERENCES "programs"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

