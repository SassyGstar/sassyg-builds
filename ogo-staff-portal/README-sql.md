# OGO Staff Portal — handoff-first SQL map

The portal currently keeps all state in one Firebase blob at
`portals/ogo-v6-final/state`, read and written whole by `fbSave()`. These files
are the relational version of that state, built around one idea: **the tables
store facts, and the dashboard stores nothing of its own — it reads views.**

| File | What it is |
|---|---|
| `schema.sql` | Tables, constraints, triggers, and the dashboard views |
| `migrate.js` | Turns a Firebase export into a seed file |
| `schema_test.sql` | Proves the database refuses states the browser is currently trusted not to create |

## The primitive

A handoff is a directed request from one person to another that stays pending
until the recipient answers. Client handoffs, time-off requests, timecard
approvals and urgent alerts are all rows in `handoffs`, separated by `kind`.
`handoff_kinds` carries each one's wording, so a client handoff is *Accepted*
and a time-off request is *Approved* while `status` stays uniform underneath.

Adding a sixth workflow is an `INSERT` into `handoff_kinds`, not a schema
change and not a new dashboard widget.

## Seven tables

- `offices` — location
- `employees` — identity
- `clients` — work item
- `handoffs` — the primitive
- `client_assignments` — ownership, with a start and an end
- `client_activities` — timeline
- `audit_events` — evidence

Plus `timecard_entries`, which is **not** part of the map: clock punches are
payroll facts, nothing in the views reads them, and they are here only because
the portal cannot cut over without somewhere to put `S.tc`.

`clients` has no `assigned_to` column. Ownership is a fact with a lifetime, so
it lives in `client_assignments`; the open row (`ended_at is null`) is current
ownership, and `source_handoff_id` links it to the handoff that caused it. The
current build overwrites `c.assignedTo`, which makes "who owned this in March"
unanswerable.

## Four views

| View | Shows |
|---|---|
| `v_my_work(employee)` | Active assignments owned by the signed-in employee |
| `v_handoff_inbox(employee)` | Pending handoffs sent to them |
| `v_handoff_outbox(employee)` | Pending handoffs they sent, still waiting |
| `v_needs_attention` | Overdue follow-ups, IRS rejections, unassigned clients, missing next actions |

`v_needs_attention` is derived from client facts rather than stored as rows, so
it cannot drift out of step with the client record the way a materialized
to-do list would.

A broadcast (`to_employee_id is null`) only reaches people who can actually
settle it, via `handoff_kinds.responder_rule` — a time-off request addressed to
an office lands with its managers, not with everyone in the building.

## What accepting does

One transaction closes the old assignment, opens the new one, and writes the
audit row. `wfRespondHandoff` currently performs four separate writes and any
future code path can forget one; here the trigger makes ownership unable to
change without leaving evidence.

## Running it

```sh
# 1. export the blob: Firebase console -> ogo-bulletin-board-default-rtdb
#    -> portals/ogo-v6-final/state -> Export JSON -> state.json

psql "$DATABASE_URL" -f schema.sql
node migrate.js state.json > seed.sql     # data notes go to stderr
psql "$DATABASE_URL" -f seed.sql
psql "$DATABASE_URL" -f schema_test.sql   # tests 1-6 must ERROR, 7-8 must pass
```

`migrate.js` reports problems on stderr instead of dropping rows: offboarded
staff still referenced by history, duplicate pending handoffs from an offline
merge, punches that end before they start, settled records with no timestamp.
The seed is one transaction, so a constraint violation rolls the whole load
back rather than leaving a half-migrated database.

Verified end to end against PostgreSQL 16.13.

## Not migrated, on purpose

- `S.inbox` — derived from `v_handoff_inbox()`. Storing it lets the message and
  the record it describes disagree; today the portal writes both.
- `S.activity` — superseded by `audit_events`, written by trigger.
- `S.notifications` — ephemeral banners with no recipient and no state.
- Follow-ups — derived by `v_needs_attention` from `clients.follow_up_at`.

## Two things to decide before cutting over

**Names are the join key today.** `h.to === wfActor()`, `S.inbox[CU.name]`,
`c.assignedTo` are all strings, so `employees.full_name` is unique to let the
migration resolve them. New code should join on `employee_id` and treat the
name as display only — otherwise a name change silently detaches history.

**The permission checks are currently advice.** `wfCanSendHandoff` and the
`h.to !== wfActor()` guards run in the browser, so anyone with devtools is an
admin. The commented-out RLS policies at the foot of `schema.sql` move them
where they cannot be bypassed; enable them once employees are linked to auth
users.
