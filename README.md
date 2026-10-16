# TPM Project Planner

A shared, online version of the TPM restaurant build-out project plan.

- **Milestones board** – every major milestone sorted into *Not started*, *In progress*, *Pending* (waiting on someone/something) and *Complete*. Drag a card to change its status.
- **Drill down** – click any milestone to see its owner, dates, progress, notes and all of its tasks. Add, edit, reorder, complete or delete tasks right there.
- **All tasks** – the same four columns, but for every individual task across the project.
- **List** – a spreadsheet-style view of milestones with their tasks underneath.
- **Recent changes** – who changed what, and when.
- Summary tiles at the top (click one to filter), search, a filter by person, and "Hide complete".
- Changes show up for everyone automatically, with no refresh needed.

## How sign-in works

Only people on the **Team** list can see or edit the plan.

1. A current member opens **👥 Team** and adds the new person's email.
2. The new person opens the planner, chooses **Create account**, and uses that same email and a password.
3. They confirm their email from the message Supabase sends, then sign in.

## Tech

- Static site (`index.html`, `styles.css`, `app.js`, `config.js`), hosted on GitHub Pages with no build step.
- Data lives in Supabase (`pm_*` tables). `supabase/schema.sql` documents the tables and security rules.
- Row-level security: only signed-in users whose email is in `pm_members` can read or write anything. The key in `config.js` is the public "publishable" key, which is meant to live in browser code.
