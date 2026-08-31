# OGO Staff Portal — Client Workflow Redesign (Authoritative Phase 5 Model)

**Status:** Approved design for implementation planning  
**Source behavior:** Transition baseline SHA-256 `39f4472ebbbd709672a9ec8d9ebac83c637db72dfeb385781b6fb1fe1bcac3af`  
**Supersedes:** the single-stage `crm.ClientWorkflowStatus` design in `01-database-blueprint.md` §5.1, any handoff design that transfers a whole `ClientId`, and API mappings that treat a workflow record as `/clients/{id}/workflow`.

---

## 1. Why the old model is wrong

The production portal does not store one linear workflow stage. Each detailed workflow row carries parallel facts: client, tax year, return type, office, owner, reviewer, preparation status, IRS status, five milestones, communication method, IRS/refund dates, rejection code, last contact, next action, follow-up and notes.

Those facts can all be true at the same time. Therefore a single `WorkflowStageId` cannot be the source of truth.

The production object is a **tax work item**.

```text
Client
  └── ClientWorkItem
        ├── PreparationStatus
        ├── IrsStatus
        ├── milestones + dates
        ├── WorkItemAssignments (Owner / Reviewer)
        ├── WorkItemContactLogs
        ├── WorkItemPrepStatusHistory
        ├── WorkItemIrsStatusHistory
        ├── WorkItemEvents
        └── ClientHandoffs
```

Example:

```text
Johnson Household
  ├── 2025 Individual Return
  ├── 2024 Amended Return
  └── 2026 Extension
```

Each work item can have a different owner, reviewer, statuses, follow-up date and handoff history.

---

## 2. Lookup tables

Preparation and IRS status are independent tracks.

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
    Code       nvarchar(60) NOT NULL,
    Name       nvarchar(100) NOT NULL,
    SortOrder  int NOT NULL,
    IsTerminal bit NOT NULL CONSTRAINT DF_PrepStatus_Terminal DEFAULT 0,
    IsActive   bit NOT NULL CONSTRAINT DF_PrepStatus_Active DEFAULT 1,
    CONSTRAINT PK_PreparationStatuses PRIMARY KEY CLUSTERED (PreparationStatusId),
    CONSTRAINT UX_PreparationStatuses_Code UNIQUE (Code)
);

