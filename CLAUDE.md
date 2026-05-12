# Guidance for Claude

This file is read by Claude at the start of every session in this repo. It captures the project shape and the durable workflow conventions so a fresh session can pick up cleanly.

## Project shape

`omegaquiz` is a self-hosted Millionaire-style live cybersecurity training quiz. Node 18+, Express 5, `ws`, vanilla HTML. One single-file backend (`server.js` ~2700 lines), three plain HTML pages in `public/`, on-disk state only for branding and question bank (`data/config.json`, `data/questions.json`). No database, no build step, no framework. One game per server.

Tests: `pnpm test` runs ~414 in-process integration checks against the live server. Keep this passing on every change.

Important architectural choices to preserve unless explicitly discussed:
- Single-file `server.js` — don't split.
- Vanilla HTML, no framework, no transpiler.
- One game per server — no multi-tenancy.
- Auth is magic-link + recovery-token + signed session cookie. No external IdP.
- Inline `<style>` is fine. Inline `<script>` is fine **only with the CSP nonce** (`nonce="__CSP_NONCE__"` placeholder, substituted server-side).
- Inline `onclick=` attributes are **forbidden** — CSP nonces don't cover them. Use `addEventListener` from a nonce-tagged `<script>` block instead.

See `CONTRIBUTING.md` for the broader "in / out of scope" list.

## Resumable session protocol

Long pieces of work in this repo (audits, multi-step refactors, ship-readiness passes) span multiple Claude sessions. The conversation can be lost; the state file must survive. **Every session honours this protocol.**

### State file: `.claude/state/session.json`

Single source of truth between sessions. Schema:

```json
{
  "schemaVersion": 1,
  "updatedAt": "ISO-8601 UTC",
  "updatedReason": "one-line why this update happened",
  "currentGoal": "what this multi-session push is trying to achieve",
  "scopeDecisions": { "<key>": "<value>" },
  "completedSteps": [ { "id": "...", "summary": "...", "outcome": "..." } ],
  "pendingTodos":   [ { "id": "...", "summary": "...", "notes": "..." } ],
  "openQuestions":  [ { "question": "...", "context": "...", "askWhenRelevant": "<todo-id>" } ],
  "keyFiles":       { "modified": [...], "created": [...], "removed": [...] },
  "lastTestStatus": { "command": "...", "result": "...", "lastRunAt": "...", "knownFlakes": "..." },
  "knownGotchas":   [ "..." ]
}
```

### When to update it

- **At the start of new multi-step work** that will plausibly span sessions: write an initial snapshot capturing `currentGoal`, `scopeDecisions`, and the planned `pendingTodos`.
- **Immediately after every completed todo:** move the entry from `pendingTodos` to `completedSteps` with a 1–3 sentence `outcome`, bump `updatedAt`, set `updatedReason`, refresh `keyFiles` / `lastTestStatus` if they changed. **Don't batch.**
- **When the user answers a scope question:** add it to `scopeDecisions` (or remove from `openQuestions`).
- **At any natural pause point** (end of turn, before a long verification, before handing back to the user).

Update by **rewriting the whole file with `Write`**, not patching it. Consistency is easier to reason about; the file is small.

### When to read it

- **At the start of every session** if it exists, even when the user didn't explicitly say "resume". A line like "I see we left off on X — continuing unless you'd rather start fresh" is the right opener.
- **When the user invokes `/resume`** (see `.claude/commands/resume.md`) — that command formalises the read-and-continue flow.

### What NOT to do

- **Never re-ask a question that's already in `scopeDecisions`.** If the user explicitly contradicts saved state, prefer the new direction and update the file.
- **Never invent state** if the file is missing or malformed — say so and stop.
- **Don't dump full conversation transcripts** into `completedSteps`. Outcomes are 1–3 sentences. The state file is for resuming, not for archaeology.
- **Don't track `.claude/state/session.json` in committed history** unless the team has agreed to. By default it's developer-local and should be gitignored. The protocol files (`.claude/commands/`, this `CLAUDE.md`) should be tracked.

### Suggested `.gitignore` additions

```
.claude/state/
```

Keep `.claude/commands/` and `CLAUDE.md` tracked so contributors inherit the protocol.

## Testing convention

- `pnpm test` must pass before declaring any change "done".
- One flaky test in `return-to-lobby` (timeout ~1 in 5 runs). Re-run on failure; if it fails twice in a row, investigate. Don't silence it.
- Tests run with `NODE_ENV=test` which auto-disables the JSON log emitter so test output stays readable.

## Logging convention

- Operational events (auth, rate-limit, shutdown, crash): `logJson(level, msg, fields)` — one JSON line per event.
- Boot banner: stays plain `console.log`. Operators read it at first boot.
- Set `LOG_DISABLE_JSON=1` to suppress JSON output (e.g. when piping into a non-JSON-aware sink).
