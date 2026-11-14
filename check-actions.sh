#!/bin/sh
# Fails if any button in app.js points at an action that doesn't exist.
cd "$(dirname "$0")"
fail=0
for a in $(grep -o 'data-a="[a-zA-Z]*"' app.js | sort -u | sed 's/data-a="//;s/"//'); do
  grep -q "^    \(async \)\?$a(" app.js || { echo "Missing action: $a"; fail=1; }
done
[ $fail = 0 ] && echo "All button actions present"
exit $fail
