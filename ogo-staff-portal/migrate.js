#!/usr/bin/env node
/**
 * OGO Staff Portal — Firebase blob -> PostgreSQL seed
 *
 * Reads the portal's synced state (Firebase RTDB path `portals/ogo-v6-final/state`)
 * and emits the INSERT statements that populate schema.sql.
 *
 *   Export:  in the Firebase console open ogo-bulletin-board-default-rtdb,
 *            select portals/ogo-v6-final/state, "Export JSON" -> state.json
 *
 *   Run:     node migrate.js state.json > seed.sql
 *            psql "$DATABASE_URL" -f schema.sql
 *            psql "$DATABASE_URL" -f seed.sql
 *
 * Everything is wrapped in one transaction: if any row violates a constraint
 * the whole load rolls back and nothing is half-migrated.
 *
 * Data problems are reported on stderr, never silently dropped.
 */

'use strict';
const fs = require('fs');

const warn = [];
const note = (m) => warn.push(m);

/* ── SQL literal helpers ─────────────────────────────────────────────── */

const q = (v) => {
  if (v === null || v === undefined || v === '') return 'null';
  return "'" + String(v).replace(/'/g, "''") + "'";
};
const qs = (v) => (v === null || v === undefined ? "''" : q(String(v)) === 'null' ? "''" : q(String(v)));
const bool = (v) => (v ? 'true' : 'false');
const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? 'null' : String(Number(v)));
const json = (o) => q(JSON.stringify(o || {})) + '::jsonb';

/** epoch ms -> timestamptz literal */
const ts = (ms) => {
  const n = Number(ms);
  if (!n || isNaN(n)) return 'null';
  return q(new Date(n).toISOString()) + '::timestamptz';
};

/** 'YYYY-MM-DD' -> date literal (the portal stores dates as plain strings) */
const date = (d) => {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(String(d).trim())) return 'null';
  return q(String(d).trim()) + '::date';
};

/** scalar subquery FKs — ids are `generated always as identity` */
const empRef = (name) =>
  !name ? 'null' : `(select employee_id from employees where full_name = ${q(name)})`;
const clientRef = (legacyId) =>
  legacyId === null || legacyId === undefined
    ? 'null'
    : `(select client_id from clients where legacy_id = ${num(legacyId)})`;
const officeRef = (name) =>
  `(select office_id from offices where office_name = ${q(name || 'All')})`;
const handoffRef = (legacyId) =>
  legacyId === null || legacyId === undefined
    ? 'null'
    : `(select handoff_id from handoffs where (payload->>'legacy_id') = ${q(String(legacyId))})`;

/* ── load ────────────────────────────────────────────────────────────── */

const path = process.argv[2];
if (!path) {
  console.error('usage: node migrate.js <state.json>  [> seed.sql]');
  process.exit(2);
}
let S;
try {
  S = JSON.parse(fs.readFileSync(path, 'utf8'));
} catch (e) {
  console.error('could not read ' + path + ': ' + e.message);
  process.exit(2);
}
// A Firebase export may wrap the state under the node name.
if (S && S.state && !S.employees) S = S.state;

const W = S.clientWorkflow || {};
const out = [];
const emit = (s) => out.push(s);

/* ── employees ───────────────────────────────────────────────────────── */

// Role assignment lives in a const map in the HTML, not in the employee record.
const ROLES = {
  'LeBrun Alexis': 'Admin',
  'Berline Jolimer': 'Admin',
  'Gina Altidor': 'Admin',
  'Vestin Paul': 'Manager',
  'Frances Torres': 'Manager',
};

const OFFICES = S.offices || {};
const officeKeys = new Set(['All', ...Object.keys(OFFICES)]);
const officeOf = (o) => (o && officeKeys.has(o) ? o : 'All');

const employees = Array.isArray(S.employees) ? S.employees : [];
const knownNames = new Set(employees.map((e) => e.name).filter(Boolean));

// Names referenced by history but no longer on the roster (offboarded staff).
// Without placeholder rows every historical handoff they touched would fail
// its foreign key and the whole migration would roll back.
const ghosts = new Set();
const seeName = (n) => {
  if (n && !knownNames.has(n)) ghosts.add(n);
  return n;
};

/* ── offices ─────────────────────────────────────────────────────────── */

emit('-- offices');
for (const [key, o] of Object.entries(OFFICES)) {
  emit(
    `insert into offices (office_name, manager, phone, email, address, hours, note) values (` +
      [q(key), qs(o.manager), qs(o.phone), qs(o.email), qs(o.address), qs(o.hours), qs(o.note)].join(', ') +
      `) on conflict (office_name) do update set manager = excluded.manager, phone = excluded.phone, ` +
      `email = excluded.email, address = excluded.address, hours = excluded.hours, note = excluded.note;`
  );
}
emit('');

