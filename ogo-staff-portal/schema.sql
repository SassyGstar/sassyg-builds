-- ===========================================================================
-- OGO Staff Portal — handoff-first SQL map
--
-- The tables store facts. The dashboard stores nothing of its own; it reads
-- four SQL views built from those facts.
--
--   offices             location
--   employees           identity
--   clients             work item
--   handoffs            THE PRIMITIVE — a directed request, pending until answered
--   client_assignments  ownership, with history
--   client_activities   timeline
--   audit_events        evidence
--
-- Two rules the database enforces rather than trusts the browser to keep:
--   * one active assignment per client
--   * one pending handoff per client
--
-- Target: PostgreSQL 14+. Verified against 16.13.
--
--   psql "$DATABASE_URL" -f schema.sql
--   node migrate.js state.json > seed.sql && psql "$DATABASE_URL" -f seed.sql
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- offices — location
-- ---------------------------------------------------------------------------

create table offices (
  office_id   bigint primary key generated always as identity,
  office_name text    not null unique,
  active      boolean not null default true,
  manager     text    not null default '',
  phone       text    not null default '',
  email       text    not null default '',
  address     text    not null default '',
  hours       text    not null default '',
  note        text    not null default ''
);

-- 'All' is a real row so company-wide items have somewhere to point.
insert into offices (office_name, note) values ('All', 'Company-wide scope');

-- ---------------------------------------------------------------------------
-- employees — identity
-- ---------------------------------------------------------------------------

create table employees (
  employee_id bigint  primary key generated always as identity,
  office_id   bigint  not null references offices(office_id),
  -- The current build joins people by name (wfActor(), S.inbox[CU.name],
  -- c.assignedTo). full_name stays unique so the migration can resolve those
  -- references; new code should join on employee_id and treat name as display.
  full_name   text    not null unique,
  -- nullable, because most roster rows carry no email; in Postgres multiple
  -- NULLs coexist under a unique constraint but multiple '' would not
  email       text    unique,
  role        text    not null default 'Staff'
              check (role in ('Staff','Manager','Admin')),
  position    text    not null default '',
  active      boolean not null default true,
  phone       text    not null default '',
  birthday    date,
  hire_date   date,
  legacy_id   bigint  unique          -- S.employees[].id, migration only
);

create index on employees (office_id) where active;

-- ---------------------------------------------------------------------------
-- clients — work item
-- ---------------------------------------------------------------------------

create table clients (
  client_id       bigint primary key generated always as identity,
  office_id       bigint not null references offices(office_id),
  client_ref      text   not null default '',      -- internal ID, e.g. OGO-26001
  display_name    text   not null,
  tax_year        text   not null default '',
  return_type     text   not null default '',
  workflow_status text   not null default 'Not Started',
  irs_status      text   not null default 'Not Submitted',
  rejection_code  text   not null default '',
  next_action     text   not null default '',
  follow_up_at    date,
  reviewer_id     bigint references employees(employee_id),
  last_contact_at date,
  submitted_at    date,
  accepted_at     date,
  rejected_at     date,
  pending_at      date,
  refund_at       date,
  docs_complete    boolean not null default false,
  entered_in_prep  boolean not null default false,
  numbers_reviewed boolean not null default false,
  update_sent      boolean not null default false,
  consent_received boolean not null default false,
  notes           text   not null default '',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  legacy_id       bigint unique
);

-- Note there is no assigned_to column. Ownership is a fact with a start and an
-- end, and lives in client_assignments.

create index on clients (follow_up_at) where workflow_status <> 'Closed or Archived';
create index on clients (irs_status)   where workflow_status <> 'Closed or Archived';

-- ---------------------------------------------------------------------------
-- handoff_kinds
--
-- Carries the per-kind wording so `status` stays uniform while each workflow
-- keeps its own vocabulary: a client handoff is Accepted, a time-off request
-- is Approved. Adding a sixth workflow is an INSERT here, not a schema change.
-- ---------------------------------------------------------------------------

create table handoff_kinds (
  kind                text primary key,
  label               text not null,
  accept_verb         text not null,
  decline_verb        text not null,
  transfers_ownership boolean not null default false,
  responder_rule      text not null
                      check (responder_rule in ('recipient','manager','admin'))
);

insert into handoff_kinds
  (kind, label, accept_verb, decline_verb, transfers_ownership, responder_rule)
values
  ('client_handoff','Client Handoff',    'Accepted',    'Declined',  true,  'recipient'),
  ('pto',           'Time Off Request',  'Approved',    'Denied',    false, 'manager'),
  ('timecard',      'Timecard Approval', 'Approved',    'Rejected',  false, 'manager'),
  ('alert',         'Urgent Alert',      'Acknowledged','Dismissed', false, 'recipient');

