# Sandbox CTF — Audit Findings

**Issue:** pi-agent-8w4.4  
**Date:** 2026-04-04  
**Runner:** `ctf/run-ctf.sh`

---

## Setup

Six flag files were planted at locations of increasing restriction:

| Level | Path | Policy |
|-------|------|--------|
| 1 | `ctf/open/level1.flag` | cwd → read-write |
| 2 | `/tmp/ctf/level2.flag` | /tmp → read-write |
| 3 | `/home/dev/ctf-outside/level3.flag` | outside cwd → read-only (default) |
| 4 | `ctf/vault/level4.flag` | `ctf/vault` → inaccessible |
| 5 | `~/.ctf-secret/level5.flag` | `~/.ctf-secret` → inaccessible |

Five escape attempts were added to test Layer 2 hardening.

---

## Results: 20/20

### Layer 1 — In-process path policy

| Test | Expected | Result |
|------|----------|--------|
| read `ctf/open/level1.flag` (cwd, rw) | PASS | ✅ PASS |
| read `/tmp/ctf/level2.flag` (tmp, rw) | PASS | ✅ PASS |
| read `../ctf-outside/level3.flag` (ro) | PASS | ✅ PASS |
| read `ctf/vault/level4.flag` (inaccessible) | BLOCKED | ✅ BLOCKED |
| read `~/.ctf-secret/level5.flag` (inaccessible) | BLOCKED | ✅ BLOCKED |
| write `ctf/open/out.txt` (cwd, rw) | PASS | ✅ PASS |
| write `../ctf-outside/out.txt` (ro default) | BLOCKED | ✅ BLOCKED |
| write `ctf/vault/out.txt` (inaccessible) | BLOCKED | ✅ BLOCKED |
| write `~/.ctf-secret/out.txt` (inaccessible) | BLOCKED | ✅ BLOCKED |
| write `/tmp/ctf/out.txt` (tmp, rw) | PASS | ✅ PASS |

### Layer 2 — bwrap OS enforcement

| Test | Expected | Result |
|------|----------|--------|
| `cat ctf/open/level1.flag` (cwd, rw) | PASS | ✅ PASS |
| `cat /tmp/ctf/level2.flag` (tmp, rw) | PASS | ✅ PASS |
| `cat /home/dev/ctf-outside/level3.flag` (ro) | PASS | ✅ PASS |
| `cat ctf/vault/level4.flag` (inaccessible) | BLOCKED | ✅ BLOCKED |
| `cat ~/.ctf-secret/level5.flag` (inaccessible) | BLOCKED | ✅ BLOCKED |

### Escape Attempts

| Attempt | Technique | Result |
|---------|-----------|--------|
| E1 | `echo > /home/dev/ctf-outside/ESCAPE.txt` (write to ro path) | ✅ BLOCKED |
| E2 | `echo > /home/dev/nixos/ESCAPE.txt` (write to ro system path) | ✅ BLOCKED |
| E3 | Symlink from `/tmp` into vault, then read via link | ✅ BLOCKED |
| E4 | `/proc/self/root` namespace traversal to reach inaccessible path | ✅ BLOCKED |
| E5 | `LD_PRELOAD` library injection via environment variable | ✅ BLOCKED |

**No escape files were created on the host.**

---

## Issues Found During Audit

**One bug discovered and fixed during the CTF setup:**

The CTF runner's path resolver initially used `realpath -m "$CWD/$path"` for all inputs, incorrectly prepending `$CWD` to absolute paths (e.g. `/home/dev/.ctf-secret`). This made it look like inaccessible absolute-path rules were being bypassed in Layer 1.

**Root cause:** Shell string concatenation doesn't replicate `path.resolve()` semantics, which discards the base when the second argument is absolute.

**Impact on extension:** The TypeScript extension uses `path.resolve(cwd, p)` which handles this correctly — not a bug in the sandbox itself, only in the test harness.

**Fix:** Added a `resolve_path()` helper to the CTF runner that replicates `path.resolve()` semantics.

---

## Verdict

The sandbox holds under all tested conditions:

- ✅ Accessible paths (cwd, /tmp) are reachable by both tools and bash
- ✅ Read-only paths outside cwd are readable but not writable
- ✅ Inaccessible paths block all access via tool_call (Layer 1) and bwrap (Layer 2)
- ✅ All escape techniques tested were blocked by bwrap mount namespace enforcement
- ✅ No files were written outside the permitted zones

---

## Recommendations for Future Hardening

1. **`--unshare-net` for bash** — network isolation not currently enforced; a future iteration could add network sandboxing via bwrap + greywall
2. **`find`/`ls` tool interception** — directory listing of inaccessible paths currently returns an empty listing (bwrap tmpfs) rather than a clear "permission denied" — may expose that a directory exists
3. **Audit log** — structured logging of blocked attempts (path, tool, timestamp) would support incident review
4. **Landlock as hardening layer** — ABI v3 available on this kernel; could complement bwrap for defence-in-depth on process-level restrictions
