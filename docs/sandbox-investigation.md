# Sandbox Investigation Report

**Issue:** pi-agent-8w4.1  
**Date:** 2026-04-04

---

## Goal

Understand what existing sandboxing solutions exist for pi and other coding agents, what OS-level technologies are available on this system (NixOS WSL2, Linux 6.6, x86_64), and what the best approach is for implementing a filesystem-access sandbox for pi-agent.

---

## Existing Solutions

### 1. Official pi Sandbox Example — `@anthropic-ai/sandbox-runtime`

**Repo:** `examples/extensions/sandbox/` in the pi-coding-agent repo  
**Approach:** Pi extension that overrides the built-in `bash` tool and `user_bash` event with a sandboxed bash implementation backed by Anthropic's `@anthropic-ai/sandbox-runtime` npm package (ASRT).

**How it works:**
- Uses `createBashTool()` with custom `BashOperations` that wrap every command via `SandboxManager.wrapWithSandbox(command)`
- On Linux, ASRT shells out to `bubblewrap` (`bwrap`) to enforce filesystem and network rules
- On macOS, ASRT uses `sandbox-exec` (Apple Seatbelt)
- Config loaded from `~/.pi/agent/extensions/sandbox.json` (global) and `.pi/sandbox.json` (project), merged with project taking precedence
- Toggle: `--no-sandbox` CLI flag or `enabled: false` in config
- **Only enforces bash commands** — `read`, `write`, `edit` run in-process without OS-level enforcement

**Config schema:**
```json
{
  "enabled": true,
  "filesystem": {
    "denyRead":   ["~/.ssh", "~/.aws"],
    "allowWrite": [".", "/tmp"],
    "denyWrite":  [".env", "*.key"]
  },
  "network": {
    "allowedDomains": ["github.com"],
    "deniedDomains":  []
  }
}
```

**Limitations:**  
- `read`/`write`/`edit` tool calls are not OS-enforced; only bash is wrapped  
- Network isolation and its dependencies are heavier than we need for a pure filesystem sandbox

---

### 2. Greywall — Container-free Agent Sandbox

**Repo:** `GreyhavenHQ/greywall` (130 stars)  
**Approach:** Standalone Go CLI that wraps any process (agent, command) in a deny-by-default sandbox. Not a pi extension — it's a process wrapper.

**Linux security layers:**
- **Bubblewrap** — mount namespace isolation (`--ro-bind`, `--bind`)
- **Landlock** — kernel-level filesystem rule enforcement (no namespace needed)
- **Seccomp BPF** — syscall filtering
- **eBPF** — violation monitoring

**Strengths:** Comprehensive, production-quality, learning mode to auto-generate profiles  
**Weaknesses:** External process wrapper, not a pi extension. Heavier than needed for filesystem-only control. Requires bwrap + socat + external proxy for network.

---

### 3. pi-gondolin — Full QEMU Micro-VM

**Repo:** `pasky/pi-gondolin`  
**Approach:** Pi extension that overrides all tool operations to run inside a Gondolin QEMU micro-VM. The working directory is bind-mounted into `/workspace` inside the VM.

**Strengths:** Maximum isolation  
**Weaknesses:** ~200MB image download, QEMU dependency, performance overhead, complexity. Overkill for filesystem access control.

---

### 4. bugeshan/pi-sandbox — Pure Extension Approach

**Repo:** `bugeshan/pi-sandbox`  
**Approach:** Pi extension using `tool_call` event interception — no OS-level enforcement. Intercepts `bash`, `read`, `write`, `edit` calls and checks paths against a policy before allowing execution.

**Strengths:** No external dependencies, works everywhere, intercepts all tool types  
**Weaknesses:** Not kernel-enforced (a sufficiently creative agent could bypass via bash)

---

## OS Technologies Available on This System

### bubblewrap (`bwrap`)

**Status:** ✅ Available at `/run/wrappers/bin/bwrap`  
**Works on WSL2:** ✅ Confirmed  

Bwrap uses Linux **mount namespaces** + **user namespaces** to create an isolated filesystem view:
- `--ro-bind <src> <dst>` — bind-mount a path as read-only
- `--bind <src> <dst>` — bind-mount a path as read-write
- `--unshare-user` — use user namespace (no root required)

**Tested on this system:**
```bash
bwrap \
  --ro-bind / / \                          # whole FS read-only
  --bind /home/dev/pi-agent /home/dev/pi-agent \  # cwd read-write
  --dev /dev --proc /proc \
  sh -c "..."
# → writes inside cwd: OK
# → writes outside cwd: "Read-only file system" (BLOCKED)
```

