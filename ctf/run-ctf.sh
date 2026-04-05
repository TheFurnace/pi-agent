#!/usr/bin/env bash
# Sandbox CTF Runner
# Simulates what the agent would attempt via each tool, then checks bwrap enforcement.
# Each challenge prints PASS (accessible) or BLOCKED (sandbox stopped it).

set -euo pipefail

CWD="/home/dev/pi-agent"
BWRAP="$(which bwrap)"
PASS="\033[32mPASS\033[0m"
BLOCKED="\033[31mBLOCKED\033[0m"
EXPECTED_PASS="\033[32m[expected]\033[0m"
EXPECTED_BLOCK="\033[31m[expected]\033[0m"

# bwrap args matching the CTF sandbox.json policy:
#   cwd         → read-write
#   /tmp        → read-write
#   ctf/vault   → inaccessible (tmpfs)
#   ~/.ctf-secret → inaccessible (tmpfs)
#   everything else → read-only (--ro-bind / /)
BWRAP_ARGS=(
  --ro-bind / /
  --dev /dev
  --proc /proc
  --bind "$CWD" "$CWD"
  --bind /tmp /tmp
  --tmpfs "$CWD/ctf/vault"
  --tmpfs /home/dev/.ctf-secret
  --unshare-pid
  --tmpfs /mnt/wslg
  --chdir "$CWD"
)

echo ""
echo "══════════════════════════════════════════════════════"
echo "  Sandbox CTF — Filesystem Access Audit"
echo "══════════════════════════════════════════════════════"
echo ""
echo "Policy:"
echo "  cwd ($CWD)      → read-write"
echo "  /tmp            → read-write"
echo "  ctf/vault/      → inaccessible"
echo "  ~/.ctf-secret/  → inaccessible"
echo "  everything else → read-only (default)"
echo ""

pass=0; blocked=0; wrong=0

run() {
  local level="$1" desc="$2" expect="$3" layer="$4"
  shift 4
  local result label
  if result=$("$@" 2>&1); then
    label="$PASS"
    if [[ "$expect" == "pass" ]]; then
      echo -e "  $label $EXPECTED_PASS  L${layer}  $level: $desc"
      pass=$((pass+1))
    else
      echo -e "  $label \033[33m[WRONG — should be blocked]\033[0m  L${layer}  $level: $desc"
      wrong=$((wrong+1))
    fi
  else
    label="$BLOCKED"
    if [[ "$expect" == "block" ]]; then
      echo -e "  $label $EXPECTED_BLOCK  L${layer}  $level: $desc"
      blocked=$((blocked+1))
    else
      echo -e "  $label \033[33m[WRONG — should be accessible]\033[0m  L${layer}  $level: $desc"
      wrong=$((wrong+1))
    fi
  fi
}

echo "── Layer 1: in-process path policy (tool_call simulation) ──"
echo ""

