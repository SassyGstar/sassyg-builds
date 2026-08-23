# Operations Dashboard — 24 Hour Commercial Laundry Equipment

🌐 **[Try it live](https://sassygstar.github.io/sassyg-builds/24hr-laundry-dashboard/)**

Built to the requirements specification from **Weldon Ledbetter, Owner**.

One dashboard where a job starts and ends — replacing work that currently lives in texts,
phone calls, paper and QuickBooks Online. A phone-first view for technicians in the field,
a desktop view for the office, and a QuickBooks integration so nobody retypes anything.

**QuickBooks Online remains the accounting system of record.** This is the operations layer
that feeds it, not a replacement for it.

---

## Try it

Open `index.html` in any browser. No install, no build step, no sign-up.

Roles are switchable on purpose, so you can see exactly what each person can and cannot see:

| Sign in as | Level | Sees |
|---|---|---|
| **Weldon Ledbetter** | Owner | Everything — cost, margin, all reports, price book, business rules |
| **Candice Shreve** | Office Manager | All jobs, customers, invoices, dispatch, estimates. Sell prices, **not cost** |
| **Myline de la Cruz** | Admin / VA | Invoicing, payments, parts follow-up, scheduling. Same visibility as office |
| **TJ** / **Weldon III** | Technician | Mobile only — own jobs, equipment history, customer price book |

**The permission that is not negotiable:** technicians see **sell** prices, never **cost**.
That is enforced in `firestore.rules`, not just hidden in the interface — cost lives in a
separate document a technician has no read on.

### Worth clicking

- **Tap any machine on a job** → its full service history. The Harbor View Milnor has had the
  same bearing complaint twice in eight months, and the app says so in plain language. That is
  what turns "another repair" into "here is why you should replace it."
- **Ready to Invoice → Review**, on each of the six rows. Every one blocks for a different real
  reason: no PO on an account that requires one, a part with no QuickBooks item link, a customer
  that does not exist in QuickBooks yet, tax-exempt with no certificate on file, and freight that
  nobody has confirmed.
- **Open a job as TJ** → En Route, then On Site. The arrival tap takes a GPS stamp. Then Complete:
  a 40-minute call still bills the 2-hour minimum, and the app says so rather than hiding it.
- **The sync pill in the top bar** simulates losing signal. Complete a job "offline" and watch it
  queue on the phone and sync when it reconnects.
- **Payments** → the invoice Ruth says she already paid, sitting there generating a finance charge
  that has deliberately not fired.

The company, its people and its business rules are real. Every customer, site, machine, work order
and dollar figure is fictional sample data. Nothing leaves your browser.

---

## The business rules, as built

Every one of these is a setting the owner can edit under Settings, not a number buried in code.

| Rule | Value | Where it shows up |
|---|---|---|
| Labor rate | **$165/hour** | Every hourly job |
| Minimum per service call | **2 hours ($330)** | A 40-minute call still bills $330, and the invoice review says so |
| Increment after the minimum | 30 minutes | 2h14m on site bills 2.5 hours |
| Preventive maintenance | $95 per machine per visit | PM jobs bill flat per machine, not hourly |
| Parts and equipment markup | cost × 1.30 | Sell price is calculated, never typed. Overridable per line |
| Installation | Quoted separately at the labor rate | Never bundled with equipment, on quotes or invoices |
| Shipping | Always added when parts are on the invoice | QuickBooks' dedicated shipping field. ~$30 default is a **prompt**, and the push is blocked until a person confirms the real freight |
| Tax | Parts and installation labor taxed | Except flagged exempt accounts, which the app refuses to tax |
| Card fee | 3% over $3,000 | Shown on quotes |
| Finance charge | 1.5% per month | **Surfaced for review, never fired automatically** |
| Estimate expiry | 30 days | On every estimate, with the standard terms |
| Bearing / trunnion | ~$450 puller and tooling fee | A toggle in the completion flow |

Company name, address, phone, email and the Philippians 4:13 line come from one `BRAND` block at
the top of the script and print on customer-facing documents. No other trade name or domain appears
anywhere in this build.

---

## What is built

| Module | State |
|---|---|
| 1 — Work orders / service calls | ✅ full job vocabulary, 7-state status, PO handling, field completion |
| 2 — Time tracking | ✅ **two separate clocks** — payroll (a day) and job (En Route → On Site with GPS → Complete). Multiple techs roll up to one work order |
| 3 — Parts and inventory | ✅ four locations, reorder points, needs-ordering queue, POs with freight, receiving, truck transfers, all four alerts |
| 4 — Price book / on-site quoting | ✅ owner-editable with effective dates, quote builder on the phone, standard terms |
| 5 — Invoicing and QuickBooks | ✅ front end + Cloud Functions written; needs an Intuit app and a Firebase project to go live |
| 6 — History lookup (office view) | ✅ one search box across work orders, invoices, POs, serials and field notes |
| 7 — Customer and equipment records | ✅ per-machine history, repeat-complaint detection, lifetime service vs replacement cost |
| 8 — Scheduling and dispatch | ✅ board with drag-to-assign, per-tech route list, recurring PM. See "not built" below |
| 9 — Owner dashboard | ✅ all nine metrics |

### Deliberately not built, and why

Rather than fake these, they are named:

- **Map view of the day's stops.** Needs a Google Maps API key and a billing account. What is built
  instead is the ordered stop list per technician with an "Open route" link that hands the whole
  day's addresses to Google Maps in one tap — most of the value, no key required.
- **Push notifications on assignment.** Needs Firebase Cloud Messaging, a service worker and a real
  HTTPS host. The architecture is straightforward; it just cannot run from a single local file.
- **PDF estimate generation.** The estimate view is print-ready (Print / PDF from the browser).
  A server-rendered PDF emailed automatically is a small addition once there is a host.
- **Tokenized card storage.** The customer record carries a token field and never a card number,
  which is the requirement. Actually issuing tokens needs a payment processor account.

### Files

```
index.html         The whole application — no build step, no dependencies
functions/
  index.js         QuickBooks: OAuth, proactive token refresh, invoice push,
                   customer matching, payment posting, receivables polling, roles
firestore.rules    Four roles enforced at the database. Cost is a separate document
storage.rules      Job photos, signatures, receipts
```

The demo runs on `localStorage` so it can be handed to someone as one file. The read/write shape
deliberately matches Firestore collections, so swapping the backing store is a contained change.

---

## Answers to the questions in section 7

**1. Custom build, or configure Housecall Pro / ServiceTitan / Jobber?**

Honestly: the packaged tools would cover Modules 1, 2, 5, 6 and 8 out of the box, and they cost
roughly $50–$300 per user per month. What they are weak at is exactly what makes this business
different:

- **Equipment as the primary record.** Your question is not "when did we last visit Harbor View," it
  is "*this* Milnor, serial ending 0221 — how many bearing jobs has it eaten?" The packaged tools
  treat equipment as an attachment to a job. This build treats the machine as the record and the job
  as an event on it. That is the strongest argument for building.
- **Your specific billing rules.** The 2-hour minimum, 30-minute increments, cost × 1.30, mandatory
  freight, the $450 tooling fee. Most platforms do some of these; getting all of them exact usually
  means workarounds the office has to remember.
- **Truck-level inventory with special orders tied to a job.** Genuinely awkward in the general tools.

Against building: you own the maintenance forever, and there is nobody to call at 11pm.
**My recommendation: trial Jobber for one month before committing to the custom build.** If it gets
you 80% of the way, take it. If the equipment-history gap is as painful as your spec suggests, build.

**2. If custom: platform, hosting, and what happens to my data if we stop working together?**

React or plain HTML/JS on Netlify or Firebase Hosting; Firestore for data; Firebase Auth for logins;
Firebase Storage for photos. All of it is in **your** Google account, billed to your card, with you
as owner — I get added as a collaborator you can remove. Firestore exports to JSON on demand and
there is a one-command full export. **You are never locked to me**: another developer can pick up a
documented single-file front end and a standard Firebase backend. That is a deliberate reason for
choosing boring, common technology over anything clever.

**3. Timeline and cost for Phase 1** — Gina to quote. The scope driver is that Phase 1 in your spec
(work orders, mobile job view, time tracking with the minimum, parts capture, QuickBooks invoice
creation, office lookup) is genuinely the bulk of the work, and the QuickBooks piece is the part
that takes the longest to get right because of sandbox testing.

**4. How the QuickBooks connection is handled, and kept from breaking**

- The client secret and the OAuth refresh token **never touch the browser**. Every call goes through
  a Cloud Function that holds the credentials. Anyone proposing to call Intuit directly from the
  front end is proposing a security hole and a rework in three months.
- Access tokens last one hour; refresh tokens last **100 days of disuse**. That is what usually kills
  these integrations: a quiet stretch, and one morning invoicing stops with no warning.
  `qboKeepAlive` refreshes daily on a schedule rather than waiting for a failure, and Intuit rotates
  the refresh token on most refreshes so the new one is always written down.
- `qboStatus` reports how many days are left before the refresh token would die.
- API version is pinned (`minorversion`), rate limits get exponential backoff, and the customer and
  item lists are cached rather than refetched on every page load.
- Errors are never silently retried. Intuit's messages are specific and actionable, so the office
  reads the real one.

**5. Offline mode for the technicians**

Firestore offline persistence, which is the same mechanism Google's own apps use. The write lands on
the phone immediately and syncs when signal returns — the technician never sees a failure and never
loses a completion. In this demo you can prove it: tap the sync pill to simulate no signal, complete
a job, watch it queue and then drain. This matters because the Harbor View basement genuinely has no
signal, which is why that site's access notes say to go En Route before going downstairs.

**6. Ongoing support and maintenance per month** — Gina to quote. The recurring technical costs to be
aware of separately: Firebase is likely free-tier to a few dollars a month at your volume, and the
Intuit developer account is free.

**7. Users included, and cost per technician** — Gina to quote. Worth noting the build has no
per-seat cost of its own; adding a technician is creating a login and assigning a role.

---

## Risks worth naming

- **Adoption is the real risk, not the code.** A technician who does not complete jobs in the app
  produces an empty dashboard. The completion flow has been cut to the minimum, times itself from
  the clock, and uses pick-lists over typing everywhere possible — but it still has to be worth TJ's
  while. Tying a complete record to pay or commission resolves adoption faster than any feature.
- **QuickBooks token expiry.** Covered above. The single most common cause of these integrations
  quietly dying six months in.
- **A messy QuickBooks item list will stall invoicing.** The demo shows exactly what it looks like:
  the Dexter door lock has no item link, and the invoice will not send. Worth auditing the item list
  before the invoicing phase starts, not during it.
- **Dirty customer data.** If the QuickBooks customer list has duplicates or inconsistent naming,
  clean it *before* syncing. Customer creation here matches against existing QuickBooks records
  first, but it cannot fix a list that already has three spellings of the same hotel.

## One thing to confirm

The spec says "on repair and installation jobs, tax **both parts and installation labor**." That is
implemented literally: parts are always taxable, and labor is taxable on repair and installation
jobs. If Florida requires service labor on a plain service call to be taxed too, it is one line to
change — it is marked in the code. Worth a word with the accountant before going live.

---

*24 Hour Commercial Laundry Equipment · 5401 S Kirkman Rd, Suite 310, Orlando, FL 32819 · 407-600-6828 · 24hcles@gmail.com*