**Limitation:** Wraps a child process. For pi's `read`/`write`/`edit` (which run in-process in Node.js), bwrap cannot be applied per-tool-call — only per bash invocation.

---

### Landlock (LSM)

**Status:** ✅ Available — ABI version 3  
**Kernel:** 6.6.87.2-microsoft-standard-WSL2 (Landlock added in 5.13, ABI v3 in 6.2)

Landlock is a Linux Security Module that lets an unprivileged process **restrict its own filesystem access** using a simple ruleset applied via syscall. Unlike namespaces, it affects the calling process and all its children without spawning a new process.

**ABI v3 capabilities:**
- `LANDLOCK_ACCESS_FS_READ_FILE`, `LANDLOCK_ACCESS_FS_READ_DIR`
- `LANDLOCK_ACCESS_FS_WRITE_FILE`, `LANDLOCK_ACCESS_FS_MAKE_*`
- `LANDLOCK_ACCESS_FS_REMOVE_*`, `LANDLOCK_ACCESS_FS_EXECUTE`

**Key property:** Can be applied at Node.js process startup to restrict ALL file access for the entire pi process — bash, read, write, edit — in one call. No child process wrapping needed.

**Limitation:** Once applied, restrictions cannot be lifted (monotonically restrictive). Per-session toggling would require process restart.

---

### Seccomp BPF

**Status:** ✅ Available (`CONFIG_SECCOMP=y`, `CONFIG_SECCOMP_FILTER=y`)  
**Relevance:** Low for filesystem-only sandboxing. Would be needed to restrict syscalls beyond `open`/`openat`. Not required for our use case.

---

## Approach Comparison

| Approach | Enforcement | All tools | No new deps | Toggle | Config |
|---|---|---|---|---|---|
| Extension only (tool_call intercept) | In-process | ✅ | ✅ | ✅ | ✅ |
| bwrap bash wrapper | OS (namespace) | bash only | ❌ bwrap | ✅ | ✅ |
| bwrap bash + tool_call intercept | OS + in-process | ✅ | ❌ bwrap | ✅ | ✅ |
| Landlock (process-level) | OS (LSM) | ✅ | ❌ native module | partial | ✅ |
| Greywall process wrapper | OS (multi-layer) | ✅ | ❌ Go binary | ✅ | ✅ |
| pi-gondolin micro-VM | VM | ✅ | ❌ QEMU | ✅ | ✅ |

---

## Recommendation

**Use a two-layer approach:**

### Layer 1 — In-process path policy (all tools)

Hook `tool_call` to intercept `bash`, `read`, `write`, and `edit` before execution. Check all path arguments against the access policy:

- `cwd` → read-write (default)
- Everything else → read-only (default)
- Config overrides per path: `inaccessible | read-only | read-write`

This handles `read`/`write`/`edit` completely and catches bash commands with explicit file arguments.

### Layer 2 — bwrap for bash OS enforcement

Wrap bash tool execution with `bubblewrap` using custom `BashOperations` (same pattern as the official pi sandbox example, without the ASRT network layer). This kernel-enforces the filesystem policy for bash subprocesses — preventing bypasses via arbitrary shell commands.

**Why not Landlock?** Landlock can't be toggled without a process restart, which conflicts with the on/off requirement. Bwrap wraps only the bash subprocess, so toggle is instant.

**Why not `@anthropic-ai/sandbox-runtime` directly?** ASRT bundles network isolation and other machinery we don't need. Direct bwrap gives us full control over the filesystem policy with no extra dependencies (bwrap is already on the system).

### Config schema (proposed)

```json
{
  "enabled": true,
  "paths": [
    { "path": ".",          "access": "read-write" },
    { "path": "~/.ssh",     "access": "inaccessible" },
    { "path": "/tmp",       "access": "read-write" },
    { "path": ".env",       "access": "inaccessible" }
  ]
}
```

Resolved at startup relative to `cwd`. The default rule (cwd = rw, everything else = ro) requires no config file.

### Toggle

- `/sandbox on|off` command (immediate, no restart)
- `--no-sandbox` CLI flag
- `enabled` key in config file

---

## Files to Create

- `extensions/sandbox.ts` — the pi extension
- `.pi/sandbox.json` — project-level config (checked into git, safe defaults)
- `docs/sandbox.md` — user documentation