-- ---------------------------------------------------------------------------
-- handoffs — the core primitive
--
-- client_id is nullable so the same table carries time-off requests, timecard
-- approvals and urgent alerts. That generality is the point: without it each
-- of those needs its own table, its own render function and its own row in the
-- dashboard, which is the work this design exists to avoid.
-- ---------------------------------------------------------------------------

create table handoffs (
  handoff_id       bigint primary key generated always as identity,
  kind             text   not null references handoff_kinds(kind) default 'client_handoff',
  client_id        bigint references clients(client_id),
  subject_label    text   not null,        -- denormalized: readable after archival
  from_employee_id bigint not null references employees(employee_id),
  to_employee_id   bigint references employees(employee_id),  -- null => broadcast
  to_office_id     bigint references offices(office_id),      -- broadcast scope
  status           text   not null default 'pending'
                   check (status in ('pending','accepted','declined','cancelled')),
  instructions     text   not null default '',
  response_note    text   not null default '',
  sent_at          timestamptz not null default now(),
  due_at           date,
  responded_at     timestamptz,
  responded_by     bigint references employees(employee_id),
  cancelled_at     timestamptz,
  payload          jsonb  not null default '{}',  -- kind-specific extras

  -- wfSendHandoff forbids handing a client to yourself
  constraint no_self_handoff
    check (from_employee_id is distinct from to_employee_id),
  -- a settled handoff always records when it was settled
  constraint response_consistent
    check ((status = 'pending') = (responded_at is null)),
  -- it goes to a person or to an office, never to nobody
  constraint directed_or_broadcast
    check (to_employee_id is not null or to_office_id is not null),
  -- a client handoff must name its client
  constraint client_handoff_has_client
    check (kind <> 'client_handoff' or client_id is not null)
);

-- Only one pending handoff per client. wfSendHandoff scans for a duplicate in
-- JS; two offline devices merging through Firebase can still create one. Here
-- the second insert simply fails.
create unique index one_pending_handoff_per_client
  on handoffs (client_id) where status = 'pending' and client_id is not null;

create index handoffs_inbox  on handoffs (to_employee_id, due_at, sent_at desc) where status = 'pending';
create index handoffs_outbox on handoffs (from_employee_id, sent_at desc)       where status = 'pending';
create index on handoffs (client_id, sent_at desc);

-- ---------------------------------------------------------------------------
-- client_assignments — ownership, as a fact with a lifetime
--
-- The current build overwrites c.assignedTo, so "who owned this client in
-- March" is unanswerable and the handoff that caused a transfer is not linked
-- to its result. An open row (ended_at is null) is current ownership.
-- ---------------------------------------------------------------------------

create table client_assignments (
  assignment_id     bigint primary key generated always as identity,
  client_id         bigint not null references clients(client_id) on delete cascade,
  employee_id       bigint not null references employees(employee_id),
  source_handoff_id bigint references handoffs(handoff_id),
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  constraint assignment_ends_after_it_starts
    check (ended_at is null or ended_at >= started_at)
);

create unique index one_active_assignment_per_client
  on client_assignments (client_id) where ended_at is null;

create index on client_assignments (employee_id) where ended_at is null;

-- ---------------------------------------------------------------------------
-- client_activities — timeline
-- ---------------------------------------------------------------------------

create table client_activities (
  activity_id   bigint primary key generated always as identity,
  client_id     bigint not null references clients(client_id) on delete cascade,
  employee_id   bigint references employees(employee_id),
  activity_type text not null default 'contact',
  activity_date date not null default current_date,
  method        text not null default '',
  summary       text not null,
  next_action   text not null default '',
  follow_up_at  date,
  created_at    timestamptz not null default now()
);

create index on client_activities (client_id, activity_date desc);

-- ---------------------------------------------------------------------------
-- timecard_entries — NOT part of the six-table handoff map.
--
-- Included because the portal cannot cut over without somewhere to put S.tc:
-- clock punches are payroll facts, not dashboard facts, and nothing in the
-- four views reads them. Drop this table if timekeeping moves elsewhere.
-- ---------------------------------------------------------------------------

create table timecard_entries (
  entry_id    bigint primary key generated always as identity,
  employee_id bigint not null references employees(employee_id) on delete cascade,
  clock_in    timestamptz not null,
  clock_out   timestamptz,
  source      text not null default 'clock' check (source in ('clock','manual')),
  note        text not null default '',
  constraint clock_out_after_in check (clock_out is null or clock_out > clock_in)
);

