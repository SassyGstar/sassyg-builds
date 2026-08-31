# OGO Staff Portal — Client Workflow Redesign (Authoritative Phase 5 Model)

**Status:** Approved design for implementation planning  
**Source behavior:** Transition baseline SHA-256 `39f4472ebbbd709672a9ec8d9ebac83c637db72dfeb385781b6fb1fe1bcac3af`  
**Supersedes:** the single-stage `crm.ClientWorkflowStatus` design in `01-database-blueprint.md` §5.1, any handoff design that transfers a whole `ClientId`, and API mappings that treat a workflow record as `/clients/{id}/workflow`.

---

## 1. The problem we are correcting

The production portal does **not** track one linear workflow stage. Each workflow row stores a tax work item with multiple independent dimensions at the same time:

- tax year;
- return type;
- office;
- assigned employee;
- reviewer;
- preparation status;
- IRS status;
- documents-complete milestone;
- TaxSlayer-entered milestone;
- numbers-reviewed milestone;
- client-update-sent milestone;
- authorization/consent milestone;
- communication method;
- submitted date;
- accepted date;
- rejected date;
- rejection code;
- pending date;
- refund date;
- last-contact date;
- next action;
- follow-up date;
- notes;
- created/updated metadata.

Those facts are not mutually exclusive. A return can be under review while documents are complete; it can be submitted while a follow-up is scheduled; IRS processing can be pending while the internal preparation track is already complete.

Therefore **there is no single `WorkflowStageId` that can be the source of truth.**

---

## 2. The object model we are locking

```text
Client
  └── ClientWorkItem  ← one actual tax matter / unit of work
        ├── PreparationStatus
        ├── IrsStatus
        ├── milestones + dates
        ├── WorkItemAssignments
        │     ├── Owner
        │     └── Reviewer
        ├── WorkItemContacts / contact log
        ├── WorkItemPrepStatusHistory
        ├── WorkItemIrsStatusHistory
        ├── WorkItemEvents
        └── ClientHandoffs  ← transfers this work item, not the whole client
```

Examples:

```text
Client: Johnson Household
  Work item A: 2025 Individual Return
  Work item B: 2024 Amended Return
  Work item C: 2026 Extension
```

Each can have a different owner, reviewer, status, follow-up date, and handoff history.

---

## 3. Lookup tables

The two status tracks remain separate because they answer different questions.

```sql
CREATE TABLE crm.ReturnTypes (
    ReturnTypeId int IDENTITY(1,1) NOT NULL,
    Code         nvarchar(40) NOT NULL,
    Name         nvarchar(80) NOT NULL,
    SortOrder    int NOT NULL,
    IsActive     bit NOT NULL CONSTRAINT DF_ReturnTypes_Active DEFAULT 1,
    CONSTRAINT PK_ReturnTypes PRIMARY KEY CLUSTERED (ReturnTypeId),
    CONSTRAINT UX_ReturnTypes_Code UNIQUE (Code)
);

CREATE TABLE crm.PreparationStatuses (
    PreparationStatusId int IDENTITY(1,1) NOT NULL,
    Code         nvarchar(60) NOT NULL,
    Name         nvarchar(100) NOT NULL,
    SortOrder    int NOT NULL,
    IsTerminal   bit NOT NULL CONSTRAINT DF_PrepStatus_Terminal DEFAULT 0,
    IsActive     bit NOT NULL CONSTRAINT DF_PrepStatus_Active DEFAULT 1,
    CONSTRAINT PK_PreparationStatuses PRIMARY KEY CLUSTERED (PreparationStatusId),
    CONSTRAINT UX_PreparationStatuses_Code UNIQUE (Code)
);

CREATE TABLE crm.IrsStatuses (
    IrsStatusId int IDENTITY(1,1) NOT NULL,
    Code        nvarchar(60) NOT NULL,
    Name        nvarchar(100) NOT NULL,
    SortOrder   int NOT NULL,
    IsTerminal  bit NOT NULL CONSTRAINT DF_IrsStatus_Terminal DEFAULT 0,
    IsActive    bit NOT NULL CONSTRAINT DF_IrsStatus_Active DEFAULT 1,
    CONSTRAINT PK_IrsStatuses PRIMARY KEY CLUSTERED (IrsStatusId),
    CONSTRAINT UX_IrsStatuses_Code UNIQUE (Code)
);

CREATE TABLE crm.CommunicationMethods (
    CommunicationMethodId int IDENTITY(1,1) NOT NULL,
    Code      nvarchar(40) NOT NULL,
    Name      nvarchar(80) NOT NULL,
    SortOrder int NOT NULL,
    IsActive  bit NOT NULL CONSTRAINT DF_CommMethod_Active DEFAULT 1,
    CONSTRAINT PK_CommunicationMethods PRIMARY KEY CLUSTERED (CommunicationMethodId),
    CONSTRAINT UX_CommunicationMethods_Code UNIQUE (Code)
);
```

