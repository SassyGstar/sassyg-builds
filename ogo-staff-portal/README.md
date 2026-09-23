# OGO Staff Portal (Demo Version)

🌐 **[Try it live](https://sassygstar.github.io/sassyg-builds/ogo-staff-portal/)**

A single-file staff portal web app built for a multi-office tax firm. It includes:

- 📋 Dashboard with events, announcements, tasks, and smart alerts
- ⏰ Time clock with office geofencing
- 👥 Staff directory and birthdays
- 📝 PTO / request tracking
- 🎯 **Client Command Center** — one simple flow for every return:
  **Created By → Preparation Status → IRS Status**
  - Preparation Status (Missing Documents, Ready to Send, Needs Work, Client
    Opted Out) and IRS Status (Submitted, Accepted, Rejected, Resend,
    Resubmitted) change right from the list; a rejection requires the code
  - Handoffs that record why, what is done, and what is still needed, and
    notify the receiver; a trail shows who started, sent, and finished each return
  - Structured notes (done / happened / still needed / responsible / follow-up)
    with pinned reminders, and an Activity by Day view per employee
  - Opted-out and accepted clients stay visible; checklists can be edited to
    match the office's paper checklist
- 📊 Analytics
- 🔄 Optional real-time sync across devices (Firebase)

## Try it

Just open `index.html` in any web browser — no installation needed.

- Pick any name and click **Enter Portal**
- Admin passcode for this demo: `DEMO1234`
- Sign in as **Alex Rivera** or **Jordan Blake** (Administrators) to see every
  Command Center tab, including Management and Setup

## About this demo

All names, phone numbers, emails, birthdays, and clients in this version are
**fictional sample data**. The Firebase configuration is a placeholder — to
enable live sync, create your own free Firebase project and paste your own
config into `FB_CONFIG` near the top of the script. Without it, the app runs
happily in offline mode and saves everything in your browser.
