# Reports and exports

Two downloads from the admin **Players** tab, both available once a game has ended — or any time the
admin wants a mid-session snapshot.

## XLSX — `quiz-results-<date>.xlsx` (recommended)

One row per player. Cells are colour-coded so you can scan a printout: green for correct, red for
wrong, amber for "no answer". The file is written by a small built-in XLSX writer, so there is no
external spreadsheet dependency.

| Column | What it is |
|---|---|
| Name | Player's name as typed at join |
| Email | Player's work email |
| Score (in-race correct) | Number of questions they got right *while still in the prize race* |
| Total correct (all answers) | Includes questions answered after elimination (engagement metric) |
| Total answered | How many questions they actually responded to |
| Survived to End | Yes / No |
| Status | `WINNER / FINALIST`, `still alive`, or `eliminated` |
| Q1 answer, Q1 result | Their letter choice and the result (`correct`, `wrong`, `no answer`; with `(eliminated)` appended if they answered after being knocked out) |
| Q2 answer, Q2 result | One pair per main question |
| … | |
| B1 answer, B1 result | One pair per bonus question, only present if a tiebreaker happened |

The file opens cleanly in Excel, Google Sheets and Numbers. No macros, no formulas — just data and
cell fills. It is the right deliverable for a manager who wants to see who passed and who needs a
re-do.

The **Export & Wipe Data** maintenance action downloads its own final snapshot as
`omegaquiz-final-<date>.xlsx` before deleting anything, so you cannot wipe without getting a copy.

## CSV — `quiz-results-<date>.csv`

Same columns, no colours. Useful for:

- Importing into an LMS or training-records system
- Mail-merging certificates
- Any analytics workflow that prefers plain text

The CSV escapes leading `=`, `+`, `-` and `@` characters so a spreadsheet will not auto-evaluate
player-supplied content as a formula (CWE-1236, Excel formula injection).

## What is not in the export

The reports are **answer history**, not session metadata. They do not include:

- Question text — export `omegaquiz-questions.csv` from Admin → Questions → **Export CSV** if you
  want that as well
- Per-answer timestamps — the admin Event Log tab has them, but they are not exported
- IP addresses or user-agent strings
- Lifeline usage

If you need any of those for compliance, raise an issue. They are straightforward to add.

## Reading the reports for training compliance

For "did Alex pass the cybersecurity refresher?", look at the `Total correct (all answers)` column
against your organisation's pass mark. A reasonable starting point is >= 8/10 main plus >= 60% bonus
accuracy, but that is a suggestion, not a standard.

For "where are we weakest as a team?", sort by `Q1 result`, `Q2 result` and so on to see which
questions collected the most red cells. That tells you which topic to lean into next session.