Seed values preserve the current portal exactly.

### Return types

`Individual`, `Business`, `Amended Return`, `Prior-Year Return`, `ITIN Return`, `Extension`.

### Preparation statuses

`New Client / Not Started`, `Intake in Progress`, `Missing Information`, `All Information Received`, `Entered into TaxSlayer`, `Under Preparer Review`, `Numbers Reviewed and Approved`, `Client Update Sent`, `Waiting for Client Authorization`, `Client Authorization Received`, `Ready to E-File`, `E-Filed`, `Paper Return Required`, `Return Completed - Balance Due`, `Closed or Archived`.

### IRS statuses

`Not Submitted`, `Submitted to IRS`, `IRS Accepted`, `IRS Rejected`, `Correction in Progress`, `Resubmitted to IRS`, `Pending IRS Processing`, `Additional IRS Action Required`, `Refund Approved`, `Refund Issued`, `Refund Held or Delayed`, `Refund Applied to Debt`, `Balance Due - No Refund`, `Paper Return Mailed`, `Return Closed`.

### Communication methods

`In Person`, `Telephone`, `Email`, `Text Message`, `TaxDome`, `Virtual Appointment`.

---

## 4. `crm.ClientWorkItems` — the new source of truth

One row represents one current tax work item. It is temporal so SQL retains the complete before/after row automatically.

