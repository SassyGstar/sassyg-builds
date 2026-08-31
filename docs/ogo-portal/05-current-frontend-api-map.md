# OGO Staff Portal — Current Frontend → Production API Action Map

**Source baseline:** `OGO_Portal_Transition_Baseline.html` (SHA-256 `39f4472ebbbd709672a9ec8d9ebac83c637db72dfeb385781b6fb1fe1bcac3af`)  
**Purpose:** eliminate generic Firebase saves by giving every mutating UI action one explicit server-owned destination.  
**Workflow authority:** [`06-client-workflow-redesign.md`](06-client-workflow-redesign.md).

## Rules

- `fbSave()` and `fbSavePunch()` disappear from the final frontend.
- Every write goes through an authenticated ASP.NET Core endpoint.
- Endpoint identity comes from the session, not an employee name supplied by JavaScript.
- Important writes use SQL transactions, audit records, and server timestamps.
- Mutable records use `ETag` / `If-Match`; create/effect POSTs use `Idempotency-Key` where retries could duplicate consequences.
- SignalR is sent **after commit** and causes other clients to refresh the affected record/read model.
- Client Workflow is modeled as **ClientWorkItems**, not a single workflow stage on a client.

## Complete mapping

| Current function | Current responsibility | Production owner | Replacement |
|---|---|---|---|
| `fbSave` | Generic Firebase state write | Retired | No generic save endpoint; each domain action writes its own record |
| `fbSavePunch` | Per-employee Firebase punch write | Retired | `POST /api/v1/timeclock/clock-in` or `/clock-out`; corrections use dedicated endpoints |
| `fbMerge` | Merge remote Firebase state into browser | Bootstrap + SignalR | `GET /api/v1/bootstrap` then record-scoped GETs + SignalR invalidation |
| `connectFB` | Attach Firebase value listener | SignalR connect | `GET /api/v1/auth/me` + `GET /api/v1/bootstrap` + `/hubs/portal` |
| `handleClock` | Clock in/out | Time Clock API | `POST /api/v1/timeclock/clock-in`; `POST /api/v1/timeclock/clock-out` |
| `autoClockOutStale` | Browser auto-close stale shift | Server job | HostedService/background worker closes stale shifts with server time |
| `runAutoClockOut` | Trigger browser stale-shift sweep | Removed | No browser endpoint; server scheduler owns it |
| `saveManualTC` | Admin manual time entry | Time Clock correction | `POST /api/v1/timeclock/entries` or `POST /entries/{id}/corrections` |
| `deletePunch` | Hard-delete punch | Forbidden in production | `POST /api/v1/timeclock/entries/{id}/corrections` (void/correct; never hard-delete) |
| `finishLogin` | Browser login completion + local session | Authentication | `POST /api/v1/auth/login`; `GET /api/v1/auth/me` |
| `logoutPortal` | Browser logout | Authentication | `POST /api/v1/auth/logout` |
| `toggleAdmin` | Client-side admin mode | Step-up authorization | `POST /api/v1/auth/step-up` when privileged re-auth is required |
| `verifyElevate` | Compare hardcoded admin password | Step-up authorization | `POST /api/v1/auth/step-up`; server verifies password/MFA |
| `dismissUrgent` | Dismiss urgent banner | Urgent alert API | `POST /api/v1/urgent-alerts/{id}/dismiss` |
| `readMsg` | Mark one inbox message read | Notification API | `POST /api/v1/notifications/{id}/read` |
| `readAllMsgs` | Mark inbox read | Notification API | `POST /api/v1/notifications/read-all` |
| `saveEvent` | Create/update event | Events API | `POST /api/v1/events`; `PUT /api/v1/events/{id}` |
| `deleteEvent` | Delete event | Events API | `DELETE /api/v1/events/{id}` (or cancel/soft-delete if attendance history exists) |
| `saveEmployee` | Create/update employee | Employees API | `POST /api/v1/employees`; `PUT /api/v1/employees/{id}` |
| `saveAnn` | Create announcement | Announcements API | `POST /api/v1/announcements` |
| `deleteAnn` | Delete announcement | Announcements API | `DELETE /api/v1/announcements/{id}` |
| `saveTodo` | Create/update action item | Tasks API | `POST /api/v1/tasks`; `PUT /api/v1/tasks/{id}` |
| `toggleTodo` | Complete/reopen action item | Tasks API | `PATCH /api/v1/tasks/{id}/status` |
| `deleteTodo` | Delete action item | Tasks API | `DELETE /api/v1/tasks/{id}` |
| `saveOffice` | Edit office | Offices API | `PUT /api/v1/offices/{id}` |
| `saveOfficeNote` | Add/edit office note | Office notes API | `POST /api/v1/offices/{id}/notes`; `PUT /notes/{noteId}` |
| `delOfficeNote` | Remove office note | Office notes API | `DELETE /api/v1/offices/{id}/notes/{noteId}` |
| `saveRequest` | Create/edit employee request | Requests API | `POST /api/v1/requests`; `PUT /api/v1/requests/{id}` |
| `deleteRequest` | Admin delete request | Requests API | Prefer `POST /api/v1/requests/{id}/cancel`; hard-delete only for invalid drafts |
| `submitApproval` | Approve/deny request | Requests API | `POST /api/v1/requests/{id}/approve` or `/deny` |
| `withdrawRequest` | Employee withdraw request | Requests API | `POST /api/v1/requests/{id}/withdraw` |
| `saveClient` | Create/edit lightweight client identity | Clients API | `POST /api/v1/clients`; `PUT /api/v1/clients/{id}` |
| `deleteClient` | Delete client | Clients API | `POST /api/v1/clients/{id}/archive`; do not hard-delete historical client records |
| `saveResource` | Save portal resource/file | Resources + Documents | `POST /api/v1/resources`; files use object-storage upload-url flow |
| `deleteResource` | Delete portal resource | Resources API | `DELETE /api/v1/resources/{id}`; object deletion is server-authorized |
| `saveUrgent` | Create urgent alert | Urgent alert API | `POST /api/v1/urgent-alerts` |
| `savePhoto` | Save base64 photo | Photos + object storage | `POST /api/v1/documents/upload-url` then `POST /api/v1/photos` metadata |
| `deletePhoto` | Delete photo | Photos API | `DELETE /api/v1/photos/{id}` |
| `wfEnsure` | Create/migrate workflow object in browser | Removed from runtime | Migration runs once server-side; `GET /api/v1/workflow/dashboard` for read model |
| `wfSaveClient` | Create/update one detailed tax workflow record | Client Work Items API | New: `POST /api/v1/work-items`; existing: `PUT /api/v1/work-items/{id}` with `If-Match` |
| `wfArchiveClient` | Archive one workflow record | Client Work Items API | `POST /api/v1/work-items/{id}/archive` |
| `wfSendHandoff` | Send ownership offer for one workflow record | Handoff API | `POST /api/v1/handoffs` with `workItemId` (`Idempotency-Key` required) |
| `wfRespondHandoff` | Accept/decline handoff | Handoff API | `POST /api/v1/handoffs/{id}/accept` or `/decline` (transactional; changes work-item owner only) |
| `wfCancelHandoff` | Cancel pending handoff | Handoff API | `POST /api/v1/handoffs/{id}/cancel` |
| `wfSaveContact` | Log completed client communication and update follow-up fields | Work Item Contact Log API | `POST /api/v1/work-items/{id}/contact-logs`; server updates `LastContactDate`, `NextAction`, `FollowUpDate`, `ClientUpdateSent` and optional communication method in one transaction |
| `setRSVP` | Save event RSVP | Events API | `PUT /api/v1/events/{id}/rsvp` |
| `saveSaturday` | Add tax-season work Saturday | Scheduling API | `POST /api/v1/work-saturdays` |
| `removeSaturday` | Remove work Saturday | Scheduling API | `DELETE /api/v1/work-saturdays/{id}` |
| `toggleEmpStatus` | Toggle active/inactive employee | Employees API | `PATCH /api/v1/employees/{id}/status` |
| `removeEmp` | Remove employee from active portal | Employees API | `POST /api/v1/employees/{id}/terminate`; preserve historical foreign keys |
| `ptoAddEntry` | Add PTO ledger entry | PTO API | `POST /api/v1/pto/{employeeId}/adjustments` |
| `ptoRemoveEntry` | Remove PTO ledger entry | PTO API | POST compensating adjustment / void; never erase approved historical entry |
| `ptoClearOverride` | Clear PTO override | PTO API | `POST /api/v1/pto/{employeeId}/adjustments` with reset reason |
| `savePTOAdjust` | Admin PTO adjustment | PTO API | `POST /api/v1/pto/{employeeId}/adjustments` |

