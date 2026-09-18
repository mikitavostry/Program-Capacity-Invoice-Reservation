-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "program_status" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "reservation_status" AS ENUM ('ACTIVE', 'RELEASED');

-- CreateEnum
CREATE TYPE "movement_type" AS ENUM ('RESERVE', 'RELEASE');

-- CreateTable
CREATE TABLE "programs" (
    "id" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "credit_limit_minor" BIGINT NOT NULL,
    "reserved_minor" BIGINT NOT NULL,
    "status" "program_status" NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" TEXT NOT NULL,
    "program_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "invoice_currency" CHAR(3) NOT NULL,
    "invoice_minor" BIGINT NOT NULL,
    "reserved_currency" CHAR(3) NOT NULL,
    "reserved_minor" BIGINT NOT NULL,
    "exchange_rate" DECIMAL(24,8),
    "rate_as_of" TIMESTAMPTZ(3),
    "repaid_minor" BIGINT NOT NULL,
    "released_minor" BIGINT NOT NULL,
    "status" "reservation_status" NOT NULL,
    "reserved_at" TIMESTAMPTZ(3) NOT NULL,
    "released_at" TIMESTAMPTZ(3),

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capacity_movements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "program_id" TEXT NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "type" "movement_type" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "available_after_minor" BIGINT NOT NULL,
    "repayment_id" TEXT,
    "repaid_currency" CHAR(3),
    "repaid_minor" BIGINT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capacity_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "programs_id_currency_key" ON "programs"("id", "currency");

-- CreateIndex
CREATE INDEX "reservations_program_id_reserved_at_idx" ON "reservations"("program_id", "reserved_at");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_one_active_per_invoice" ON "reservations"("program_id", "invoice_id") WHERE (status = 'ACTIVE');

-- CreateIndex
CREATE INDEX "capacity_movements_program_id_occurred_at_idx" ON "capacity_movements"("program_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "capacity_movements_program_id_repayment_id_key" ON "capacity_movements"("program_id", "repayment_id");

-- CreateIndex
CREATE UNIQUE INDEX "capacity_movements_one_reserve_per_reservation" ON "capacity_movements"("reservation_id") WHERE (type = 'RESERVE');

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_program_id_reserved_currency_fkey" FOREIGN KEY ("program_id", "reserved_currency") REFERENCES "programs"("id", "currency") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capacity_movements" ADD CONSTRAINT "capacity_movements_program_id_currency_fkey" FOREIGN KEY ("program_id", "currency") REFERENCES "programs"("id", "currency") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capacity_movements" ADD CONSTRAINT "capacity_movements_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------
-- Written by hand: invariants the Prisma schema language cannot express.
--
-- The aggregates are the primary guard of every rule below. These repeat the ones that can
-- be stated as constraints, so that a bug which gets past the domain and the row lock still
-- cannot write a state the model says is impossible. See docs/architecture.md §11.2.
-- ---------------------------------------------------------------------------------------

ALTER TABLE "programs"
    ADD CONSTRAINT "programs_credit_limit_positive"
        CHECK ("credit_limit_minor" > 0),
    ADD CONSTRAINT "programs_reserved_within_limit"
        CHECK ("reserved_minor" >= 0 AND "reserved_minor" <= "credit_limit_minor"),
    ADD CONSTRAINT "programs_version_non_negative"
        CHECK ("version" >= 0);

ALTER TABLE "reservations"
    ADD CONSTRAINT "reservations_amounts_positive"
        CHECK ("invoice_minor" > 0 AND "reserved_minor" > 0),
    ADD CONSTRAINT "reservations_repaid_within_invoice"
        CHECK ("repaid_minor" >= 0 AND "repaid_minor" <= "invoice_minor"),
    ADD CONSTRAINT "reservations_released_within_reserved"
        CHECK ("released_minor" >= 0 AND "released_minor" <= "reserved_minor"),
    -- A rate is recorded with its observation time, or not at all.
    ADD CONSTRAINT "reservations_rate_complete"
        CHECK (("exchange_rate" IS NULL) = ("rate_as_of" IS NULL)),
    ADD CONSTRAINT "reservations_rate_positive"
        CHECK ("exchange_rate" IS NULL OR "exchange_rate" > 0),
    -- Without a rate nothing was converted, so both sides are the same money.
    ADD CONSTRAINT "reservations_unconverted_amounts_match"
        CHECK ("exchange_rate" IS NOT NULL OR (
            "invoice_currency" = "reserved_currency"
            AND "invoice_minor" = "reserved_minor"
            AND "repaid_minor" = "released_minor"
        )),
    -- Released exactly when fully repaid, and then everything held has been freed.
    ADD CONSTRAINT "reservations_released_when_fully_repaid"
        CHECK (("status" = 'RELEASED') = ("repaid_minor" = "invoice_minor")),
    ADD CONSTRAINT "reservations_fully_repaid_frees_everything"
        CHECK ("status" <> 'RELEASED' OR "released_minor" = "reserved_minor"),
    ADD CONSTRAINT "reservations_release_time_matches_status"
        CHECK (("status" = 'RELEASED') = ("released_at" IS NOT NULL)),
    ADD CONSTRAINT "reservations_release_not_before_reservation"
        CHECK ("released_at" IS NULL OR "released_at" >= "reserved_at");

ALTER TABLE "capacity_movements"
    ADD CONSTRAINT "capacity_movements_amounts_non_negative"
        CHECK ("amount_minor" >= 0 AND "available_after_minor" >= 0),
    ADD CONSTRAINT "capacity_movements_reserve_holds_something"
        CHECK ("type" <> 'RESERVE' OR "amount_minor" > 0),
    -- A RELEASE always records the repayment that caused it; a RESERVE never has one.
    ADD CONSTRAINT "capacity_movements_repayment_matches_type"
        CHECK (
            ("type" = 'RESERVE'
                AND "repayment_id" IS NULL AND "repaid_currency" IS NULL AND "repaid_minor" IS NULL)
            OR
            ("type" = 'RELEASE'
                AND "repayment_id" IS NOT NULL AND "repaid_currency" IS NOT NULL AND "repaid_minor" > 0)
        );

-- The ledger is append-only. Rows are facts about what happened; correcting one means
-- appending another, never rewriting history.
CREATE FUNCTION "capacity_movements_reject_change"() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'capacity_movements is append-only; % is not permitted', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "capacity_movements_append_only"
    BEFORE UPDATE OR DELETE ON "capacity_movements"
    FOR EACH ROW EXECUTE FUNCTION "capacity_movements_reject_change"();