```sql
CREATE TABLE crm.ClientWorkItems (
    ClientWorkItemId       int IDENTITY(1,1) NOT NULL,
    PublicId               uniqueidentifier NOT NULL CONSTRAINT DF_WorkItem_PublicId DEFAULT NEWID(),
    ClientId               int NOT NULL,
    OfficeId               int NOT NULL,
    TaxYear                smallint NOT NULL,
    ReturnTypeId           int NOT NULL,
    SequenceNo             smallint NOT NULL CONSTRAINT DF_WorkItem_Sequence DEFAULT 1,

    PreparationStatusId    int NOT NULL,
    IrsStatusId            int NOT NULL,
    CommunicationMethodId  int NULL,

    DocsComplete           bit NOT NULL CONSTRAINT DF_WorkItem_Docs DEFAULT 0,
    TaxSlayerEntered       bit NOT NULL CONSTRAINT DF_WorkItem_TaxSlayer DEFAULT 0,
    NumbersReviewed        bit NOT NULL CONSTRAINT DF_WorkItem_Reviewed DEFAULT 0,
    ClientUpdateSent       bit NOT NULL CONSTRAINT DF_WorkItem_UpdateSent DEFAULT 0,
    ConsentReceived        bit NOT NULL CONSTRAINT DF_WorkItem_Consent DEFAULT 0,

    SubmittedDate          date NULL,
    AcceptedDate           date NULL,
    RejectedDate           date NULL,
    RejectionCode          nvarchar(80) NULL,
    PendingDate            date NULL,
    RefundDate             date NULL,
    LastContactDate        date NULL,
    FollowUpDate           date NULL,

    NextAction             nvarchar(1000) NULL,
    Notes                  nvarchar(max) NULL,

    IsArchived             bit NOT NULL CONSTRAINT DF_WorkItem_Archived DEFAULT 0,
    ArchivedAtUtc          datetime2(3) NULL,
    ArchivedByEmployeeId   int NULL,

    LegacyWorkflowId       bigint NULL,  -- transition-baseline clientWorkflow.clients[].id
    CreatedAtUtc           datetime2(3) NOT NULL CONSTRAINT DF_WorkItem_Created DEFAULT SYSUTCDATETIME(),
    CreatedByEmployeeId    int NULL,
    UpdatedAtUtc           datetime2(3) NOT NULL CONSTRAINT DF_WorkItem_Updated DEFAULT SYSUTCDATETIME(),
    UpdatedByEmployeeId    int NULL,
    RowVersion             rowversion NOT NULL,

    ValidFrom              datetime2(3) GENERATED ALWAYS AS ROW START HIDDEN NOT NULL,
    ValidTo                datetime2(3) GENERATED ALWAYS AS ROW END HIDDEN NOT NULL,
    PERIOD FOR SYSTEM_TIME (ValidFrom, ValidTo),

    CONSTRAINT PK_ClientWorkItems PRIMARY KEY CLUSTERED (ClientWorkItemId),
    CONSTRAINT UX_ClientWorkItems_PublicId UNIQUE (PublicId),
    CONSTRAINT UX_ClientWorkItems_Identity UNIQUE (ClientId, TaxYear, ReturnTypeId, SequenceNo),
    CONSTRAINT UX_ClientWorkItems_Legacy UNIQUE (LegacyWorkflowId),

    CONSTRAINT FK_WorkItem_Client FOREIGN KEY (ClientId) REFERENCES crm.Clients(ClientId),
    CONSTRAINT FK_WorkItem_Office FOREIGN KEY (OfficeId) REFERENCES org.Offices(OfficeId),
    CONSTRAINT FK_WorkItem_ReturnType FOREIGN KEY (ReturnTypeId) REFERENCES crm.ReturnTypes(ReturnTypeId),
    CONSTRAINT FK_WorkItem_PrepStatus FOREIGN KEY (PreparationStatusId) REFERENCES crm.PreparationStatuses(PreparationStatusId),
    CONSTRAINT FK_WorkItem_IrsStatus FOREIGN KEY (IrsStatusId) REFERENCES crm.IrsStatuses(IrsStatusId),
    CONSTRAINT FK_WorkItem_CommMethod FOREIGN KEY (CommunicationMethodId) REFERENCES crm.CommunicationMethods(CommunicationMethodId),

    CONSTRAINT CK_WorkItem_TaxYear CHECK (TaxYear BETWEEN 1990 AND 2100),
    CONSTRAINT CK_WorkItem_Sequence CHECK (SequenceNo >= 1),
    CONSTRAINT CK_WorkItem_SubmitConsent CHECK (SubmittedDate IS NULL OR ConsentReceived = 1),
    CONSTRAINT CK_WorkItem_ArchivePair CHECK (
        (IsArchived = 0 AND ArchivedAtUtc IS NULL)
        OR (IsArchived = 1 AND ArchivedAtUtc IS NOT NULL))
) WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = crm.ClientWorkItemsHistory));

CREATE INDEX IX_WorkItems_Office_Prep
    ON crm.ClientWorkItems(OfficeId, PreparationStatusId, IsArchived)
    INCLUDE (ClientId, TaxYear, ReturnTypeId, FollowUpDate, UpdatedAtUtc);

CREATE INDEX IX_WorkItems_Irs
    ON crm.ClientWorkItems(IrsStatusId, IsArchived)
    INCLUDE (ClientId, OfficeId, TaxYear, RefundDate, PendingDate);

CREATE INDEX IX_WorkItems_FollowUp
    ON crm.ClientWorkItems(FollowUpDate, IsArchived)
    INCLUDE (ClientId, OfficeId, PreparationStatusId, IrsStatusId)
    WHERE FollowUpDate IS NOT NULL;
```

### Why `SequenceNo` exists

OGO may eventually need more than one matter with the same client, year, and broad return type—for example a second amendment. We do not make that future record impossible with an overly strict unique key.

---

## 5. Owner and reviewer are assignments, not text fields

The production portal currently stores `assignedTo` and `reviewer` by employee name. SQL uses employee foreign keys and keeps assignment history.

