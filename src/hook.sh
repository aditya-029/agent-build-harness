#!/bin/bash
# Claude Code hook entrypoint. Deliberately a shim, and deliberately trivial.
#
# An observability hook must never be able to block a build. Claude Code treats
# hook exit code 2 as "block this tool call", and a missing interpreter or a
# missing script exits 2 all on its own -- which once wedged an entire session:
# every tool call refused, including the ones needed to repair the config.
#
# So this script fails open by construction. Every path ends in exit 0, stderr
# is swallowed, and a missing node is a no-op rather than an outage. The only
# thing that reaches Claude is well-formed JSON on stdout from a successful run.
set +e

NODE="$(command -v node 2>/dev/null)"
if [ ! -x "${NODE:-}" ]; then
  for candidate in \
    "$HOME/.nvm/versions/node/v22.22.2/bin/node" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node
  do
    [ -x "$candidate" ] && NODE="$candidate" && break
  done
fi
[ -x "${NODE:-}" ] || exit 0

HARNESS="$(cd "$(dirname "$0")" && pwd)/harness.mjs"
[ -f "$HARNESS" ] || exit 0

"$NODE" "$HARNESS" hook 2>/dev/null
exit 0