## Read model / refresh endpoints

The current browser builds almost every screen from one in-memory `S` object. The production UI should instead request purpose-built read models:

| Screen | Suggested read endpoint |
|---|---|
| Portal startup | `GET /api/v1/bootstrap` (small: user, offices, feature flags, unread counts) |
| Dashboard | `GET /api/v1/dashboard?officeId=...` |
| Directory | `GET /api/v1/employees?status=active` |
| Time Clock | `GET /api/v1/timeclock/me`; managers: `GET /api/v1/timeclock/entries?...` |
| Client Workflow overview | `GET /api/v1/workflow/dashboard?...` |
| Workflow work-item list | `GET /api/v1/work-items?...` |
| Work-item detail | `GET /api/v1/work-items/{id}` |
| Client identity/detail | `GET /api/v1/clients/{id}` |
| All work for a client | `GET /api/v1/clients/{id}/work-items` |
| Work-item activity/history | `GET /api/v1/work-items/{id}/events`; `GET /api/v1/work-items/{id}/status-history` |
| Handoffs | `GET /api/v1/handoffs?status=pending&scope=...` |
| PTO | `GET /api/v1/pto/me`; managers: `GET /api/v1/pto?...` |
| Requests | `GET /api/v1/requests?...` |
| Events | `GET /api/v1/events?...` |
| Notifications | `GET /api/v1/notifications?unreadOnly=...` |
| Reports | `GET /api/v1/reports/...` |

## SignalR event vocabulary

SignalR messages are invalidations/notifications, not authoritative records. Recommended events:

- `client.updated`
- `workItem.created`
- `workItem.updated`
- `workItem.assignment.changed`
- `workItem.preparationStatus.changed`
- `workItem.irsStatus.changed`
- `workItem.archived`
- `handoff.created`
- `handoff.updated`
- `timeclock.updated`
- `request.updated`
- `pto.updated`
- `employee.updated`
- `event.updated`
- `notification.created`
- `urgentAlert.updated`

Payloads should carry only `publicId`, `eventType`, `serverSequence`, and minimal display metadata. The recipient then GETs the authoritative resource.

## Highest-priority conversion order

1. Authentication/session and employee identity.
2. Client Work Items + work-item-scoped handoffs (current largest multi-user collision surface).
3. Time Clock + pay-period locking.
4. PTO and requests.
5. Employees/roles/offices.
6. Notifications/events/tasks/announcements.
7. Files/photos/resources into object storage.
8. Reports and analytics read models.

This order preserves the current Netlify UI while removing the riskiest browser-owned state first.