```sql
CREATE TABLE crm.WorkItemAssignments (
    WorkItemAssignmentId   int IDENTITY(1,1) NOT NULL,
    ClientWorkItemId       int NOT NULL,
    EmployeeId             int NOT NULL,
    AssignmentRole         tinyint NOT NULL, -- 1=Owner 2=Reviewer
    StartedAtUtc           datetime2(3) NOT NULL CONSTRAINT DF_WorkItemAsg_Start DEFAULT SYSUTCDATETIME(),
    StartedByEmployeeId    int NOT NULL,
    StartReason            tinyint NOT NULL, -- 1=Initial 2=Handoff 3=ManagerAssign 4=ReviewerAssign
    EndedAtUtc             datetime2(3) NULL,
    EndedByEmployeeId      int NULL,
    EndReason              tinyint NULL,
    SourceHandoffId        int NULL,
    CONSTRAINT PK_WorkItemAssignments PRIMARY KEY CLUSTERED (WorkItemAssignmentId),
    CONSTRAINT FK_WorkItemAsg_WorkItem FOREIGN KEY (ClientWorkItemId) REFERENCES crm.ClientWorkItems(ClientWorkItemId),
    CONSTRAINT FK_WorkItemAsg_Employee FOREIGN KEY (EmployeeId) REFERENCES hr.Employees(EmployeeId),
    CONSTRAINT CK_WorkItemAsg_Role CHECK (AssignmentRole IN (1,2)),
    CONSTRAINT CK_WorkItemAsg_EndPair CHECK (
        (EndedAtUtc IS NULL AND EndReason IS NULL)
        OR (EndedAtUtc IS NOT NULL AND EndReason IS NOT NULL))
);

CREATE UNIQUE INDEX UX_WorkItemAssignments_OneActiveRole
    ON crm.WorkItemAssignments(ClientWorkItemId, AssignmentRole)
    WHERE EndedAtUtc IS NULL;

CREATE INDEX IX_WorkItemAssignments_EmployeeActive
    ON crm.WorkItemAssignments(EmployeeId, AssignmentRole, EndedAtUtc)
    INCLUDE (ClientWorkItemId, StartedAtUtc);
```

The current owner view becomes:

```sql
CREATE VIEW crm.vCurrentWorkItemOwner AS
SELECT a.ClientWorkItemId,
       a.EmployeeId AS OwnerEmployeeId,
       a.StartedAtUtc AS OwnedSinceUtc,
       a.WorkItemAssignmentId
FROM crm.WorkItemAssignments a
WHERE a.AssignmentRole = 1 AND a.EndedAtUtc IS NULL;
```

A client can therefore have several open work items owned by different employees without corrupting client-level identity.

---

## 6. Status history is two tracks, not one stage history

We retain explicit queryable ledgers for status transitions while the temporal work-item table preserves full row snapshots.

```sql
CREATE TABLE crm.WorkItemPrepStatusHistory (
    WorkItemPrepStatusHistoryId bigint IDENTITY(1,1) NOT NULL,
    ClientWorkItemId       int NOT NULL,
    FromPreparationStatusId int NULL,
    ToPreparationStatusId   int NOT NULL,
    ChangedAtUtc           datetime2(3) NOT NULL CONSTRAINT DF_WiPrepHist_Changed DEFAULT SYSUTCDATETIME(),
    ChangedByEmployeeId    int NOT NULL,
    Reason                 nvarchar(500) NULL,
    DurationInPreviousStatusMinutes int NULL,
    CorrelationId          uniqueidentifier NULL,
    CONSTRAINT PK_WorkItemPrepStatusHistory PRIMARY KEY CLUSTERED (WorkItemPrepStatusHistoryId),
    CONSTRAINT FK_WiPrepHist_WorkItem FOREIGN KEY (ClientWorkItemId) REFERENCES crm.ClientWorkItems(ClientWorkItemId),
    CONSTRAINT FK_WiPrepHist_From FOREIGN KEY (FromPreparationStatusId) REFERENCES crm.PreparationStatuses(PreparationStatusId),
    CONSTRAINT FK_WiPrepHist_To FOREIGN KEY (ToPreparationStatusId) REFERENCES crm.PreparationStatuses(PreparationStatusId)
);

CREATE TABLE crm.WorkItemIrsStatusHistory (
    WorkItemIrsStatusHistoryId bigint IDENTITY(1,1) NOT NULL,
    ClientWorkItemId  int NOT NULL,
    FromIrsStatusId   int NULL,
    ToIrsStatusId     int NOT NULL,
    ChangedAtUtc      datetime2(3) NOT NULL CONSTRAINT DF_WiIrsHist_Changed DEFAULT SYSUTCDATETIME(),
    ChangedByEmployeeId int NOT NULL,
    Reason            nvarchar(500) NULL,
    DurationInPreviousStatusMinutes int NULL,
    CorrelationId     uniqueidentifier NULL,
    CONSTRAINT PK_WorkItemIrsStatusHistory PRIMARY KEY CLUSTERED (WorkItemIrsStatusHistoryId),
    CONSTRAINT FK_WiIrsHist_WorkItem FOREIGN KEY (ClientWorkItemId) REFERENCES crm.ClientWorkItems(ClientWorkItemId),
    CONSTRAINT FK_WiIrsHist_From FOREIGN KEY (FromIrsStatusId) REFERENCES crm.IrsStatuses(IrsStatusId),
    CONSTRAINT FK_WiIrsHist_To FOREIGN KEY (ToIrsStatusId) REFERENCES crm.IrsStatuses(IrsStatusId)
);
```

