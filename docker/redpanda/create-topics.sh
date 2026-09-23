#!/bin/sh
# Creates the service's Kafka topics on the local broker, with explicit partitions and
# retention, and turns off topic auto-creation, as a production cluster would be set up. Safe to
# run again: topics that already exist are left alone.
set -eu

BROKERS="${BROKERS:-redpanda:9092}"
REPLICAS="${REPLICAS:-1}"

rpk cluster config set auto_create_topics_enabled false --api-urls "${ADMIN_API:-redpanda:9644}"

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

create_topic treasury.program-capacity 3 \
  retention.ms=604800000

create_topic treasury.program-capacity.dead-letter 1 \
  retention.ms=2592000000

create_topic capacity.events 6 \
  retention.ms=604800000