CREATE TABLE crm.IrsStatuses (
    IrsStatusId int IDENTITY(1,1) NOT NULL,
    Code       nvarchar(60) NOT NULL,
    Name       nvarchar(100) NOT NULL,
    SortOrder  int NOT NULL,
    IsTerminal bit NOT NULL CONSTRAINT DF_IrsStatus_Terminal DEFAULT 0,
    IsActive   bit NOT NULL CONSTRAINT DF_IrsStatus_Active DEFAULT 1,
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

Seed names preserve the current portal exactly. Codes are stable machine names independent of display text.

### Return types

| Code | Current display name |
|---|---|
| `Individual` | Individual |
| `Business` | Business |
| `AmendedReturn` | Amended Return |
| `PriorYearReturn` | Prior-Year Return |
| `ItinReturn` | ITIN Return |
| `Extension` | Extension |

### Preparation statuses

`NewClient`, `IntakeInProgress`, `MissingInformation`, `AllInformationReceived`, `EnteredIntoTaxSlayer`, `UnderPreparerReview`, `NumbersReviewedApproved`, `ClientUpdateSent`, `WaitingClientAuthorization`, `ClientAuthorizationReceived`, `ReadyToEFile`, `EFiled`, `PaperReturnRequired`, `CompletedBalanceDue`, `ClosedArchived`.

Their display names remain the current 15 portal labels.

### IRS statuses

`NotSubmitted`, `SubmittedToIrs`, `IrsAccepted`, `IrsRejected`, `CorrectionInProgress`, `ResubmittedToIrs`, `PendingIrsProcessing`, `AdditionalIrsActionRequired`, `RefundApproved`, `RefundIssued`, `RefundHeldDelayed`, `RefundAppliedToDebt`, `BalanceDueNoRefund`, `PaperReturnMailed`, `ReturnClosed`.

Their display names remain the current 15 portal labels.

### Communication methods

`InPerson`, `Telephone`, `Email`, `TextMessage`, `TaxDome`, `VirtualAppointment`.

---

## 3. `crm.ClientWorkItems` — current state

One row is one current tax matter. It is temporal, so SQL preserves every prior version of the row.

```sql
CREATE TABLE crm.ClientWorkItems (
    ClientWorkItemId      int IDENTITY(1,1) NOT NULL,
    PublicId              uniqueidentifier NOT NULL CONSTRAINT DF_WorkItem_PublicId DEFAULT NEWID(),
    ClientId              int NOT NULL,
    OfficeId              int NOT NULL,
    TaxYear               smallint NOT NULL,
    ReturnTypeId          int NOT NULL,
    SequenceNo            smallint NOT NULL CONSTRAINT DF_WorkItem_Sequence DEFAULT 1,

    PreparationStatusId   int NOT NULL,
    IrsStatusId           int NOT NULL,
    CommunicationMethodId int NULL,

    DocsComplete          bit NOT NULL CONSTRAINT DF_WorkItem_Docs DEFAULT 0,
    TaxSlayerEntered      bit NOT NULL CONSTRAINT DF_WorkItem_TaxSlayer DEFAULT 0,
    NumbersReviewed       bit NOT NULL CONSTRAINT DF_WorkItem_Reviewed DEFAULT 0,
    ClientUpdateSent      bit NOT NULL CONSTRAINT DF_WorkItem_UpdateSent DEFAULT 0,
    ConsentReceived       bit NOT NULL CONSTRAINT DF_WorkItem_Consent DEFAULT 0,

    SubmittedDate         date NULL,
    AcceptedDate          date NULL,
    RejectedDate          date NULL,
    RejectionCode         nvarchar(80) NULL,
    PendingDate           date NULL,
    RefundDate            date NULL,
    LastContactDate       date NULL,
    FollowUpDate          date NULL,

    NextAction            nvarchar(1000) NULL,
    Notes                 nvarchar(max) NULL,

    IsArchived            bit NOT NULL CONSTRAINT DF_WorkItem_Archived DEFAULT 0,
    ArchivedAtUtc         datetime2(3) NULL,
    ArchivedByEmployeeId  int NULL,

    LegacyWorkflowId      bigint NULL,
    CreatedAtUtc          datetime2(3) NOT NULL CONSTRAINT DF_WorkItem_Created DEFAULT SYSUTCDATETIME(),
    CreatedByEmployeeId   int NULL,
    UpdatedAtUtc          datetime2(3) NOT NULL CONSTRAINT DF_WorkItem_Updated DEFAULT SYSUTCDATETIME(),
    UpdatedByEmployeeId   int NULL,
    RowVersion            rowversion NOT NULL,

    ValidFrom datetime2(3) GENERATED ALWAYS AS ROW START HIDDEN NOT NULL,
    ValidTo   datetime2(3) GENERATED ALWAYS AS ROW END HIDDEN NOT NULL,
    PERIOD FOR SYSTEM_TIME (ValidFrom, ValidTo),

    CONSTRAINT PK_ClientWorkItems PRIMARY KEY CLUSTERED (ClientWorkItemId),
    CONSTRAINT UX_ClientWorkItems_PublicId UNIQUE (PublicId),
    CONSTRAINT UX_ClientWorkItems_Identity UNIQUE (ClientId, TaxYear, ReturnTypeId, SequenceNo),

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

-- SQL Server unique indexes allow only one NULL, so legacy identity MUST be filtered.
CREATE UNIQUE INDEX UX_ClientWorkItems_Legacy
    ON crm.ClientWorkItems(LegacyWorkflowId)
    WHERE LegacyWorkflowId IS NOT NULL;

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

`SequenceNo` keeps the schema from forbidding a second amendment or similar repeat matter in the same year.

Employee FKs on `ArchivedByEmployeeId`, `CreatedByEmployeeId`, and `UpdatedByEmployeeId` are added in the final dependency-order migration step, consistent with the main database blueprint’s circular-FK convention.

---

## 4. Owner and reviewer are assignment ledgers

The current portal stores employee names. Production stores employee IDs and retains history.

```sql
CREATE TABLE crm.WorkItemAssignments (
    WorkItemAssignmentId int IDENTITY(1,1) NOT NULL,
    ClientWorkItemId     int NOT NULL,
    EmployeeId           int NOT NULL,
    AssignmentRole       tinyint NOT NULL, -- 1=Owner 2=Reviewer
    StartedAtUtc         datetime2(3) NOT NULL CONSTRAINT DF_WorkItemAsg_Start DEFAULT SYSUTCDATETIME(),
    StartedByEmployeeId  int NOT NULL,
    StartReason          tinyint NOT NULL, -- 1=Initial 2=Handoff 3=ManagerAssign 4=ReviewerAssign
    EndedAtUtc           datetime2(3) NULL,
    EndedByEmployeeId    int NULL,
    EndReason            tinyint NULL,
    SourceHandoffId      int NULL,
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

`SourceHandoffId` receives its FK after `ClientHandoffs` exists.

```sql
CREATE VIEW crm.vCurrentWorkItemOwner AS
SELECT a.ClientWorkItemId,
       a.EmployeeId AS OwnerEmployeeId,
       a.StartedAtUtc AS OwnedSinceUtc,
       a.WorkItemAssignmentId
FROM crm.WorkItemAssignments a
WHERE a.AssignmentRole = 1 AND a.EndedAtUtc IS NULL;
```

---

## 5. Client contact/activity log

`wfSaveContact()` is not a contact-address book entry. It records a completed interaction, method, summary and follow-up, and weekly reporting counts those interactions. It gets a normalized table.

```sql
CREATE TABLE crm.WorkItemContactLogs (
    WorkItemContactLogId bigint IDENTITY(1,1) NOT NULL,
    ClientWorkItemId     int NOT NULL,
    ContactDate          date NOT NULL,
    OccurredAtUtc        datetime2(3) NOT NULL CONSTRAINT DF_WorkItemContact_At DEFAULT SYSUTCDATETIME(),
    EmployeeId           int NOT NULL,
    OfficeId             int NOT NULL,
    CommunicationMethodId int NULL,
    Summary              nvarchar(2000) NOT NULL,
    NextAction           nvarchar(1000) NULL,
    FollowUpDate         date NULL,
    CONSTRAINT PK_WorkItemContactLogs PRIMARY KEY CLUSTERED (WorkItemContactLogId),
    CONSTRAINT FK_WorkItemContact_WorkItem FOREIGN KEY (ClientWorkItemId) REFERENCES crm.ClientWorkItems(ClientWorkItemId),
    CONSTRAINT FK_WorkItemContact_Employee FOREIGN KEY (EmployeeId) REFERENCES hr.Employees(EmployeeId),
    CONSTRAINT FK_WorkItemContact_Office FOREIGN KEY (OfficeId) REFERENCES org.Offices(OfficeId),
    CONSTRAINT FK_WorkItemContact_Method FOREIGN KEY (CommunicationMethodId) REFERENCES crm.CommunicationMethods(CommunicationMethodId)
);

CREATE INDEX IX_WorkItemContactLogs_WorkItem
    ON crm.WorkItemContactLogs(ClientWorkItemId, ContactDate DESC, OccurredAtUtc DESC);
CREATE INDEX IX_WorkItemContactLogs_Weekly
    ON crm.WorkItemContactLogs(ContactDate, OfficeId, EmployeeId)
    INCLUDE (ClientWorkItemId, CommunicationMethodId);
```

`POST /work-items/{id}/contact-logs` inserts this row and, in the same transaction, updates the work item’s `LastContactDate`, `NextAction`, `FollowUpDate`, `ClientUpdateSent`, and optional current communication method.

---

## 6. Preparation and IRS history are separate ledgers

```sql
CREATE TABLE crm.WorkItemPrepStatusHistory (
    WorkItemPrepStatusHistoryId bigint IDENTITY(1,1) NOT NULL,
    ClientWorkItemId int NOT NULL,
    FromPreparationStatusId int NULL,
    ToPreparationStatusId   int NOT NULL,
    ChangedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_WiPrepHist_Changed DEFAULT SYSUTCDATETIME(),
    ChangedByEmployeeId int NOT NULL,
    Reason nvarchar(500) NULL,
    DurationInPreviousStatusMinutes int NULL,
    CorrelationId uniqueidentifier NULL,
    CONSTRAINT PK_WorkItemPrepStatusHistory PRIMARY KEY CLUSTERED (WorkItemPrepStatusHistoryId),
    CONSTRAINT FK_WiPrepHist_WorkItem FOREIGN KEY (ClientWorkItemId) REFERENCES crm.ClientWorkItems(ClientWorkItemId),
    CONSTRAINT FK_WiPrepHist_From FOREIGN KEY (FromPreparationStatusId) REFERENCES crm.PreparationStatuses(PreparationStatusId),
    CONSTRAINT FK_WiPrepHist_To FOREIGN KEY (ToPreparationStatusId) REFERENCES crm.PreparationStatuses(PreparationStatusId)
);

CREATE TABLE crm.WorkItemIrsStatusHistory (
    WorkItemIrsStatusHistoryId bigint IDENTITY(1,1) NOT NULL,
    ClientWorkItemId int NOT NULL,
    FromIrsStatusId int NULL,
    ToIrsStatusId   int NOT NULL,
    ChangedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_WiIrsHist_Changed DEFAULT SYSUTCDATETIME(),
    ChangedByEmployeeId int NOT NULL,
    Reason nvarchar(500) NULL,
    DurationInPreviousStatusMinutes int NULL,
    CorrelationId uniqueidentifier NULL,
    CONSTRAINT PK_WorkItemIrsStatusHistory PRIMARY KEY CLUSTERED (WorkItemIrsStatusHistoryId),
    CONSTRAINT FK_WiIrsHist_WorkItem FOREIGN KEY (ClientWorkItemId) REFERENCES crm.ClientWorkItems(ClientWorkItemId),
    CONSTRAINT FK_WiIrsHist_From FOREIGN KEY (FromIrsStatusId) REFERENCES crm.IrsStatuses(IrsStatusId),
    CONSTRAINT FK_WiIrsHist_To FOREIGN KEY (ToIrsStatusId) REFERENCES crm.IrsStatuses(IrsStatusId)
);
```

This supports separate metrics such as time in `Missing Information` and time from `Submitted to IRS` to `IRS Accepted`.

---

## 7. Business event stream

Temporal history answers what the row looked like. `AuditLog` answers who called the API and from where. `WorkItemEvents` is the human-readable business narrative.

```sql
CREATE TABLE crm.WorkItemEvents (
    WorkItemEventId  bigint IDENTITY(1,1) NOT NULL,
    ClientWorkItemId int NOT NULL,
    EventType        nvarchar(60) NOT NULL,
    ActorEmployeeId  int NULL,
    OccurredAtUtc    datetime2(3) NOT NULL CONSTRAINT DF_WorkItemEvent_At DEFAULT SYSUTCDATETIME(),
    Summary          nvarchar(1000) NOT NULL,
    DetailJson       nvarchar(max) NULL,
    CorrelationId    uniqueidentifier NULL,
    CONSTRAINT PK_WorkItemEvents PRIMARY KEY CLUSTERED (WorkItemEventId),
    CONSTRAINT FK_WorkItemEvent_WorkItem FOREIGN KEY (ClientWorkItemId) REFERENCES crm.ClientWorkItems(ClientWorkItemId),
    CONSTRAINT CK_WorkItemEvent_Json CHECK (DetailJson IS NULL OR ISJSON(DetailJson)=1)
);

CREATE INDEX IX_WorkItemEvents_WorkItem
    ON crm.WorkItemEvents(ClientWorkItemId, OccurredAtUtc DESC);
```

Typical events: `Created`, `Updated`, `PreparationStatusChanged`, `IrsStatusChanged`, `ContactLogged`, `HandoffSent`, `HandoffAccepted`, `HandoffDeclined`, `Archived`, `FollowUpChanged`.

---

## 8. Handoffs target one work item

A handoff means “take over this return/matter,” not “take every piece of work belonging to this client.”

```sql
CREATE TABLE crm.ClientHandoffs (
    HandoffId       int IDENTITY(1,1) NOT NULL,
    PublicId        uniqueidentifier NOT NULL CONSTRAINT DF_Handoff_PublicId DEFAULT NEWID(),
    ClientWorkItemId int NOT NULL,
    FromEmployeeId  int NOT NULL,
    ToEmployeeId    int NOT NULL,
    HandoffStatus   tinyint NOT NULL CONSTRAINT DF_Handoff_Status DEFAULT 0,
        -- 0=Pending 1=Accepted 2=Declined 3=Cancelled 4=Expired 5=Superseded
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
    CONSTRAINT CK_Handoff_NotSelf CHECK (FromEmployeeId <> ToEmployeeId),
    CONSTRAINT CK_Handoff_Response CHECK (
        (HandoffStatus = 0 AND RespondedAtUtc IS NULL)
        OR (HandoffStatus <> 0 AND RespondedAtUtc IS NOT NULL))
);

CREATE UNIQUE INDEX UX_ClientHandoffs_OnePending
    ON crm.ClientHandoffs(ClientWorkItemId)
    WHERE HandoffStatus = 0;
```

`SourceAssignmentId` receives its FK after both tables exist.

The accept transaction locks the pending handoff and the active Owner assignment for that `ClientWorkItemId`, closes it, inserts the recipient Owner assignment, appends event/audit rows, then commits. `UX_WorkItemAssignments_OneActiveRole` makes two active owners physically impossible.

---

## 9. Server validation rules preserving current behavior

1. `Refund Issued` requires `RefundDate`.
2. `IRS Rejected` requires `RejectionCode`.
3. `SubmittedDate` requires `ConsentReceived = true`.
4. Archived work items cannot initiate a handoff.
5. Normal staff cannot directly replace the active Owner; they must use handoff.
6. Only the intended recipient can accept/decline a pending handoff unless an explicit force-reassign permission is used.
7. One work item can have at most one pending handoff.
8. One work item can have at most one active Owner and one active Reviewer.

We do not add aggressive cross-track checks that would make legitimate historical combinations unrepresentable.

---

## 10. Headline status is derived only

If the UI wants one badge, derive it in a view/read model. Never persist it as competing truth.

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

Display priority can change without migrating business data.

---

## 11. API contract

### Reads

```text
GET /api/v1/work-items
GET /api/v1/work-items/{workItemId}
GET /api/v1/clients/{clientId}/work-items
GET /api/v1/workflow/dashboard
GET /api/v1/work-items/{workItemId}/contact-logs
GET /api/v1/work-items/{workItemId}/events
GET /api/v1/work-items/{workItemId}/status-history
```

### Writes

```text
POST /api/v1/work-items
PUT  /api/v1/work-items/{workItemId}              If-Match required
POST /api/v1/work-items/{workItemId}/archive
POST /api/v1/work-items/{workItemId}/contact-logs
POST /api/v1/handoffs                             body contains workItemId
POST /api/v1/handoffs/{handoffId}/accept
POST /api/v1/handoffs/{handoffId}/decline
POST /api/v1/handoffs/{handoffId}/cancel
```

A record-level `PUT` is safe here because it updates one work item, not the entire portal. The server compares old/new values and appends prep/IRS history plus business events inside the same transaction.

`GET /work-items/{id}` returns an ETag from `RowVersion`; stale `If-Match` writes receive `412 Precondition Failed`.

---

## 12. SignalR vocabulary

```text
workItem.created
workItem.updated
workItem.assignment.changed
workItem.preparationStatus.changed
workItem.irsStatus.changed
workItem.contact.logged
workItem.archived
handoff.created
handoff.updated
notification.created
```

Events are invalidations, not authoritative records. Receivers GET the changed resource after notification.

---

## 13. Migration from the transition baseline

Each `S.clientWorkflow.clients[]` object becomes one `crm.ClientWorkItems` row plus Owner/Reviewer assignment rows.

| Current field | SQL destination |
|---|---|
| `id` | `ClientWorkItems.LegacyWorkflowId` |
| `clientId` | resolve/create `crm.Clients.ClientNumber` where appropriate; never use as SQL PK |
| `name` | resolve/create `crm.Clients` |
| `taxYear` | `ClientWorkItems.TaxYear` |
| `returnType` | `ReturnTypes` → `ReturnTypeId` |
| `office` | `Offices` → `OfficeId` |
| `assignedTo` | active `WorkItemAssignments` Owner |
| `reviewer` | active `WorkItemAssignments` Reviewer |
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
| `createdAt` | normalized `CreatedAtUtc` |
| `updatedAt` / `updatedBy` | normalized `UpdatedAtUtc` / resolved employee; unresolved actor preserved in migration event detail |

### Contact activity

Each `clientWorkflow.activities[]` row maps to `WorkItemContactLogs` by resolving `clientRecordId` through `ClientWorkItems.LegacyWorkflowId`.

### Handoffs

Each `clientWorkflow.handoffs[].clientRecordId` also resolves through `LegacyWorkflowId`, then writes `ClientHandoffs.ClientWorkItemId`. This preserves the exact matter that was handed off.

---

## 14. Reconciliation gates

Before cutover, staging must prove:

- every detailed workflow object became exactly one work item;
- every non-null legacy workflow ID is unique;
- every owner/reviewer either resolved to an employee or appears on an explicit unresolved-mapping report;
- every contact activity resolves to a work item;
- every handoff resolves to a work item;
- pending handoffs keep the same intended recipient;
- accepted handoffs agree with the imported active Owner assignment;
- every prep/IRS/return-type/communication value maps to a seeded lookup;
- dates and milestones match source values;
- no migration invents consent, IRS acceptance, rejection or refund facts.

The migration fails closed if a handoff cannot resolve its work item.

---

## 15. Phase 5 implementation gate

Phase 5 may begin only when the EF Core model contains:

```text
Clients
ClientWorkItems
ReturnTypes
PreparationStatuses
IrsStatuses
CommunicationMethods
WorkItemAssignments
WorkItemContactLogs
WorkItemPrepStatusHistory
WorkItemIrsStatusHistory
WorkItemEvents
ClientHandoffs -> ClientWorkItemId
```

The old `WorkflowStages` + `ClientWorkflowStatus(WorkflowStageId)` model must **not** be scaffolded into production code.

This resolves the workflow-model blocker found during the baseline comparison.
