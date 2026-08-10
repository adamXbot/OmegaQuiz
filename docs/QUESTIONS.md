# Authoring the question bank

The app boots **empty** — the first thing you do after signing in is load some questions. There are
four ways, so pick whichever fits how your content authors work.

## 1. Bundled sample packs (one click, for a first run or a demo)

Admin → **Questions** tab → **Browse sample packs**. Three packs ship in [`../samples/`](../samples):

| Pack | Main | Bonus | What it covers |
|---|---|---|---|
| Omega Quiz (`cyber-phishing`) | 10 | 5 | The default pack — look-alike domains, BEC, smishing, MFA, post-click response |
| Nature Quiz (`nature-trivia`) | 5 | 2 | Wildlife and ecosystems; a short illustrative pack |
| Pop Culture Quiz (`pop-culture`) | 5 | 2 | Movies, music and TV, for lighter team-building events |

The packs are listed from [`../samples/manifest.json`](../samples/manifest.json). Bundled packs use
the `bundled:samples/` URL scheme; a hosted manifest can use public `https://` pack URLs instead.

## 2. CSV import (recommended for most authors)

Admin → **Questions** tab → **Download template** (gives you `omegaquiz-template.csv`) → fill it in
in Excel → drag the saved file onto **Import CSV**.

The columns are:

| Column | What it is |
|---|---|
| `section` | `main` for the regular round, `bonus` for sudden-death tiebreaker questions |
| `question` | The question text. Limited HTML allowed: `<em>`, `<br>`, `<span class="mono">` |
| `optionA` … `optionD` | The four answer choices |
| `correct` | Which answer is right. Accepts either a letter (`A`–`D`) or a zero-based index (`0`–`3`). The downloadable template uses letters. |
| `lesson` | What players see at the end and on the post-game recap. Usually one or two sentences explaining why the right answer is right. |

A row looks like:

```csv
section,question,optionA,optionB,optionC,optionD,correct,lesson
main,An email from support@paypa1.com asks you to verify your account. What's the red flag?,Polite tone,Look-alike domain (paypa1 vs paypal),HTTPS link,No attachment,B,"Look-alike domains swap visually similar characters (1 for l). Always check the sender domain character-by-character."
```

The default round is 10 main questions plus 5 bonus. The bonus questions only come into play if
multiple players are tied at the end.

To export what is currently loaded, use Admin → Questions → **Export CSV**, which downloads
`omegaquiz-questions.csv` in the same format.

## 3. Type them into the admin UI

Admin → **Questions** tab → **Add a question manually**. Useful for small edits between sessions,
less useful if you have a content author writing the whole bank.

## 4. Seed from a URL on first boot (deployment time)

If you maintain a master question bank in a Git repo or on an internal share, point the server at it
once and it will seed the bank on first run only, without ever overwriting an existing one:

```bash
node server.js -u https://example.internal/quiz-content/q1-2026-pack.json
# --seed-url and --url are accepted as aliases, or use the env var:
QUESTIONS_SEED_URL=https://example.internal/quiz-content/q1-2026-pack.csv pnpm start
```

The CLI flag takes precedence over the environment variable.

JSON shape is `{ "main": [...], "bonus": [...] }` where each item is `{ q, options, correct, lesson }`.
CSV uses the same columns as the template above.

## Editing rules

Questions can only be added or edited while the lobby is open, or after a game has ended. Mid-game
edits are blocked server-side to prevent tampering. The bank is sanitised on save — anything that
looks like a script tag is escaped before it ever reaches a player's browser.