/* ── employee rows ───────────────────────────────────────────────────── */

// Collect ghost names before emitting, so placeholders are inserted first.
(W.handoffs || []).forEach((h) => { seeName(h.from); seeName(h.to); seeName(h.respondedBy); seeName(h.cancelledBy); });
(W.clients || []).forEach((c) => { seeName(c.assignedTo); seeName(c.reviewer); });
(W.activities || []).forEach((a) => seeName(a.staff || a.createdBy));
(S.requests || []).forEach((r) => { seeName(r.requester); seeName(r.reviewedBy); });

emit('-- employees');
emit(
  `insert into employees (full_name, office_id, position, role, active) values (` +
    `'System', ${officeRef('All')}, 'Automated', 'Admin', false) on conflict (full_name) do nothing;`
);
for (const e of employees) {
  if (!e || !e.name) continue;
  // email is unique and nullable: many roster rows have '', and multiple NULLs
  // coexist under a unique constraint where multiple '' would collide
  emit(
    `insert into employees (full_name, office_id, position, role, active, email, phone, birthday, hire_date, legacy_id) values (` +
      [
        q(e.name),
        officeRef(officeOf(e.office)),
        qs(e.pos),
        q(ROLES[e.name] || 'Staff'),
        bool(e.status !== 'Inactive'),
        e.email ? q(e.email) : 'null',
        qs(e.phone),
        date(e.bday),
        date(e.hireDate),
        num(e.id),
      ].join(', ') +
      `) on conflict (full_name) do nothing;`
  );
}
for (const g of ghosts) {
  note(`offboarded staff referenced by history, inserted as inactive: "${g}"`);
  emit(
    `insert into employees (full_name, office_id, position, role, active) values (` +
      [q(g), officeRef('All'), q('Former staff'), q('Staff'), 'false'].join(', ') +
      `) on conflict (full_name) do nothing;`
  );
}
emit('');

/* ── clients ─────────────────────────────────────────────────────────── */

emit('-- clients');
for (const c of W.clients || []) {
  if (!c || !c.name) continue;
  emit(
    `insert into clients (client_ref, display_name, tax_year, return_type, office_id, reviewer_id, ` +
      `workflow_status, irs_status, rejection_code, last_contact_at, next_action, follow_up_at, ` +
      `submitted_at, accepted_at, rejected_at, pending_at, refund_at, ` +
      `docs_complete, entered_in_prep, numbers_reviewed, update_sent, consent_received, ` +
      `notes, created_at, updated_at, legacy_id) values (` +
      [
        qs(c.clientId),
        q(c.name),
        qs(c.taxYear),
        qs(c.returnType),
        officeRef(officeOf(c.office)),
        empRef(c.reviewer),
        qs(c.prepStatus || 'Not Started'),
        qs(c.irsStatus || 'Not Submitted'),
        qs(c.rejectionCode),
        date(c.lastContactDate),
        qs(c.nextAction),
        date(c.followUpDate),
        date(c.submittedDate),
        date(c.acceptedDate),
        date(c.rejectedDate),
        date(c.pendingDate),
        date(c.refundDate),
        bool(c.docsComplete),
        bool(c.taxSlayerEntered),
        bool(c.numbersReviewed),
        bool(c.clientUpdateSent),
        bool(c.consentReceived),
        qs(c.notes),
        ts(c.createdAt) === 'null' ? 'now()' : ts(c.createdAt),
        ts(c.updatedAt) === 'null' ? 'now()' : ts(c.updatedAt),
        num(c.id),
      ].join(', ') +
      `);`
  );
}
emit('');

/* ── client contact log ──────────────────────────────────────────────── */

emit('-- client contact activity');
for (const a of W.activities || []) {
  if (!a || !a.summary) continue;
  emit(
    `insert into client_activities (client_id, employee_id, activity_type, activity_date, method, summary, next_action, follow_up_at, created_at) values (` +
      [
        clientRef(a.clientRecordId),
        empRef(a.staff || a.createdBy),
        q('contact'),
        date(a.date) === 'null' ? 'current_date' : date(a.date),
        qs(a.method),
        q(a.summary),
        qs(a.nextAction),
        date(a.followUpDate),
        ts(a.ts) === 'null' ? 'now()' : ts(a.ts),
      ].join(', ') +
      `);`
  );
}
emit('');

/* ── timecards ───────────────────────────────────────────────────────── */

