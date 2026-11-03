#!/bin/sh
# P1-DRILLS harness item "Finding 1 numbers": run drill:edge N more times and keep
# each run's results.json under docs/cms-reviews/drills/harness/.
# Usage: DESIGN_PORT=3081 sh scripts/drills/p1/edge-repeat.sh <first-run-number> <last-run-number>
set -u
from=$1
to=$2
i=$from
while [ "$i" -le "$to" ]; do
  node scripts/drill.js harness-edge > "docs/cms-reviews/drills/harness/edge-run-$i.log" 2>&1
  cp docs/cms-reviews/drills/P1-HARNESS/results.json "docs/cms-reviews/drills/harness/edge-run-$i.json"
  i=$((i + 1))
done
