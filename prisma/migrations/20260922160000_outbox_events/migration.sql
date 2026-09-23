-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "position" BIGSERIAL NOT NULL,
    "program_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_position_key" ON "outbox_events"("position");

-- CreateIndex
CREATE INDEX "outbox_events_unpublished" ON "outbox_events"("position") WHERE (published_at IS NULL);