emit('-- timecard entries');
const tcEntries = (S.tc && S.tc.entries) || {};
for (const [key, list] of Object.entries(tcEntries)) {
  const legacy = Number(String(key).replace(/^emp_/, ''));
  const emp = employees.find((e) => Number(e.id) === legacy);
  if (!emp) {
    note(`timecard key "${key}" has no matching employee; ${(list || []).length} punch(es) skipped`);
    continue;
  }
  for (const t of list || []) {
    if (!t || !t.clockIn) continue;
    if (t.clockOut && Number(t.clockOut) <= Number(t.clockIn)) {
      note(`punch ${t.id} for ${emp.name} ends at or before it starts; skipped`);
      continue;
    }
    emit(
      `insert into timecard_entries (employee_id, clock_in, clock_out, source, note) values (` +
        [
          empRef(emp.name),
          ts(t.clockIn),
          ts(t.clockOut),
          q(t.manual ? 'manual' : 'clock'),
          qs(t.notes),
        ].join(', ') +
        `);`
    );
  }
}
// An in-progress shift lives in S.tc.active, not in entries.
for (const [key, startedAt] of Object.entries((S.tc && S.tc.active) || {})) {
  const legacy = Number(String(key).replace(/^emp_/, ''));
  const emp = employees.find((e) => Number(e.id) === legacy);
  if (!emp || !startedAt) continue;
  emit(
    `insert into timecard_entries (employee_id, clock_in, clock_out, source) values (` +
      [empRef(emp.name), ts(startedAt), 'null', q('clock')].join(', ') +
      `);`
  );
}
emit('');

/* ── handoffs: client handoffs ───────────────────────────────────────── */

const HANDOFF_STATE = { Pending: 'pending', Accepted: 'accepted', Declined: 'declined', Cancelled: 'cancelled' };

