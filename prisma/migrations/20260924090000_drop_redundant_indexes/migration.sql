-- Two indexes no query needs, each still written on every insert:
-- - reservations (program_id, invoice_id) repeats the leading columns of the unique index on
--   (program_id, invoice_id, reservation_key), which serves the same lookups.
-- - outbox_events.position is unique by its sequence, and the relay reads it only through the
--   partial index on unpublished rows.

-- DropIndex
DROP INDEX "outbox_events_position_key";

-- DropIndex
DROP INDEX "reservations_program_id_invoice_id_idx";

