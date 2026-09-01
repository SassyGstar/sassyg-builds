# Gap Report — branch `claude/handoff-dashboard-primitive-1sjac4`

Verified against a clean PostgreSQL 16.13 database on 2026-09-01. Every claim
below was checked against the code, not against `README-sql.md`.

## What actually exists

**9 tables** — `offices`, `employees`, `clients`, `handoff_kinds`, `handoffs`,
`client_assignments`, `client_activities`, `audit_events`, `timecard_entries`

**3 views** — `v_handoff`, `v_needs_attention`, `v_client_ownership`
**3 view functions** — `v_my_work(employee)`, `v_handoff_inbox(employee)`,
`v_handoff_outbox(employee)` (parameterized, so they are functions rather than
views; the four dashboard reads all exist)

**2 triggers** — `t_handoff_sent` (after insert), `t_handoff_response`
(before update of status), both on `handoffs`
**2 trigger functions** — `log_handoff_sent`, `apply_handoff_response`

**10 check constraints** — `client_handoff_has_client`, `directed_or_broadcast`,
`no_self_handoff`, `response_consistent`, `handoffs_status_check`,
`employees_role_check`, `handoff_kinds_responder_rule_check`,
`assignment_ends_after_it_starts`, `clock_out_after_in`,
`timecard_entries_source_check`

**3 partial unique indexes** — `one_pending_handoff_per_client`,
`one_active_assignment_per_client`, `one_open_shift_per_employee`
**16 foreign keys** — 13 `NO ACTION`, 3 `CASCADE`

## Correction to the previous report

The earlier statement that "all eight tests pass" described printed output, not
assertions. **Tests 1–7 asserted nothing.** Verified by dropping
`no_self_handoff` and re-running: the suite still exited 0, Test 2 printed
nothing, and the self-handoff was written to the database.

`schema_test.sql` has been rewritten to record pass/fail per case and exit
nonzero. Re-verified: healthy schema exits 0 with 11 passes; the same sabotage
now reports `FAIL … ACCEPTED the write` and exits 3.

## Gaps against the punch list

### P0 security — BLOCKED

| Item | State |
|---|---|
| Hard-coded admin passcode | Removed from branch tip; **still in history at `00278e4`** |
| Local PINs as the auth system | Still present and still the only gate |
| Real auth provider | **None exists anywhere in the repo** — blocking |
| Accounts tied to `employee_id` | Not started (auth keys on employee *name* today) |
| Server-side role enforcement | Not started; no server exists |
| Secrets in env vars / `Netlify.env.get()` | Not started; no `netlify.toml`, no functions |
| PII out of frontend seed | Done — DOBs, personal mobiles, personal mailboxes cleared |
| History review | Done; see "Exposure" below |

### P0 scope

`handoff_kinds` seeds four kinds. The MVP calls for `client_handoff` only.
The other three (`pto`, `timecard`, `alert`) must be deactivated for the first
release — the table can stay, the rows should not be usable.

### P0 data model

Present: required client on client handoffs, no self-handoff, one pending
handoff per client, one active assignment per client, ownership changes only on
accept, `timestamptz` throughout.

Missing: reject handoffs to inactive employees; verify the sender currently owns
the client; require a reason to decline; restrict cancellation to sender or
admin; make settled handoffs immutable; explicit administrative-transfer action;
archive instead of delete.

Wrong: three foreign keys are `ON DELETE CASCADE` —
`timecard_entries.employee_id`, `client_activities.client_id`,
`client_assignments.client_id`. Deleting an employee destroys their punches,
which directly contradicts "preserve historical punches when an employee is
offboarded."

### P0 acceptance transaction

The trigger performs the assignment swap and audit write atomically, verified by
T8. Missing: row locking (`SELECT … FOR UPDATE`), a recipient-identity check
(the database cannot know the authenticated actor yet), an idempotency key, and
a concurrency test for two simultaneous acceptances.

### P0 audit

`audit_events` is written by trigger and covers handoff send and response.
Missing: append-only enforcement, correlation/request ID, redacted
before/after values, client-edit and administrative-transfer auditing, and
revoking update/delete from the application role.

### P0 timecard

`timecard_entries` has 6 columns; the punch list specifies 11. Missing:
`office_id`, `status`, `created_at`, `updated_at`, `edited_by`, `edit_reason`.
Also missing: overlapping-shift prevention and an audit row per manual edit.
Present: one open punch per employee, clock-out after clock-in, zero-length and
negative punches rejected (T9–T11).

### P1 — not started

Migration hardening (`--dry-run`, `--source`, `--target`, idempotency,
quarantine, reconciliation counts), the entire Netlify Functions API, frontend
wiring, and `EXPLAIN ANALYZE` evidence.

`migrate.js` currently reports data problems on stderr but is **not idempotent**
— rerunning it duplicates rows.

### P2 — partial

11 of the ~20 required test cases exist. No API or browser tests. Documentation
covers the schema but not the ADR, permission matrix, runbook, or rollback.

## Exposure found in history

The repo is **public** (`SassyGstar/sassyg-builds`) with GitHub Pages enabled.

The pre-existing repo copy was deliberately sanitized —
`apiKey:'YOUR_FIREBASE_API_KEY'`, `ADMIN_PW='DEMO1234'`. Commit `00278e4`
(the Deploy 17 import, made during this work) replaced those placeholders with
live values and pushed them publicly:

- admin passcode `OGO2026`
- Firebase Web API key, `authDomain`, `databaseURL`, `projectId`,
  `storageBucket`, `messagingSenderId`, `appId`

Staff dates of birth, personal mobile numbers and personal Gmail addresses were
present in **both** the sanitized copy and Deploy 17, so that exposure predates
this work.

Sanitized at the branch tip; **history is unchanged pending approval.**

### Needed

1. **Change the admin passcode now** — it is public and was already readable in
   the deployed page source regardless of git.
2. **Check the Firebase Realtime Database rules.** The Web API key is not itself
   a secret, but with the database URL public, permissive rules mean anyone can
   read or write the entire portal state. This is the highest-severity item and
   was not verified here — production Firebase was not touched.
3. Decide on history: rewrite this branch's history, or accept the exposure as
   mitigated by rotation. Both need approval.
4. Consider whether staff PII in prior history warrants action independently.
