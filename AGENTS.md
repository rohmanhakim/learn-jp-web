# Working agreement

rules for sessions working on this project:
- do not make any changes unless the user asked explicitly
- do not commit the changes unless the user asked explicitly
- read docs/README.md first; this repository's docs/ is the complete product context
- respect docs/DECISIONS.md (settled direction) and docs/LEARNING-DESIGN.md §9 (anti-requirements) — challenge them only by updating the docs together with the change
- plan work against docs/TASKS.md phases; never start a later phase while an earlier phase's acceptance criteria are unmet
- never emit large batches of duplicate or overlapping edits: issue a few truly independent, non-overlapping tool calls per turn, never the same edit twice — re-sending the same `editor` call many times either no-ops or appends the same block repeatedly and corrupts the file (a P1.10 session blew a test file up to 3,320 lines with ~32 duplicated blocks this way); prefer one edit per step for new or repaired files, and after every batch re-read the touched file (`grep -c`, `wc -l`, `tail`) before editing it again, fixing any duplication immediately by truncating back to the last known-good state