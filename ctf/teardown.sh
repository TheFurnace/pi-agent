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

# Agent-ctf flag files (keep directory structure and config)
find /home/dev/pi-agent/ctf/agent-ctf/flags -name "*.flag" -delete 2>/dev/null || true
echo "  ✓ agent-ctf flags cleared"

# Previous CTF flags (ctf/open, ctf/vault)
find /home/dev/pi-agent/ctf/open /home/dev/pi-agent/ctf/vault -name "*.flag" -delete 2>/dev/null || true
echo "  ✓ ctf/open and ctf/vault flags cleared"

echo "Done. Plant new flags before the next run."
