#!/bin/sh
# Creates the service's topics on the local broker. It stands in for what a real environment
# does through infrastructure as code (Terraform, Strimzi KafkaTopic resources, …) with the
# same settings; production differs only in the replication factor (see docs/architecture.md).
#
# Safe to run again: a topic that already exists is left alone. Any other failure stops it,
# and the services that depend on it do not start.
set -eu

BROKERS="${BROKERS:-redpanda:9092}"
# One broker locally. Production: 3, with min.insync.replicas=2.
REPLICAS="${REPLICAS:-1}"

# Dev mode creates any topic a client asks for. Production brokers do not, so neither does this
# one: a topic missing below fails locally, not first in production. A cluster setting, so it
# is set here rather than on the command line, and it persists with the broker's data.
rpk cluster config set auto_create_topics_enabled false --api-urls "${ADMIN_API:-redpanda:9644}"

# create_topic <name> <partitions> [<config>...]
create_topic() {
  name="$1"
  partitions="$2"
  shift 2

  if rpk topic describe "$name" --brokers "$BROKERS" >/dev/null 2>&1; then
    echo "exists:  $name"
    return
  fi

  config_flags=""
  for setting in "$@"; do
    config_flags="$config_flags -c $setting"
  done

  # shellcheck disable=SC2086 # the config flags are meant to split
  rpk topic create "$name" --brokers "$BROKERS" -p "$partitions" -r "$REPLICAS" $config_flags
}

# Owned by treasury in a real environment; created here so the stack runs on its own.
# Keyed by program id, so each program's updates stay in order.
create_topic treasury.program-capacity 3 \
  retention.ms=604800000

# Messages that can never apply. Kept for 30 days: long enough for someone to investigate
# and replay them, not forever.
create_topic treasury.program-capacity.dead-letter 1 \
  retention.ms=2592000000

# This service's events, keyed by program id. Six partitions leave room for consumers to scale
# out; the count is hard to raise later without breaking per-program order.
create_topic capacity.events 6 \
  retention.ms=604800000