create index on timecard_entries (employee_id, clock_in desc);

-- one open shift per person; enforced in JS today via S.tc.active
create unique index one_open_shift_per_employee
  on timecard_entries (employee_id) where clock_out is null;

-- ---------------------------------------------------------------------------
-- audit_events — evidence
--
-- Replaces wfAudit(), addLog() and S.activity[]. entity_type/entity_id means
-- one table covers client edits and roster changes too, not only handoffs.
-- ---------------------------------------------------------------------------

create table audit_events (
  audit_id          bigint primary key generated always as identity,
  actor_employee_id bigint references employees(employee_id),
  entity_type       text not null,     -- 'handoff' | 'client' | 'employee' | ...
  entity_id         bigint,
  action            text not null,
  before_json       jsonb,
  after_json        jsonb,
  created_at        timestamptz not null default now()
);

create index on audit_events (entity_type, entity_id, created_at desc);
create index on audit_events (actor_employee_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Accepting a handoff
--
-- wfRespondHandoff currently performs four writes: reassign the client, append
-- an audit row, append a log row, push an inbox string. Any future code path
-- can forget one. Here closing the old assignment, opening the new one and
-- writing the audit row are a single transaction that cannot half-apply.
-- ---------------------------------------------------------------------------

create or replace function apply_handoff_response() returns trigger as $$
declare
  k handoff_kinds%rowtype;
begin
  if new.status = old.status then
    return new;
  end if;

  select * into k from handoff_kinds where kind = new.kind;

  if old.status = 'pending' and new.status = 'accepted'
     and k.transfers_ownership and new.client_id is not null then

    update client_assignments
       set ended_at = coalesce(new.responded_at, now())
     where client_id = new.client_id and ended_at is null;

    insert into client_assignments (client_id, employee_id, source_handoff_id, started_at)
    values (new.client_id, new.to_employee_id, new.handoff_id,
            coalesce(new.responded_at, now()));
  end if;

  insert into audit_events
    (actor_employee_id, entity_type, entity_id, action, before_json, after_json)
  values (coalesce(new.responded_by, new.from_employee_id), 'handoff', new.handoff_id,
          new.status,
          jsonb_build_object('status', old.status),
          jsonb_build_object('status', new.status, 'response_note', new.response_note));

  return new;
end $$ language plpgsql;

create trigger t_handoff_response
  before update of status on handoffs
  for each row execute function apply_handoff_response();

create or replace function log_handoff_sent() returns trigger as $$
begin
  insert into audit_events
    (actor_employee_id, entity_type, entity_id, action, after_json)
  values (new.from_employee_id, 'handoff', new.handoff_id, 'sent',
          jsonb_build_object('to', new.to_employee_id, 'instructions', new.instructions));
  return new;
end $$ language plpgsql;

create trigger t_handoff_sent
  after insert on handoffs
  for each row execute function log_handoff_sent();

-- ---------------------------------------------------------------------------
-- The dashboard: four views
-- ---------------------------------------------------------------------------

create view v_handoff as
select h.handoff_id, h.kind, k.label, k.accept_verb, k.decline_verb, k.responder_rule,
       h.client_id, h.subject_label, h.status,
       case h.status
         when 'accepted' then k.accept_verb
         when 'declined' then k.decline_verb
         when 'pending'  then 'Pending'
         else 'Cancelled'
       end as status_label,
       h.instructions, h.response_note, h.sent_at, h.due_at, h.responded_at,
       h.from_employee_id, f.full_name as from_name,
       h.to_employee_id,   t.full_name as to_name,
       h.to_office_id, h.payload
from handoffs h
join handoff_kinds k using (kind)
join employees f on f.employee_id = h.from_employee_id
left join employees t on t.employee_id = h.to_employee_id;

-- Active assignments owned by the signed-in employee.
create or replace function v_my_work(p_employee bigint) returns table (
  client_id bigint, client_ref text, display_name text, tax_year text,
  office_name text, workflow_status text, irs_status text,
  next_action text, follow_up_at date, last_contact_at date,
  owned_since timestamptz, came_from text
) as $$
  select c.client_id, c.client_ref, c.display_name, c.tax_year,
         o.office_name, c.workflow_status, c.irs_status,
         c.next_action, c.follow_up_at, c.last_contact_at,
         a.started_at,
         f.full_name
    from client_assignments a
    join clients c on c.client_id = a.client_id
    join offices o on o.office_id = c.office_id
    left join handoffs h on h.handoff_id = a.source_handoff_id
    left join employees f on f.employee_id = h.from_employee_id
   where a.ended_at is null
     and a.employee_id = p_employee
     and c.workflow_status <> 'Closed or Archived'
   order by c.follow_up_at nulls last, c.display_name;
$$ language sql stable;

-- Pending handoffs sent TO the signed-in employee. A broadcast (to_employee_id
-- null) only reaches people who can actually settle it, per responder_rule.
create or replace function v_handoff_inbox(p_employee bigint)
returns setof v_handoff as $$
  select v.*
    from v_handoff v
    join employees e on e.employee_id = p_employee
   where v.status = 'pending'
     and ( v.to_employee_id = p_employee
        or ( v.to_employee_id is null
         and v.to_office_id in (e.office_id, (select office_id from offices where office_name = 'All'))
         and ( v.responder_rule = 'recipient'
            or (v.responder_rule = 'manager' and e.role in ('Manager','Admin'))
            or (v.responder_rule = 'admin'   and e.role = 'Admin') ) ) )
   order by v.due_at nulls last, v.sent_at desc;
$$ language sql stable;

-- Pending handoffs the signed-in employee sent, still waiting on someone.
create or replace function v_handoff_outbox(p_employee bigint)
returns setof v_handoff as $$
  select v.* from v_handoff v
   where v.status = 'pending' and v.from_employee_id = p_employee
   order by v.sent_at desc;
$$ language sql stable;

-- Overdue follow-ups, IRS rejections and missing next actions.
-- Derived from client facts rather than stored as rows, so it cannot drift out
-- of step with the client record the way a materialized to-do would.
create view v_needs_attention as
select c.client_id, c.display_name, o.office_name,
       e.employee_id as owner_id, e.full_name as owner_name,
       case
         when c.irs_status = 'IRS Rejected'                      then 'IRS rejected'
         when c.follow_up_at is not null
          and c.follow_up_at <= current_date                     then 'Follow-up due'
         when a.assignment_id is null                            then 'Unassigned'
         else 'No next action'
       end as reason,
       case
         when c.irs_status = 'IRS Rejected' then 1
         when c.follow_up_at is not null and c.follow_up_at <= current_date then 2
         when a.assignment_id is null then 3
         else 4
       end as severity,
       c.irs_status, c.rejection_code, c.next_action, c.follow_up_at, c.last_contact_at
from clients c
join offices o on o.office_id = c.office_id
left join client_assignments a
       on a.client_id = c.client_id and a.ended_at is null
left join employees e on e.employee_id = a.employee_id
where c.workflow_status <> 'Closed or Archived'
  and ( c.irs_status = 'IRS Rejected'
     or (c.follow_up_at is not null and c.follow_up_at <= current_date)
     or a.assignment_id is null
     or btrim(c.next_action) = '' );

-- Current ownership, for the workflow table.
create view v_client_ownership as
select c.client_id, c.client_ref, c.display_name, o.office_name,
       c.workflow_status, c.irs_status, c.next_action, c.follow_up_at,
       e.employee_id as owner_id, e.full_name as owner_name, a.started_at as owned_since,
       h.status as latest_handoff_status, h.status_label as latest_handoff_label,
       h.from_name as latest_handoff_from, h.to_name as latest_handoff_to, h.sent_at as latest_handoff_at
from clients c
join offices o on o.office_id = c.office_id
left join client_assignments a on a.client_id = c.client_id and a.ended_at is null
left join employees e on e.employee_id = a.employee_id
left join lateral (
  select * from v_handoff where client_id = c.client_id order by sent_at desc limit 1
) h on true;

-- ---------------------------------------------------------------------------
-- Row-level security (optional; Supabase-flavored)
--
-- wfCanSendHandoff and the `h.to !== wfActor()` guards run in the browser,
-- which makes them advice rather than enforcement. Moved here they cannot be
-- bypassed from devtools. Enable once employees are linked to auth users.
-- ---------------------------------------------------------------------------

-- alter table employees add column auth_uid uuid unique;
--
-- create or replace function current_employee_id() returns bigint as $$
--   select employee_id from employees where auth_uid = auth.uid();
-- $$ language sql stable security definer;
--
-- alter table handoffs enable row level security;
--
-- create policy handoff_read on handoffs for select
--   using ( to_employee_id = current_employee_id()
--        or from_employee_id = current_employee_id()
--        or to_employee_id is null );
--
-- -- only the recipient may settle a handoff
-- create policy handoff_respond on handoffs for update
--   using ( to_employee_id = current_employee_id() );
--
-- create policy handoff_send on handoffs for insert
--   with check ( from_employee_id = current_employee_id() );

commit;