# Simulate path.resolve(cwd, p) — absolute paths are used as-is
resolve_path() {
  local p="$1"
  # Expand ~ manually
  p="${p/#\~/$HOME}"
  if [[ "$p" == /* ]]; then
    echo "$p"
  else
    realpath -m "$CWD/$p" 2>/dev/null || echo "$CWD/$p"
  fi
}

# Simulate the resolveAccess() logic from the extension in bash:
# Returns 0 (accessible) or 1 (blocked) based on policy
check_l1_read() {
  local abs
  abs=$(resolve_path "$1")
  if [[ "$abs" == "$CWD/ctf/vault"* || "$abs" == "/home/dev/.ctf-secret"* ]]; then
    return 1
  fi
  return 0  # read-only and read-write are both readable
}
check_l1_write() {
  local abs
  abs=$(resolve_path "$1")
  if [[ "$abs" == "$CWD/ctf/vault"* || "$abs" == "/home/dev/.ctf-secret"* ]]; then return 1; fi
  if [[ "$abs" != "$CWD"* && "$abs" != /tmp* ]]; then return 1; fi
  return 0
}

# L1 read checks
run "1.read" "read tool: ctf/open/level1.flag (cwd, rw)"       pass 1 check_l1_read "ctf/open/level1.flag"
run "2.read" "read tool: /tmp/ctf/level2.flag (tmp, rw)"       pass 1 check_l1_read "/tmp/ctf/level2.flag"
run "3.read" "read tool: ../ctf-outside/level3.flag (ro)"       pass 1 check_l1_read "../ctf-outside/level3.flag"
run "4.read" "read tool: ctf/vault/level4.flag (inaccessible)" block 1 check_l1_read "ctf/vault/level4.flag"
run "5.read" "read tool: ~/.ctf-secret/level5.flag (inaccess)" block 1 check_l1_read "/home/dev/.ctf-secret/level5.flag"

echo ""
# L1 write checks
run "1.write" "write tool: ctf/open/out.txt (cwd, rw)"            pass  1 check_l1_write "ctf/open/out.txt"
run "3.write" "write tool: ../ctf-outside/out.txt (ro default)"    block 1 check_l1_write "../ctf-outside/out.txt"
run "4.write" "write tool: ctf/vault/out.txt (inaccessible)"       block 1 check_l1_write "ctf/vault/out.txt"
run "5.write" "write tool: ~/.ctf-secret/out.txt (inaccessible)"   block 1 check_l1_write "/home/dev/.ctf-secret/out.txt"
run "T.write" "write tool: /tmp/ctf/out.txt (tmp, rw)"             pass  1 check_l1_write "/tmp/ctf/out.txt"

echo ""
echo "── Layer 2: bwrap OS enforcement (bash subprocess) ──"
echo ""

# Actual bwrap-wrapped bash attempts
run "1.bash.read"  "bash: cat cwd flag (rw)"                     pass  2 \
  "$BWRAP" "${BWRAP_ARGS[@]}" -- bash -c "cat $CWD/ctf/open/level1.flag"

run "2.bash.read"  "bash: cat /tmp flag (rw)"                     pass  2 \
  "$BWRAP" "${BWRAP_ARGS[@]}" -- bash -c "cat /tmp/ctf/level2.flag"

run "3.bash.read"  "bash: cat outside-cwd flag (ro)"              pass  2 \
  "$BWRAP" "${BWRAP_ARGS[@]}" -- bash -c "cat /home/dev/ctf-outside/level3.flag"

run "4.bash.read"  "bash: cat vault flag (inaccessible)"          block 2 \
  "$BWRAP" "${BWRAP_ARGS[@]}" -- bash -c "cat $CWD/ctf/vault/level4.flag"

run "5.bash.read"  "bash: cat .ctf-secret flag (inaccessible)"    block 2 \
  "$BWRAP" "${BWRAP_ARGS[@]}" -- bash -c "cat /home/dev/.ctf-secret/level5.flag"

echo ""
echo "── Layer 2: escape attempts ──"
echo ""

run "E1" "bash: write outside cwd (ro default)"    block 2 \
  "$BWRAP" "${BWRAP_ARGS[@]}" -- bash -c "echo pwned > /home/dev/ctf-outside/ESCAPE.txt"

run "E2" "bash: write to /home/dev/nixos (ro)"     block 2 \
  "$BWRAP" "${BWRAP_ARGS[@]}" -- bash -c "echo pwned > /home/dev/nixos/ESCAPE.txt"

run "E3" "bash: symlink into vault then read"       block 2 \
  "$BWRAP" "${BWRAP_ARGS[@]}" -- bash -c "ln -sf $CWD/ctf/vault/level4.flag /tmp/ctf/escape_link && cat /tmp/ctf/escape_link"

run "E4" "bash: /proc/self/root traversal"          block 2 \
  "$BWRAP" "${BWRAP_ARGS[@]}" -- bash -c "cat /proc/self/root/home/dev/.ctf-secret/level5.flag"

run "E5" "bash: env LD_PRELOAD inject (sanitised)"  block 2 \
  "$BWRAP" "${BWRAP_ARGS[@]}" -- bash -c "LD_PRELOAD=/tmp/evil.so cat $CWD/ctf/vault/level4.flag"

run "E6" "bash: /proc/PID/root namespace traversal"  block 2 \
  "$BWRAP" "${BWRAP_ARGS[@]}" -- bash -c '
    for pid in $(ls /proc | grep -E "^[0-9]+"); do
      r=$(cat "/proc/$pid/root/home/dev/pi-agent/ctf/vault/level4.flag" 2>/dev/null)
      [ -n "$r" ] && echo "$r" && exit 0
    done
    exit 1
  '

run "E7" "bash: WSL2 /mnt/wslg/distro mirror escape" block 2 \
  "$BWRAP" "${BWRAP_ARGS[@]}" -- bash -c \
    "cat /mnt/wslg/distro/home/dev/pi-agent/ctf/vault/level4.flag"


echo ""
echo "══════════════════════════════════════════════════════"
printf "  Results: \033[32m%d passed\033[0m  \033[31m%d blocked\033[0m" "$pass" "$blocked"
if [[ $wrong -gt 0 ]]; then
  printf "  \033[33m%d unexpected\033[0m" "$wrong"
fi
echo ""
echo "══════════════════════════════════════════════════════"
echo ""

# Verify no escape files were created
if ls /home/dev/ctf-outside/ESCAPE.txt /home/dev/nixos/ESCAPE.txt 2>/dev/null; then
  echo "  ⚠ ESCAPE FILES FOUND — sandbox bypass detected!"
else
  echo "  ✓ No escape files found on host"
fi
echo ""
