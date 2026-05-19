---
description: Resume work from the saved session state without re-asking decided questions.
---

Read `.claude/state/session.json` (relative to the repo root) using the Read tool. If the file is missing or malformed, say so and stop — do **not** invent state.

Once loaded, do the following in order:

1. **Summarise where we left off** in 3–6 lines:
   - `currentGoal`
   - The 2–3 most recent `completedSteps[].summary` entries
   - The next `pendingTodos[0]`
   - Any `openQuestions` whose `askWhenRelevant` matches the next pending todo's `id`

2. **Verify the snapshot is still accurate.** Spot-check 1–2 things the state claims (e.g. if `lastTestStatus.result` says "414 passed", optionally run `pnpm test` if the user signals they want to verify; if `keyFiles.created` lists `SECURITY.md`, glance with Read to confirm it still exists). Don't run an exhaustive audit — just enough to catch drift.

3. **Do NOT re-ask anything already in `scopeDecisions` or any already-answered question.** The state file is the source of truth for prior conversation. If the user explicitly contradicts saved state in their current message, prefer the user's new direction and update the state file to match.

4. **Surface, but do not block on, open questions.** If `openQuestions[].askWhenRelevant` matches the upcoming todo, mention it once in the summary so the user can answer in their next message — but proceed with the work that doesn't need that answer.

5. **Start work on `pendingTodos[0]`.** Use TodoWrite to seed your in-conversation task list from `pendingTodos`. As you complete each todo, immediately:
   - Mark it completed in TodoWrite
   - Update `.claude/state/session.json` via Write — move the entry from `pendingTodos` to `completedSteps` (with an `outcome` summary), refresh `updatedAt`, set `updatedReason` to a short phrase explaining the bump, and adjust `keyFiles` / `openQuestions` / `lastTestStatus` if relevant
   - Keep `schemaVersion: 1` unless explicitly migrating

6. **End-of-turn:** if you're stopping for the user (e.g. blocked on an open question, or hitting a natural checkpoint), make sure the state file reflects what was finished AND set `pendingTodos[0]` to whatever should happen next on resume.

Conventions:
- The state file is the single durable record between sessions. The conversation can be lost; the state file must survive.
- One JSON file per repo. Don't fork into multiple state files.
- Update the file via Write (full rewrite), not Edit — easier to reason about consistency.
- ISO 8601 UTC timestamps for `updatedAt` / `lastRunAt`.
- Keep entries short. Outcomes are 1–3 sentences. The file is for resuming, not for archaeology.
