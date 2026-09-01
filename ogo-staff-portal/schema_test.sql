-- ===========================================================================
-- schema_test.sql — self-verifying constraint tests
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f schema_test.sql
--
-- Exits NONZERO if any test fails. The previous version of this file printed
-- expected errors for a human to read, which meant a deleted constraint passed
-- silently: dropping no_self_handoff still produced exit code 0. Every case
-- here records a pass/fail row and the run aborts at the end if any failed.
--
-- No test leaves rows behind: each write is undone by a deliberate rollback
-- inside its own subtransaction.
-- ===========================================================================

\set ON_ERROR_STOP on

create temp table if not exists t_results (
  name text, expectation text, outcome text, passed boolean
) on commit preserve rows;
truncate t_results;

-- Runs p_sql expecting it to be REJECTED by p_constraint.
create or replace function t_expect_violation(p_name text, p_sql text, p_constraint text)
returns void as $$
begin
  begin
    execute p_sql;
    -- the write was accepted; undo it and record the failure
    raise exception 'T_HARNESS_UNDO';
  exception when others then
    if sqlerrm = 'T_HARNESS_UNDO' then
      insert into t_results values (p_name, 'rejected by '||p_constraint,
                                    'ACCEPTED the write', false);
    elsif position(p_constraint in sqlerrm) > 0 then
      insert into t_results values (p_name, 'rejected by '||p_constraint,
                                    'rejected', true);
    else
      insert into t_results values (p_name, 'rejected by '||p_constraint,
                                    'wrong error: '||left(sqlerrm,60), false);
    end if;
  end;
end $$ language plpgsql;

-- Runs p_sql expecting it to SUCCEED. The write is rolled back either way.
create or replace function t_expect_success(p_name text, p_sql text)
returns void as $$
begin
  begin
    execute p_sql;
    raise exception 'T_HARNESS_UNDO';
  exception when others then
    if sqlerrm = 'T_HARNESS_UNDO' then
      insert into t_results values (p_name, 'accepted', 'accepted', true);
    else
      insert into t_results values (p_name, 'accepted',
                                    'REJECTED: '||left(sqlerrm,60), false);
    end if;
  end;
end $$ language plpgsql;

-- ---------------------------------------------------------------------------

select t_expect_violation('T1 second pending handoff for one client', $sql$
  insert into handoffs (kind, client_id, subject_label, from_employee_id, to_employee_id, status)
  select 'client_handoff', h.client_id, 'duplicate',
         (select employee_id from employees where full_name='Frances Torres'),
         (select employee_id from employees where full_name='Gina Altidor'), 'pending'
  from handoffs h where h.status='pending' and h.client_id is not null limit 1
$sql$, 'one_pending_handoff_per_client');

select t_expect_violation('T2 handing a client to yourself', $sql$
  insert into handoffs (kind, client_id, subject_label, from_employee_id, to_employee_id, status)
  select 'client_handoff', c.client_id, c.display_name,
         (select employee_id from employees where full_name='Gina Altidor'),
         (select employee_id from employees where full_name='Gina Altidor'), 'pending'
  from clients c limit 1
$sql$, 'no_self_handoff');

select t_expect_violation('T3 settling without a response timestamp', $sql$
  update handoffs set status='accepted'
  where handoff_id=(select handoff_id from handoffs where status='pending' limit 1)
$sql$, 'response_consistent');

select t_expect_violation('T4 second active assignment for one client', $sql$
  insert into client_assignments (client_id, employee_id)
  select a.client_id, (select employee_id from employees where full_name='Gina Altidor')
  from client_assignments a where a.ended_at is null limit 1
$sql$, 'one_active_assignment_per_client');

select t_expect_violation('T5 client handoff naming no client', $sql$
  insert into handoffs (kind, client_id, subject_label, from_employee_id, to_employee_id, status)
  values ('client_handoff', null, 'nothing',
          (select employee_id from employees where full_name='Gina Altidor'),
          (select employee_id from employees where full_name='Vestin Paul'), 'pending')
$sql$, 'client_handoff_has_client');