// The JS guards against two pending handoffs per client, but a Firebase merge
// between two offline devices can still produce them. Keep the newest and
// retire the rest so one_pending_handoff_per_client holds.
const handoffs = (W.handoffs || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
const seenPending = new Set();
const acceptedByClient = new Map();   // client legacy id -> newest accepted handoff legacy id

emit('-- client handoffs');
for (const h of handoffs) {
  if (!h || !h.from || !h.to) continue;
  let state = HANDOFF_STATE[h.status] || 'pending';

  if (h.from === h.to) {
    note(`handoff ${h.id} for "${h.clientName}" is addressed to its own sender; skipped`);
    continue;
  }
  if (state === 'pending') {
    const k = String(h.clientRecordId);
    if (seenPending.has(k)) {
      note(`duplicate pending handoff ${h.id} for "${h.clientName}" retired as cancelled (a newer one exists)`);
      state = 'cancelled';
    } else {
      seenPending.add(k);
    }
  }
  if (state === 'accepted' && !acceptedByClient.has(String(h.clientRecordId))) {
    acceptedByClient.set(String(h.clientRecordId), h.id);
  }

  // response_consistent: anything settled must carry a responded_at
  let respondedAt = h.respondedAt || (state === 'cancelled' ? h.cancelledAt : null);
  if (state !== 'pending' && !respondedAt) {
    respondedAt = h.createdAt;
    note(`handoff ${h.id} is ${state} with no response timestamp; backfilled from its sent time`);
  }
  const respondedBy = state === 'cancelled' ? h.cancelledBy || h.from : h.respondedBy || h.to;

  emit(
    `insert into handoffs (kind, client_id, subject_label, from_employee_id, to_employee_id, ` +
      `status, instructions, response_note, sent_at, responded_at, responded_by, cancelled_at, payload) values (` +
      [
        q('client_handoff'),
        clientRef(h.clientRecordId),
        qs(h.clientName),
        empRef(h.from),
        empRef(h.to),
        q(state),
        qs(h.note),
        qs(h.responseNote),
        ts(h.createdAt) === 'null' ? 'now()' : ts(h.createdAt),
        state === 'pending' ? 'null' : ts(respondedAt),
        state === 'pending' ? 'null' : empRef(respondedBy),
        state === 'cancelled' ? ts(h.cancelledAt || respondedAt) : 'null',
        json({ legacy_id: h.id }),
      ].join(', ') +
      `);`
  );
}
emit('');

/* ── client_assignments — current ownership ──────────────────────────── */

// The source data records only who owns a client right now (c.assignedTo); no
// prior-ownership history exists to reconstruct. So each owned client gets one
// open assignment, linked to the accepted handoff that most likely produced it.
// History accrues from here forward, written by the trigger on accept.
emit('-- current ownership');
for (const c of W.clients || []) {
  if (!c || !c.name) continue;
  if (!c.assignedTo) {
    if (c.prepStatus !== 'Closed or Archived') {
      note(`client "${c.name}" has no assigned staff; it will show in v_needs_attention as Unassigned`);
    }
    continue;
  }
  const src = acceptedByClient.get(String(c.id));
  emit(
    `insert into client_assignments (client_id, employee_id, source_handoff_id, started_at) values (` +
      [
        clientRef(c.id),
        empRef(c.assignedTo),
        src === undefined ? 'null' : handoffRef(src),
        ts(c.updatedAt) === 'null' ? 'now()' : ts(c.updatedAt),
      ].join(', ') +
      `);`
  );
}
emit('');

/* ── handoffs: time off ──────────────────────────────────────────────── */

// Approved/Denied is the PTO wording for the same two settled states; the
// display verbs come back out of handoff_kinds.
const PTO_STATE = { Pending: 'pending', Approved: 'accepted', Denied: 'declined', Rejected: 'declined' };

emit('-- time-off requests');
for (const r of S.requests || []) {
  if (!r || !r.requester) continue;
  const state = PTO_STATE[r.status] || 'pending';
  if (state !== 'pending' && !r.reviewedAt) {
    note(`time-off request from ${r.requester} is ${r.status} with no review date; response time set to now`);
  }
  // No single approver is recorded, so these address the office and reach
  // managers through handoff_kinds.responder_rule.
  emit(
    `insert into handoffs (kind, client_id, subject_label, from_employee_id, to_employee_id, to_office_id, ` +
      `status, instructions, response_note, due_at, sent_at, responded_at, responded_by, payload) values (` +
      [
        q('pto'),
        'null',
        qs((r.type || 'Time Off') + (r.dateFrom ? ' \u00b7 ' + r.dateFrom : '')),
        empRef(r.requester),
        'null',
        officeRef(officeOf(r.office)),
        q(state),
        qs(r.notes),
        qs(r.reviewNote),
        date(r.dateFrom),
        ts(r.createdAt) === 'null' ? 'now()' : ts(r.createdAt),
        state === 'pending' ? 'null' : 'now()',
        state === 'pending' ? 'null' : empRef(r.reviewedBy),
        json({
          type: r.type || '', dateFrom: r.dateFrom || '', dateTo: r.dateTo || '',
          ptoHours: r.ptoHours || '', ptoYear: r.ptoYear || '', reviewedAt: r.reviewedAt || '',
        }),
      ].join(', ') +
      `);`
  );
}
emit('');

/* ── handoffs: urgent alerts ─────────────────────────────────────────── */

// urgentAlerts record no author, and `dismissed` is one global flag set by an
// admin taking the notice down — not a per-person acknowledgment — so a
// dismissed alert maps to cancelled rather than accepted.
emit('-- urgent alerts');
for (const a of S.urgentAlerts || []) {
  if (!a || !a.title) continue;
  emit(
    `insert into handoffs (kind, client_id, subject_label, from_employee_id, to_employee_id, to_office_id, ` +
      `status, instructions, sent_at, responded_at, responded_by, cancelled_at) values (` +
      [
        q('alert'),
        'null',
        q(a.title),
        empRef('System'),
        'null',
        officeRef(officeOf(a.office)),
        q(a.dismissed ? 'cancelled' : 'pending'),
        qs(a.desc),
        ts(a.createdAt) === 'null' ? 'now()' : ts(a.createdAt),
        a.dismissed ? 'now()' : 'null',
        a.dismissed ? empRef('System') : 'null',
        a.dismissed ? 'now()' : 'null',
      ].join(', ') +
      `);`
  );
}
emit('');

/* ── write ───────────────────────────────────────────────────────────── */

const header = [
  '-- Generated by migrate.js from ' + path,
  '-- ' + new Date().toISOString(),
  '--',
  '-- Apply schema.sql first. One transaction: any constraint violation rolls',
  '-- the entire load back rather than leaving a half-migrated database.',
  '--',
  '-- NOT migrated, by design:',
  '--   S.inbox        derived from inbox_for(); storing it lets the message',
  '--                  and the record it describes drift apart',
  '--   S.activity     superseded by request_event, written by trigger',
  '--   S.notifications ephemeral banners with no recipient or state',
  '--   follow-ups    derived by v_needs_attention from clients.follow_up_at;',
  '--                 materializing them would let the to-do and the client',
  '--                 record drift apart',
  '',
  'begin;',
  '',
].join('\n');

process.stdout.write(header + out.join('\n') + '\n\ncommit;\n');

if (warn.length) {
  process.stderr.write('\n' + warn.length + ' data note(s):\n');
  warn.forEach((w) => process.stderr.write('  - ' + w + '\n'));
  process.stderr.write('\nReview these before loading. The seed is still valid SQL.\n');
}
