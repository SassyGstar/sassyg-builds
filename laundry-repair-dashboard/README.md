# Field Service Dashboard — 24 Hour Laundry Equipment

🌐 **[Try it live](https://sassygstar.github.io/sassyg-builds/laundry-repair-dashboard/)**

A job, equipment and fleet tracking system for a commercial laundry repair business,
with two front doors: a **mobile view for technicians in the field** and a
**desktop view for the office**. Built for
[24 Hour Laundry Equipment L.L.C.](https://laundryequipmentpros.com/) of Orlando, Florida.

It is a work-order and asset system, not an accounting system. QuickBooks Online stays
the book of record for money. This hands QuickBooks structured data and reads status back.

---

## Try it

Open `index.html` in any browser — no install, no build step, no sign-up.

Pick any of the five people on the sign-in screen. **Roles are switchable on purpose**
so you can see exactly what each one can and cannot see:

| Sign in as | Role | Sees |
|---|---|---|
| Marcus Webb, Dana Ruiz, Tommy Nguyen | technician | Mobile view, own jobs only, no financials |
| Andrea Aarndel | office | Dispatch, invoicing, receivables — no labor cost or margin |
| Weldon Ledbetter | owner | Everything, including cost and margin per job |

Things worth clicking:

- **Tap a machine on any job** → its full service history. A technician who can see that
  the same drain valve was replaced eight months ago diagnoses faster and gives the
  customer a better answer. This is the most valuable screen in the product.
- **Needs invoicing → Review** on each of the six rows. Every one exercises a different
  branch of the invoice validation: a missing purchase order, a part with no QuickBooks
  item link, a customer that does not exist in QuickBooks yet, an undecided warranty claim.
- **The sync pill in the top bar** simulates losing signal. Complete a job while "offline"
  and watch it queue on the device and sync when you reconnect.
- **Equipment tab** → the repair-versus-replace flags, with the service history behind each one.
- **Fleet panel** → one van's MPG has dropped 26% month over month. That is either a
  mechanical problem or fuel card misuse, and both are worth knowing this week.

Every customer, site, machine, work order and dollar figure is **fictional sample data**
placed in Central Florida for realism. Nothing leaves your browser.

---

## Honestly: should this be custom at all?

Housecall Pro, Jobber and ServiceTitan already do field service management and already
integrate with QuickBooks Online, at roughly $50–$300 per user per month. A custom build
has no per-seat fee, but it costs your time and it costs maintenance forever.

Custom wins here if these are true:

1. **Equipment history matters more than job history.** Commercial laundry repair is asset
   centric. The question is not "when did we last visit Sunshine Coin Laundry", it is
   "*this* Speed Queen washer, serial ending 4471 — how many times have we replaced the
   drain valve, and is it time to tell the customer to replace the machine?" Generic field
   service software treats equipment as an afterthought. This is the strongest argument
   for building.
2. **Contract and route work is a large share of revenue.** Preventive maintenance
   agreements across multi-location accounts are awkward in the general tools.
3. **You want to own the data and the workflow** rather than rent them.

If none of those hold, trial Jobber for a month before spending build money.

---

## What is built

| Phase | Scope | State |
|---|---|---|
| 1 — Foundation | Roles, customers, locations, equipment, work orders | ✅ in this build |
| 2 — The field | Technician mobile view, dispatch board, offline, photos, signature, mileage and fuel | ✅ in this build |
| 3 — The money | QuickBooks OAuth, customer sync, invoice push, AR aging | ✅ front end + Cloud Functions written; needs an Intuit app and a Firebase project to go live |
| 4 — Intelligence | Equipment history, repair-versus-replace, PM scheduling, fleet cost, margin per job | ✅ in this build |

Phases 1 and 2 have standalone value even if the project stops there. Do not let phase 3
become a prerequisite for anyone getting benefit.

### Files

```
index.html         The whole application — no build step, no dependencies
functions/
  index.js         QuickBooks Cloud Functions: OAuth, token refresh, invoice push,
                   customer create, receivables polling, role assignment
  package.json
firestore.rules    Role enforcement at the database, not in the interface
storage.rules      Job photos and fuel receipts
```

The demo runs entirely on `localStorage` so it can be handed to someone as a single file.
The read/write shape deliberately matches Firestore collections, so swapping the backing
store is a contained change rather than a rewrite.

---

## The QuickBooks integration

**The rule that is not negotiable:** the Intuit client secret and the OAuth refresh token
never touch the browser. Every QuickBooks call routes through a Cloud Function that holds
the credentials. If a developer proposes calling the Intuit API directly from the front
end, that is a security failure and a rework in three months.

### Direction of truth

- **QuickBooks owns** customers, invoices, payments, items, tax, terms.
- **The dashboard owns** work orders, equipment, technicians, vehicles, mileage, fuel, parts.

A customer is never created in the dashboard first. It is created in QuickBooks through the
API, the returned ID comes back, and the dashboard stores it. One-directional identity is
what prevents the duplicate-customer mess that kills these integrations.

### Going live

```bash
firebase functions:secrets:set QBO_CLIENT_ID
firebase functions:secrets:set QBO_CLIENT_SECRET
firebase functions:secrets:set QBO_REDIRECT_URI
firebase deploy --only functions,firestore:rules,storage
```

Then open `/qboConnect` in a browser once to authorize, and paste the functions base URL
into **Settings → QuickBooks** in the app. Until that URL is set, the app runs the
QuickBooks workflow in simulation so it can be demonstrated.

Build and test entirely against the **sandbox company**. Do not point at the live company
until the invoice push has been verified end to end at least twenty times.

**Token expiry is the thing that kills these integrations six months in.** Access tokens
last one hour; refresh tokens last one hundred days *of disuse*. A quiet stretch over the
holidays is enough to kill one, and then invoicing stops working one morning with no
warning. `qboKeepAlive` refreshes daily rather than waiting for a failure, and `qboStatus`
reports how many days are left.

---

## Mileage and fuel

There are two ways to deduct vehicle expense and they need different data. The standard
mileage rate needs clean per-trip mileage with date, purpose and business use. Actual
expenses needs every fuel purchase, repair, insurance and depreciation figure plus a
business-use percentage. **This app captures both**, because the data supports both and the
choice belongs to the tax preparer.

Two deliberate design decisions:

- **The app shows no deduction estimate until an IRS rate is entered by hand.** The standard
  mileage rate changes every year and this build will not assert one it has not been given.
  Enter the current rate from [irs.gov](https://www.irs.gov/tax-professionals/standard-mileage-rates)
  under Settings and the estimate appears, labelled an estimate.
- **A fuel entry without a receipt photo does not save**, and the Storage rules enforce it
  rather than just the form. That is the control that keeps fuel card spending honest.

Odometer readings bracket the day rather than each job. Ask per job and technicians simply
stop doing it.

---

## Open questions

These change the build. They are worth answering before phase 3 goes live.

1. How many technicians and vans, today and realistically in two years?
2. Company phones or personal devices? This drives the offline and install approach.
3. **How is manufacturer warranty work handled today, and who gets billed for it?** The app
   currently refuses to invoice a warranty claim until someone chooses: close it with no
   invoice, or bill the provider. Billing a customer for covered work is the fastest way to
   lose an account, so it blocks rather than guesses.
4. Parts on the vans, in a shop, or both? Van stock is modelled here because a van is a
   rolling warehouse, and it is meaningfully more work to keep honest.
5. Preventive maintenance contracts now, or all break/fix?
6. Is the QuickBooks item list already set up with service and part items? A messy item list
   will stall the invoicing phase — see the "no QuickBooks item link" blocker in the demo.
7. Should customers get automated status updates, or stay human?
8. Who maintains this after launch?

---

## Risks worth naming

- **Adoption is the real risk, not the code.** A technician who does not complete jobs in the
  app produces an empty dashboard. Whatever the completion flow costs in taps, cut it in
  half. Tying pay or commission to a complete record resolves adoption faster than any feature.
- **QuickBooks token expiry.** Covered above. It is the most common cause of these
  integrations quietly dying.
- **Dirty existing customer data.** If the QuickBooks customer list has duplicates and
  inconsistent naming, clean it *before* syncing, not after.
- **Scope creep toward becoming an accounting system.** QuickBooks calculates the tax. This
  never becomes a second source of truth for money.

---

## Out of scope for v1

Payroll, purchase orders to suppliers, a customer self-service portal, route optimization,
and inventory reorder automation. All reasonable later.