select t_expect_violation('T6 handoff addressed to nobody', $sql$
  insert into handoffs (kind, subject_label, from_employee_id, status)
  values ('alert','orphan',(select employee_id from employees where full_name='Gina Altidor'),'pending')
$sql$, 'directed_or_broadcast');

select t_expect_violation('T9 zero-length time punch', $sql$
  insert into timecard_entries (employee_id, clock_in, clock_out)
  values ((select employee_id from employees where full_name='Gina Altidor'),
          '2026-08-28T09:00:00Z','2026-08-28T09:00:00Z')
$sql$, 'clock_out_after_in');

select t_expect_violation('T10 negative time punch', $sql$
  insert into timecard_entries (employee_id, clock_in, clock_out)
  values ((select employee_id from employees where full_name='Gina Altidor'),
          '2026-08-28T17:00:00Z','2026-08-28T09:00:00Z')
$sql$, 'clock_out_after_in');

select t_expect_violation('T11 second open shift for one employee', $sql$
  insert into timecard_entries (employee_id, clock_in, clock_out)
  select employee_id, now(), null from timecard_entries
  where clock_out is null limit 1
$sql$, 'one_open_shift_per_employee');

select t_expect_success('T7 legitimate handoff to another person', $sql$
  insert into handoffs (kind, client_id, subject_label, from_employee_id, to_employee_id, status)
  select 'client_handoff', c.client_id, c.display_name,
         (select employee_id from employees where full_name='Gina Altidor'),
         (select employee_id from employees where full_name='Frances Torres'), 'pending'
  from clients c
  where c.workflow_status <> 'Closed or Archived'
    and not exists (select 1 from handoffs h where h.client_id=c.client_id and h.status='pending')
  limit 1
$sql$);

-- T8: acceptance must move ownership AND write audit evidence, together.
-- Results are recorded in the exception handler, not before the undo: an insert
-- made inside the subtransaction would be rolled back along with the test writes.
do $$
declare
  v_h bigint; v_client bigint; v_owner bigint;
  v_closed int := -1; v_open int := -1; v_audit int := -1; v_new_owner bigint;
  v_err text := null;
begin
  begin
    select handoff_id, client_id, to_employee_id into v_h, v_client, v_owner
      from handoffs where status='pending' and kind='client_handoff' limit 1;

    update handoffs set status='accepted', responded_at=now(),
           responded_by=to_employee_id, response_note='harness'
     where handoff_id=v_h;

    select count(*) filter (where ended_at is not null),
           count(*) filter (where ended_at is null)
      into v_closed, v_open
      from client_assignments where client_id=v_client;

    select count(*) into v_audit from audit_events
     where entity_type='handoff' and entity_id=v_h and action='accepted';

    select employee_id into v_new_owner from client_assignments
     where client_id=v_client and ended_at is null;

    raise exception 'T_HARNESS_UNDO';
  exception when others then
    if sqlerrm <> 'T_HARNESS_UNDO' then v_err := sqlerrm; end if;
  end;

  if v_err is not null then
    insert into t_results values ('T8 acceptance moves ownership and writes audit',
      'succeeds', 'ERROR: '||left(v_err,60), false);
  else
    insert into t_results values (
      'T8 acceptance moves ownership and writes audit',
      'prior assignment closed, exactly one open, one audit row, owner = recipient',
      format('closed=%s open=%s audit=%s owner_is_recipient=%s',
             v_closed, v_open, v_audit, v_new_owner is not distinct from v_owner),
      v_closed >= 1 and v_open = 1 and v_audit = 1
        and v_new_owner is not distinct from v_owner);
  end if;
end $$;

-- ---------------------------------------------------------------------------

\echo ''
select case when passed then 'PASS' else 'FAIL' end as result, name, expectation, outcome
from t_results order by name;

\echo ''
do $$
declare n int;
begin
  select count(*) into n from t_results where not passed;
  if n > 0 then
    raise exception '% of % test(s) FAILED', n, (select count(*) from t_results);
  end if;
  raise notice 'all % tests passed', (select count(*) from t_results);
end $$;
