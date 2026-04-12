# Idea: Git Commit Message Extension

A pi extension that generates commit messages using a cheap model (e.g. Claude Haiku)
via a single lightweight SDK call — no agent loop, no subagent overhead.

## How it works

1. Register a `/commit` command (or hook a `tool_call` event watching for `git add`)
2. Grab the staged diff via `git diff --cached`
3. Make a **single SDK call** to Haiku with the diff as context
4. Display the generated message for confirmation
5. Run `git commit -m "..."` with the accepted message

## Why not a subagent?

Commit message generation is perfectly scoped: diff in, message out.
A full agent session (with its own tool loop) would be pure overhead.
A single `session.prompt()` call to a cheap/fast model is all that's needed.

## Implementation notes

- Scope: project-local extension at `.pi/extensions/`
- Trigger: `/commit` command or auto-triggered post `git add`
- Model: Haiku (fast, cheap, ~200 tokens of diff = fractions of a cent)
- No tool loop — one prompt, one response, done