This supports clean questions such as:

- average days in `Missing Information`;
- average time from `Submitted to IRS` to `IRS Accepted`;
- returns rejected more than once;
- work items pending IRS processing for 30+ days.

---

## 7. Business event/history stream

The current `clientWorkflow.activities` and `clientWorkflow.audit` arrays become server-owned events instead of browser arrays.

```sql
CREATE TABLE crm.WorkItemEvents (
    WorkItemEventId   bigint IDENTITY(1,1) NOT NULL,
    ClientWorkItemId  int NOT NULL,
    EventType         nvarchar(60) NOT NULL,
    ActorEmployeeId   int NULL, -- NULL = system/migration
    OccurredAtUtc     datetime2(3) NOT NULL CONSTRAINT DF_WorkItemEvent_At DEFAULT SYSUTCDATETIME(),
    Summary           nvarchar(1000) NOT NULL,
    DetailJson        nvarchar(max) NULL,
    CorrelationId     uniqueidentifier NULL,
    CONSTRAINT PK_WorkItemEvents PRIMARY KEY CLUSTERED (WorkItemEventId),
    CONSTRAINT FK_WorkItemEvent_WorkItem FOREIGN KEY (ClientWorkItemId) REFERENCES crm.ClientWorkItems(ClientWorkItemId),
    CONSTRAINT CK_WorkItemEvent_Json CHECK (DetailJson IS NULL OR ISJSON(DetailJson)=1)
);

CREATE INDEX IX_WorkItemEvents_WorkItem
    ON crm.WorkItemEvents(ClientWorkItemId, OccurredAtUtc DESC);
```

Typical events: `Created`, `Updated`, `PreparationStatusChanged`, `IrsStatusChanged`, `ContactLogged`, `HandoffSent`, `HandoffAccepted`, `HandoffDeclined`, `Archived`, `FollowUpChanged`.

`audit.AuditLog` still records request-level identity/IP/correlation. `WorkItemEvents` is the business-facing narrative.

---

## 8. Handoffs now target a work item

A handoff means “take over this return/matter,” not “take ownership of every piece of work for this client.”

The corrected handoff identity is:

```sql
ALTER TABLE crm.ClientHandoffs
    ADD ClientWorkItemId int NULL;
```

For the actual Phase 1 migration we create the table correctly from the start rather than applying this ALTER. The authoritative shape is:

```sql
CREATE TABLE crm.ClientHandoffs (
    HandoffId       int IDENTITY(1,1) NOT NULL,
    PublicId        uniqueidentifier NOT NULL CONSTRAINT DF_Handoff_PublicId DEFAULT NEWID(),
    ClientWorkItemId int NOT NULL,
    FromEmployeeId  int NOT NULL,
    ToEmployeeId    int NOT NULL,
    HandoffStatus   tinyint NOT NULL CONSTRAINT DF_Handoff_Status DEFAULT 0,
    Message         nvarchar(1000) NULL,
    InitiatedAtUtc  datetime2(3) NOT NULL CONSTRAINT DF_Handoff_Init DEFAULT SYSUTCDATETIME(),
    InitiatedByEmployeeId int NOT NULL,
    ExpiresAtUtc    datetime2(3) NULL,
    RespondedAtUtc  datetime2(3) NULL,
    RespondedByEmployeeId int NULL,
    ResponseNote    nvarchar(1000) NULL,
    SourceAssignmentId int NULL,
    RowVersion      rowversion NOT NULL,
    CONSTRAINT PK_ClientHandoffs PRIMARY KEY CLUSTERED (HandoffId),
    CONSTRAINT FK_Handoff_WorkItem FOREIGN KEY (ClientWorkItemId) REFERENCES crm.ClientWorkItems(ClientWorkItemId),
    CONSTRAINT FK_Handoff_From FOREIGN KEY (FromEmployeeId) REFERENCES hr.Employees(EmployeeId),
    CONSTRAINT FK_Handoff_To FOREIGN KEY (ToEmployeeId) REFERENCES hr.Employees(EmployeeId),
    CONSTRAINT CK_Handoff_Status CHECK (HandoffStatus IN (0,1,2,3,4,5)),
    CONSTRAINT CK_Handoff_NotSelf CHECK (FromEmployeeId <> ToEmployeeId)
);

CREATE UNIQUE INDEX UX_ClientHandoffs_OnePending
    ON crm.ClientHandoffs(ClientWorkItemId)
    WHERE HandoffStatus = 0;
```

