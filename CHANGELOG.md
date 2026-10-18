# Changelog

The version shows next to the "TPM Project Planner" title in the app. Newest first.

## v1.6.1 — 2026-10-18
- Milestone dates now follow their tasks automatically (start = earliest task start, end = latest task end), just like status. Fixes the timeline showing a milestone at its old dates after its tasks were moved. In the Edit form the milestone's dates show "· from its tasks" and are set by the tasks; milestones without dated tasks are still set by hand.
- Data: 9 milestones whose dates no longer matched their tasks were brought in line (e.g. IT Planning now Oct 1, 2026 – Jul 30, 2027).
- Tab rows scroll sideways on phones instead of widening the page.

## v1.6.0 — 2026-10-18
- New Reports tab with the three reports project managers use most (each has Print / Save as PDF, and follows the phase / person filters):
  - Project status report: overall health (On track / Watch / At risk), progress, key dates, status by phase, what was completed recently, what's coming up, and what's overdue.
  - Timeline (Gantt): milestones as bars on a calendar grouped by phase, colored by status, with % done, overdue outlines, key-date diamonds and a Today line.
  - Workload & look-ahead: open / in-progress / overdue / upcoming tasks per person, with each person's overdue and upcoming list.

## v1.5.2 — 2026-10-18
- Edit forms: Phase lines up with Priority (shorter hint, and side-by-side boxes now align even when a label wraps).

## v1.5.1 — 2026-10-18
- Key dates strip moved below the phase cards (just above the tabs) and slimmed to a single line of chips.

## v1.5.0 — 2026-10-18
- Phases: milestones can belong to a phase (e.g. "Interior Construction"). A row of phase cards shows each phase's overall progress, task count, date span and whether anything needs attention; click a card (or use the new phase menu) to show only that phase. Summary tiles follow the selected phase.
- Key dates: tick "★ Key date" on a milestone or task to show it in a Key dates strip with a countdown (e.g. "in 201 days").
- Data: 8 build-out milestones grouped under Interior Construction; landlord key handover, certificate of occupancy and grand opening marked as key dates.

## v1.4.2 — 2026-10-18
- Fix: Word, Excel and PowerPoint attachments now open in a new tab using Microsoft's free online viewer instead of showing a blank page. PDFs, images, text, audio and video open directly in the browser; other file types (e.g. .zip, .dwg) download instead.

## v1.4.1 — 2026-10-18
- % done and status now stay in sync: entering a % above 0 on a not-started task moves it to In progress (and its milestone follows); 100% marks it Complete. Changing the status yourself still wins (e.g. reopening a finished task).
- Fix: % done accepts any whole number 0–100 (it previously only allowed multiples of 5, which blocked saving values like 33).

## v1.4.0 — 2026-10-18
- File attachments on tasks. In a milestone's task list, click "📎 Attach file" (or drag files from your computer onto a task). Files are stored privately in Supabase Storage; only team members can see them.
- Click a file name or "↗ Open" to open it in a new browser tab; ⬇ downloads it; ✕ removes it for everyone. Up to 50 MB per file.
- Cards show a 📎 count; uploads and removals appear in Recent changes. Deleting a task or milestone also deletes its files.

## v1.3.2 — 2026-10-18
- Edit forms: field hints ("set by its tasks", etc.) sit on the same line as the label, so Status lines up with Owner and Review date with Completed on.

## v1.3.1 — 2026-10-18
- Fix: the Edit/New windows no longer close by themselves when a text selection (e.g. selecting the "0" in % done) ends outside the box. Clicking outside or pressing Esc only closes the window if nothing was typed; otherwise use Save or Cancel.
- Clicking into "% done" selects the number so you can type over it.

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
