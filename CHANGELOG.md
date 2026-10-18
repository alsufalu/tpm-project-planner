# Changelog

The version shows next to the "TPM Project Planner" title in the app. Newest first.

## v1.3.0 — 2026-10-18
- Ongoing items: tick "Ongoing" on a milestone or task for work with a start date but no end date. It shows "🔁 Ongoing since …", is never counted overdue, and gets its end date the day it's marked Complete.
- Optional review date for ongoing items; once it passes, the item is flagged and counted under Overdue.
- "Completed on" date recorded automatically when anything is marked Complete (cleared if reopened). Cards show "✓ Completed …" and how many days after the due date it finished.
- Milestone status now follows its tasks automatically (any task in progress → In progress, all done → Complete, etc.). Milestones without tasks are still set by hand.
- Data: all unfinished dates moved 9 months later because the landlord's construction actually started Oct 1, 2026 (backup of the old dates kept in the database).

## v1.2.0 — 2026-10-18
- Priority levels on milestones and tasks: Critical, High, Normal, Low. Set it in the Edit form; new tasks start with their milestone's priority. Critical/High/Low show as a tag on cards; the List view has a Priority column.
- Main Sort menu adds "priority" (most important first, or least important first).
- Task list inside each milestone has its own sort: plan order, start date, end date or priority, either direction. The ↑↓ reorder buttons work in plan order.

## v1.1.0 — 2026-10-18
- Sort menu: plan order, start date, or end date, with an Earliest-first / Latest-first toggle. Works on the Milestones board, All tasks and List views; each browser remembers its choice.
- Dates in the List view stay on one line.
- Version number shown in the header and on the sign-in screen.

## v1.0.0 — 2026-10-16
- First release: milestones board (Not started / In progress / Pending / Complete) with drag-and-drop.
- Milestone drill-down with task add / edit / reorder / delete.
- All tasks board, List view, Recent changes log.
- Summary tiles, search, filter by person, hide complete.
- Team sign-in with email + password; only listed team members can see or edit.
- Imported 29 milestones and 102 tasks from the 2025-12-28 TPM project plan spreadsheet.
