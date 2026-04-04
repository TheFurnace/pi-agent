# Sandbox Implementation Plan

**Issue:** pi-agent-8w4.2  
**Date:** 2026-04-04  
**Follows:** docs/sandbox-investigation.md

---

## Architecture

Two enforcement layers, working in concert:

```
User prompt
    │
    ▼
┌─────────────────────────────────────────┐
│  Layer 1 — tool_call interception        │
│  Checks path policy before every call    │
│  Covers: read, write, edit, bash (args)  │
└────────────────┬────────────────────────┘
                 │ bash commands pass through
                 ▼
┌─────────────────────────────────────────┐
│  Layer 2 — bwrap bash wrapper           │
│  OS-level mount namespace enforcement   │
│  Blocks filesystem escapes via shell     │
└─────────────────────────────────────────┘
```

---

## Config Schema

File location (merged, project overrides global):
- Global:  `~/.pi/agent/sandbox.json`
- Project: `.pi/sandbox.json`

```json
{
  "enabled": true,
  "paths": [
    { "path": ".",        "access": "read-write"   },
    { "path": "/tmp",     "access": "read-write"   },
    { "path": "~/.ssh",   "access": "inaccessible" },
    { "path": ".env",     "access": "inaccessible" },
    { "path": "~",        "access": "read-only"    }
  ]
}
```

**Access levels:**
- `"read-write"` — full access
- `"read-only"` — reads allowed, writes blocked
- `"inaccessible"` — all access denied

**Resolution rules (in order):**
1. Paths are resolved relative to `cwd` at session start
2. Most specific match wins (longest prefix)
3. Default if no match: `read-only`
4. Implicit default rule for `cwd`: `read-write` (applied before user config, overridable)

---

## Layer 1 — In-Process Path Policy

### Hook: `tool_call`

Intercept before execution for tools: `bash`, `read`, `write`, `edit`.

**`read`** — check `event.input.path` against policy; block if `inaccessible`

**`write`** — check `event.input.path`; block if `inaccessible` or `read-only`

**`edit`** — check `event.input.path`; block if `inaccessible` or `read-only`

**`bash`** — parse `event.input.command` for explicit file path arguments using a lightweight regex scan (catches common patterns: redirects `>`, `>>`, `cat`, `cp`, `mv`, `rm`, etc.). Block command if any argument resolves to an inaccessible or (for writes) read-only path.

> Note: bash parsing is best-effort and complementary to Layer 2. It catches obvious violations early with a clear error message before the command runs.

### Path Resolution

```typescript
function resolveAccess(inputPath: string, cwd: string, policy: PathRule[]): Access {
  const abs = path.resolve(cwd, inputPath.replace(/^~/, os.homedir()));
  // Sort rules longest-first, find first match by prefix
  const sorted = [...policy].sort((a, b) => b.resolved.length - a.resolved.length);
  for (const rule of sorted) {
    if (abs.startsWith(rule.resolved)) return rule.access;
  }
  return "read-only"; // default
}
```

### Block response

Return `{ block: true, reason: "..." }` from the `tool_call` handler with a clear message:
```
[sandbox] write blocked: /home/dev/.ssh/id_rsa is inaccessible
[sandbox] read blocked: /etc/passwd is read-only (not in allowed paths)
```

---

## Layer 2 — bwrap Bash Wrapper

Override the built-in `bash` tool using `createBashTool()` with custom `BashOperations`.

### bwrap invocation

Built dynamically from the resolved policy at session start:

```bash
bwrap \
  --ro-bind / /              \   # whole FS read-only by default
  --dev /dev                 \   # keep /dev
  --proc /proc               \   # keep /proc
  --bind <cwd> <cwd>         \   # cwd read-write
  --bind /tmp /tmp           \   # /tmp read-write (if configured)
  [--bind <path> <path>]...  \   # other read-write paths
  [--tmpfs <path>]...        \   # inaccessible paths → tmpfs overlay
  -- bash -c "<command>"
```

**Inaccessible paths** are mounted as an empty `--tmpfs` rather than `--ro-bind`, so the directory appears to exist but is empty and unwritable.

### Custom BashOperations

```typescript
function createSandboxedBashOps(policy: ResolvedPolicy, cwd: string): BashOperations {
  const bwrapArgs = buildBwrapArgs(policy, cwd);
  return {
    async exec(command, cwd, options) {
      const wrapped = ["bwrap", ...bwrapArgs, "--", "bash", "-c", command];
      // spawn wrapped[], pipe stdout/stderr, respect signal/timeout
    }
  };
}
```

### Fallback

If `bwrap` is not found in PATH, log a warning and fall back to Layer 1 only (in-process policy). Never silently disable the sandbox.

---

## Toggle Mechanism

### CLI flag

```bash
pi --no-sandbox    # disable for this session
```

Implemented via `pi.registerFlag("no-sandbox", { type: "boolean", default: false })`.

### Config file

```json
{ "enabled": false }
```

### `/sandbox` command

```
/sandbox          → show current status and active policy
/sandbox on       → enable sandbox for this session
/sandbox off      → disable sandbox for this session
```

Session-scoped toggle updates an in-memory flag. Does not persist to config. Does update the bwrap BashOperations (re-registers bash tool on toggle).

### Status indicator

Footer status set via `ctx.ui.setStatus("sandbox", ...)`:
- Enabled: `🔒 sandbox: rw=2, ro=default, blocked=1`
- Disabled: `⚠ sandbox: off`

---

## Auto-setup

When the sandbox extension loads and `.pi/sandbox.json` does not exist, write a default config:

```json
{
  "enabled": true,
  "paths": []
}
```

This means "enabled with defaults only" (cwd = rw, everything else = ro). User never has to create the file manually.

---

## File Structure

```
extensions/
  sandbox.ts          ← single-file extension entry point

.pi/
  sandbox.json        ← project-level config (committed to git)

docs/
  sandbox.md          ← user documentation
  sandbox-investigation.md
  sandbox-implementation-plan.md
```

---

## Implementation Steps

### Step 1 — Skeleton + config loading
- Create `extensions/sandbox.ts`
- Implement `loadConfig(cwd)` merging global + project configs
- Implement `resolvePolicy(config, cwd)` → sorted `ResolvedPolicy[]`
- Register `--no-sandbox` flag
- Auto-write default `.pi/sandbox.json` if missing
- `session_start`: load config, log status

### Step 2 — Layer 1: tool_call interception
- Hook `tool_call` for `read`, `write`, `edit`
- Implement `resolveAccess()` path matcher
- Return `{ block: true, reason }` on violations
- Hook `tool_call` for `bash` with best-effort path scan

### Step 3 — Layer 2: bwrap bash override
- Implement `buildBwrapArgs(policy, cwd) → string[]`
- Implement `createSandboxedBashOps()` with bwrap spawn
- Override bash tool via `createBashTool(cwd, { operations })`
- Hook `user_bash` with same operations
- Detect bwrap availability; warn + fallback if missing

### Step 4 — Toggle + UI
- Implement `/sandbox [on|off]` command
- Footer status via `setStatus`
- Handle `--no-sandbox` flag in `session_start`

### Step 5 — Default config auto-write + docs
- Write `.pi/sandbox.json` on first run
- Write `docs/sandbox.md`

---

## Out of Scope (v1)

- Network sandboxing (future: integrate greywall or ASRT network layer)
- Landlock (future: optional hardening layer, requires native Node.js addon)
- Windows support
- Per-tool granularity beyond path policy (e.g. allow read but not execute)
