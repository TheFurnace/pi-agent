#!/usr/bin/env bash
# CTF Teardown — removes all flag and artifact files between agent CTF runs.
# Run this before each new agent session to prevent cross-session contamination.

set -euo pipefail

echo "Tearing down CTF artifacts..."

# /tmp flags and symlinks
rm -rf /tmp/ctf /tmp/ctf-agent
echo "  ✓ /tmp/ctf* removed"

# Outside-cwd flag dirs
rm -rf /home/dev/ctf-outside /home/dev/ctf-agent-ro /home/dev/.ctf-secret /home/dev/.ctf-agent-vault
echo "  ✓ ~/ctf-* dirs removed"

# Agent-ctf flag files only (ctf/open and ctf/vault are for run-ctf.sh, leave them)
find /home/dev/pi-agent/ctf/agent-ctf/flags -name "*.flag" -delete 2>/dev/null || true
echo "  ✓ agent-ctf flags cleared"

echo "Done. Plant new flags before the next run."