The accept transaction locks the pending handoff and the active **Owner assignment for that `ClientWorkItemId`**, closes it, then inserts the recipient owner assignment. `UX_WorkItemAssignments_OneActiveRole` guarantees two owners cannot exist.

---

## 9. Server validation rules preserving current behavior

These rules move out of JavaScript and into the application/database boundary.

1. `Refund Issued` requires `RefundDate`.
2. `IRS Rejected` requires `RejectionCode`.
3. `SubmittedDate` requires `ConsentReceived = true`.
4. Archived work items cannot initiate a handoff.
5. Normal staff cannot directly replace the active owner; they must use a handoff.
6. Only the intended recipient can accept/decline a pending handoff unless an explicit administrative force-reassign permission is used.
7. A client work item can have at most one pending handoff.
8. A client work item can have at most one active Owner and one active Reviewer.

We deliberately do **not** add overly aggressive checks such as “IRS Accepted requires the current preparation status to equal E-Filed.” Historical dates and current status can legitimately diverge, and the imported data must remain representable.

---

## 10. No persisted single headline stage

The portal may still want one colored headline/badge for a dashboard. That is a read-model concern, not stored truth.

Example view:

```sql
CREATE VIEW crm.vClientWorkItemSummary AS
SELECT w.ClientWorkItemId,
       w.PublicId,
       w.ClientId,
       w.TaxYear,
       rt.Name AS ReturnType,
       ps.Name AS PreparationStatus,
       irs.Name AS IrsStatus,
       CASE
         WHEN w.IsArchived = 1 THEN N'Closed'
         WHEN irs.Code = N'IrsRejected' THEN N'IRS Rejected'
         WHEN irs.Code IN (N'PendingIrsProcessing',N'AdditionalIrsActionRequired') THEN N'IRS Action'
         WHEN irs.Code IN (N'RefundIssued',N'ReturnClosed') THEN N'Complete'
         WHEN irs.Code <> N'NotSubmitted' THEN irs.Name
         ELSE ps.Name
       END AS HeadlineStatus,
       w.FollowUpDate,
       w.NextAction,
       w.RowVersion
FROM crm.ClientWorkItems w
JOIN crm.ReturnTypes rt ON rt.ReturnTypeId = w.ReturnTypeId
JOIN crm.PreparationStatuses ps ON ps.PreparationStatusId = w.PreparationStatusId
JOIN crm.IrsStatuses irs ON irs.IrsStatusId = w.IrsStatusId;
```

The exact display priority can change without migrating stored workflow data.

---

## 11. API contract changes

The API works with `work-items`, not a fake workflow property on `clients`.

### Reads

```text
GET /api/v1/work-items
GET /api/v1/work-items/{workItemId}
GET /api/v1/clients/{clientId}/work-items
GET /api/v1/workflow/dashboard
GET /api/v1/work-items/{workItemId}/events
GET /api/v1/work-items/{workItemId}/status-history
```

### Writes

```text
POST /api/v1/work-items
PUT  /api/v1/work-items/{workItemId}           If-Match required
POST /api/v1/work-items/{workItemId}/archive
POST /api/v1/work-items/{workItemId}/contacts
POST /api/v1/handoffs                          body contains workItemId
POST /api/v1/handoffs/{handoffId}/accept
POST /api/v1/handoffs/{handoffId}/decline
POST /api/v1/handoffs/{handoffId}/cancel
```

