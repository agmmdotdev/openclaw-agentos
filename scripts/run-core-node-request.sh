#!/bin/sh
# Trusted request workers: start Node once, with its guard before the entry.
set -eu
if [ "$#" -eq 0 ]; then
  echo 'Usage: run-core-node-request.sh [node options] entry.mjs [arguments]' >&2
  exit 1
fi
request_launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export MALLOC_ARENA_MAX=1 MALLOC_TRIM_THRESHOLD_=65536 MALLOC_MMAP_THRESHOLD_=65536
exec node --max-semi-space-size=8 --liftoff-only --import "$request_launcher_dir/core/request-profile-guard.mjs" "$@"