A record-level `PUT` is acceptable here: it updates **one work item**, not the whole portal. The server compares old/new statuses inside the transaction and appends the appropriate prep/IRS history rows and business events.

### Concurrency

`GET /work-items/{id}` returns an ETag from `RowVersion`. `PUT` must send `If-Match`. A stale browser receives `412 Precondition Failed` and cannot overwrite a coworker’s more recent edit.

---

## 12. SignalR vocabulary changes

Recommended events:

```text
workItem.created
workItem.updated
workItem.assignment.changed
workItem.preparationStatus.changed
workItem.irsStatus.changed
workItem.archived
handoff.created
handoff.updated
notification.created
```

SignalR sends only identity/version/minimal display metadata. The receiving browser GETs the authoritative work item.

---

## 13. Migration from the transition baseline

Each `S.clientWorkflow.clients[]` object becomes one `crm.ClientWorkItems` row plus assignments.

| Current field | SQL destination |
|---|---|
| `id` | `ClientWorkItems.LegacyWorkflowId` |
| `clientId` | resolve/create `crm.Clients.ClientNumber` where appropriate; never use as SQL PK |
| `name` | resolve/create `crm.Clients` |
| `taxYear` | `ClientWorkItems.TaxYear` |
| `returnType` | `ReturnTypes` → `ReturnTypeId` |
| `office` | `Offices` → `OfficeId` |
| `assignedTo` | active `WorkItemAssignments` row, role Owner |
| `reviewer` | active `WorkItemAssignments` row, role Reviewer |
| `prepStatus` | `PreparationStatuses` → `PreparationStatusId` |
| `irsStatus` | `IrsStatuses` → `IrsStatusId` |
| `docsComplete` | `DocsComplete` |
| `taxSlayerEntered` | `TaxSlayerEntered` |
| `numbersReviewed` | `NumbersReviewed` |
| `clientUpdateSent` | `ClientUpdateSent` |
| `communicationMethod` | `CommunicationMethods` → `CommunicationMethodId` |
| `consentReceived` | `ConsentReceived` |
| `submittedDate` | `SubmittedDate` |
| `acceptedDate` | `AcceptedDate` |
| `rejectedDate` | `RejectedDate` |
| `rejectionCode` | `RejectionCode` |
| `pendingDate` | `PendingDate` |
| `refundDate` | `RefundDate` |
| `lastContactDate` | `LastContactDate` |
| `nextAction` | `NextAction` |
| `followUpDate` | `FollowUpDate` |
| `notes` | `Notes` |
| `createdAt` | `CreatedAtUtc` after timestamp normalization |
| `updatedAt` / `updatedBy` | `UpdatedAtUtc` / resolved `UpdatedByEmployeeId`; preserve unresolved actor in migration event detail |

### Handoffs

`clientWorkflow.handoffs[].clientRecordId` points to the workflow-record ID, not a durable SQL client identity. Migration resolves it through `ClientWorkItems.LegacyWorkflowId` and writes `ClientHandoffs.ClientWorkItemId`.

That is the critical mapping that preserves the actual handoff target.

---

## 14. Migration reconciliation gates

Before cutover, the staging import must prove:

- every non-archived workflow object became exactly one work item;
- every legacy workflow ID is unique after import;
- every owner/reviewer name either resolved to an employee or appears on an explicit unresolved-mapping report;
- every handoff resolves to a work item;
- pending handoffs still point to the same intended recipient;
- accepted handoffs agree with the imported current Owner assignment;
- every prep/IRS status value maps to a seeded lookup value;
- dates and milestone booleans match the source;
- no import silently invents consent, IRS acceptance, or refund dates.

The migration fails closed if any handoff cannot resolve its work item.

---

## 15. Phase 5 implementation gate

Phase 5 may begin only when the generated EF Core model reflects this document:

```text
Clients
ClientWorkItems
ReturnTypes
PreparationStatuses
IrsStatuses
CommunicationMethods
WorkItemAssignments
WorkItemPrepStatusHistory
WorkItemIrsStatusHistory
WorkItemEvents
ClientHandoffs -> ClientWorkItemId
```

The old `WorkflowStages` + one-row `ClientWorkflowStatus(WorkflowStageId)` model must **not** be scaffolded into production code.

This resolves the workflow-model blocker identified during the baseline comparison.
