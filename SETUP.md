# QuickBooks Desktop → ConSysTec Project Status: Setup

> ConSysTec has **QuickBooks Desktop**, not QuickBooks Online, so this is the
> only setup path in current use. (The QuickBooks Online path this project
> was originally built against still exists in code — see "How this
> connects to QuickBooks" below — but its setup instructions and OAuth
> bootstrap tool are archived, not deleted, in `archive/` at the project
> root (two folders up from this one). You won't need anything in that
> folder to follow this guide.)
>
> This doc now lives in `tools/qbwc-agent/QuickBooks Sync Agent/`, alongside
> the files it actually walks you through. `Code1.4.gs` (Step 1) is bundled
> here too so this folder zips up complete; the canonical copy is the one in
> the project root, and the two are kept byte-identical. See `README.md` in
> this same folder for what every file here does.

## What this does

Reads **TimeActivity** records out of QuickBooks Desktop and writes actual
hours per person, per project, per month into a new **Hours Actual** tab, then
splits the same hours by whether they have reached an invoice yet. The
`Current` tab is never modified.

Seven tabs get created:

| Tab                | Purpose                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| **Hours Actual**   | The report. Same project/person rows as `Current`, one column per past month, plus a Billed / Unbilled / Non-billable / No Status split of those same months. Rebuilt on every refresh. |
| **Hours Billed**   | The same grid, restricted to hours QuickBooks has marked `HasBeenBilled` — already pulled onto an invoice. Adds a project-to-date total and a rate-based dollar estimate. |
| **Hours Unbilled** | The same grid again, restricted to hours marked `Billable` that no invoice has taken yet.                |
| **Map Projects**   | Links each project name in `Current!A` to a QuickBooks customer/project.                                |
| **Map People**     | Links each last name in `Current!C` to a QuickBooks employee or vendor.                                 |
| **QBO Time Raw**   | Every time entry pulled, unaggregated. For auditing a number that looks wrong.                          |
| **QBO Unmapped**   | Hours that exist in QuickBooks but have no row to land on. **Check this every refresh.**                |

### Billed vs. unbilled — how to add them up

`Hours Billed` + `Hours Unbilled` = everything chargeable that has been worked.
**Do not add either of them to `Hours Actual`**, which already contains both
(plus non-billable time). The four split columns on `Hours Actual` add up to
its Total Hours column, so the parts are always visible rather than assumed.

"Billed" here means QuickBooks' own `HasBeenBilled` status, which QuickBooks
sets when the entry is pulled onto an invoice via **Add Time/Costs**. Time on
an invoice raised some other way — a fixed-fee progress billing typed in by
hand, for example — will *not* carry that status, and will read as unbilled.
Check one project you know has been invoiced before trusting the split.

The dollar columns on those two tabs are **hours × the rate in `Current!S`**.
That is an estimate of value delivered, not the amount actually invoiced; on
Fixed Fee projects (`Current!Q`) the invoice does not follow hours at all. The
hand-maintained **Funds Remaining** on `Current` remains the number to trust
when the two disagree.

The project-to-date totals reach only as far back as the agent pulled — see
*Keep the agent's window wide enough* below. Each of those column headers is
labelled with the real earliest date in the data, so a partial total never
passes for a lifetime one.

Every hour read from QuickBooks ends up either on **Hours Actual** or on
**QBO Unmapped** — never nowhere. Three things land a row on Unmapped:

- the project isn't mapped to a QuickBooks customer yet;
- the person isn't mapped to a QuickBooks employee or vendor yet;
- both are mapped, but **`Current` doesn't list that person under that project**.
  This one is normal and expected — staffing drifts from the plan. Add the person
  as a row under that project on `Current` and refresh again, and the hours move
  onto the report.

## What it does *not* do

**Contract Value (col R) and Funds Remaining (col N) are not in QuickBooks.**
There is no such field. They stay manually maintained on `Current`; the report
tab just references them (`=Current!R3`) so they display alongside the hours and
stay in sync.

Columns D–I on `Current` are **estimates** (per the Legend) and are left alone.

## How this connects to QuickBooks

QuickBooks Desktop has no REST API and no OAuth — there's nothing to apply
for or get reviewed, unlike QuickBooks Online. The only way to read data out
of it programmatically is **qbXML**, relayed through Intuit's free
**QuickBooks Web Connector (QBWC)**, which has to run on the same Windows
machine as QuickBooks Desktop itself.

The shape of it:

```
QuickBooks Desktop  <--(local, same machine)-->  QuickBooks Web Connector
                                                          |  SOAP, localhost only
                                                          v
                                          server1.3.js (Node, this folder)
                                          pulls Customer/Employee/Vendor/
                                          TimeTracking via qbXML
                                                          |  HTTPS POST
                                                          v
                                          This Sheet's Apps Script (Code1.4.gs)
                                          writes QBD Customers / QBD People /
                                          QBD Time
```

`Code1.4.gs` is Desktop-only now — the QuickBooks Online path (REST + OAuth2,
a `QBO_SOURCE` toggle) it used to also support has been removed since
ConSysTec only has Desktop. See the note at the top of this doc if Online is
ever needed again.

---

## Step 1 — Install the script

1. Open the Google Sheet → **Extensions → Apps Script**.
2. Delete whatever stub is in the editor's `Code.gs`, paste in the contents
   of `Code1.4.gs` (in this folder, or the identical copy in the project
   root), and **Save** (Ctrl+S / the save icon).
3. Reload the Google Sheet in your browser. A **QuickBooks** menu should now
   appear in the Sheet's own menu bar, next to Help.

   > The project root also has `Code.gs`, `Code1.1.gs`, `Code1.2.gs`, and
   > `Code1.3.gs`. Despite the plain name, `Code.gs` is the *oldest* of the
   > five and every one of them is missing fixes present by 1.4 — 1.3 has no
   > billed/unbilled split at all. `Code1.4.gs` is the one to use. See
   > `README.md` in this folder for what's current across every file in this
   > project, not just this one.

Everything from here on happens through that **QuickBooks** menu, in the
Google Sheet — not inside the QuickBooks Desktop application. It's easy to
conflate the two since the menu is named "QuickBooks"; just remember it's a
menu this script added to your spreadsheet.

## Step 2 — Deploy the script as a Web App

The local agent (Step 4) needs a URL to push data to.

1. Still in **Extensions → Apps Script**: **Deploy → New deployment**.
2. Type: **Web app**. **Execute as: `Me`. Who has access: `Anyone`.** — both
   exactly as written; get either wrong and this breaks in a way that's hard
   to diagnose (see below).
3. **Deploy**, authorize the requested permissions, and copy the URL ending
   in `/exec`. That's your `APPS_SCRIPT_URL`.
4. Paste that URL into **both** of the following, or QuickBooks pushes will
   404 silently:
   - the `$env:APPS_SCRIPT_URL` line in `Sync QuickBooks Hours.ps1`, in
     this folder;
   - the example in Step 4 below, so this doc stays accurate for next time.

**Current URL (as of the last redeploy):**
```
https://script.google.com/macros/s/AKfycbzjYKhai8yyCYq8JbNPGS_crPqXvvbqJGewm-SKxPRehiWt_qtmrG1vDcaUJt9oyab4ww/exec
```

("Anyone" sounds looser than it is — the URL itself is long and unguessable,
and the script additionally checks a shared secret (Step 3) against every
request before writing anything, so an unauthenticated stranger finding the
URL still can't push data without that secret.)

**Why `Execute as: Me` specifically matters:** `Code1.4.gs`'s `doPost` and
`doGet` both resolve the spreadsheet via `resolveSpreadsheet_()`, which tries
`SpreadsheetApp.getActive()` first. If the deployment instead runs as
"User accessing the web app," an anonymous local agent carries no Google
identity at all, `getActive()` has permission to nothing, and every push
fails — with no symptom other than a generic failure in the agent's log.
`Execute as: Me` is what makes the Web App run with *your* Google identity
regardless of who (or what script) is calling it.

**If you ever redeploy:** editing `Code1.4.gs` and hitting Ctrl+S does
**not** change what the live `/exec` URL serves — Apps Script Web Apps are
pinned to a saved deployment. Use **Manage deployments → Edit → New
version** to update the *existing* URL in place. Only use **New deployment**
if you specifically need a new URL — doing so means updating it in the two
places listed above, or the agent will keep pushing to the old, dead URL
with no error until someone notices `Hours Actual` has gone stale.

## Step 3 — Save Credentials

Back in the Google Sheet (not QuickBooks Desktop): **QuickBooks → Setup →
Save Credentials**.

It prompts for one value:

- **QBD_PUSH_SECRET** → make up a long random string (e.g. run
  `node -e "console.log(require('crypto').randomUUID())"` anywhere you have
  Node installed). You'll paste this exact value into the local agent's
  config in Step 4.

## Step 4 — Run the local agent

On the Windows machine that has QuickBooks Desktop installed, run the
packaged launcher in this same folder — that's what should actually be sent
to whoever runs the day-to-day sync (email it or drop it in Drive as
`QuickBooks Sync Agent.zip`, one level up):

1. Double-click **`Sync QuickBooks Hours.bat`**.

   > It is the `.bat`, not the `.ps1`. Double-clicking the `.ps1` opens it
   > in a text editor instead of running it (a Windows default, not a bug),
   > and right-click → **Run with PowerShell** fails outright on a folder
   > that was extracted from a `.zip` — see **If the window flashes and
   > closes** below. The `.bat` handles both cases.

2. It checks Node.js is installed (and explains how to install it if not),
   starts the agent with the URL and secret already baked in, confirms it
   actually came up, then prints the two things you still have to click by
   hand — QBWC's **Update Now** and the Sheet's **Refresh Hours** — see
   Steps 5 and 6 below for what those actually do.
3. Leave it running until both of those are done, then press Enter in that
   window to stop it — it's a local SOAP server that QuickBooks Web
   Connector calls into on its own schedule, so it does nothing while
   you're not actively syncing.

The URL and secret are hardcoded near the top of that script
(`$env:APPS_SCRIPT_URL` / `$env:QBD_PUSH_SECRET`) so nobody running it day
to day has to touch either. If you rotate the secret or redeploy to a new
URL, that's the one line to update — see Step 2's warning about what breaks
if it's stale.

### If the window flashes and closes

Almost always **Mark of the Web**. Extracting this folder from a downloaded
`.zip` makes Windows tag every file inside as internet-sourced; PowerShell
whose execution policy is `RemoteSigned` then refuses to load the `.ps1`
*before its first line runs*, so nothing is printed and no log is written.

Two fixes, either one works:

- **Use `Sync QuickBooks Hours.bat`** (Step 4.1). It unblocks the folder and
  bypasses the policy, so it works on a freshly-extracted copy.
- **Unblock the `.zip` before extracting:** right-click it → **Properties**
  → tick **Unblock** → **OK**, then extract. This clears the tag for
  everything inside at once.

To confirm this is what happened, run in PowerShell:

```powershell
Get-Item ".\Sync QuickBooks Hours.ps1" -Stream Zone.Identifier
```

If that prints a `[ZoneTransfer] ZoneId=3` block, the file is blocked. Clear
it for the whole folder with:

```powershell
Get-ChildItem -File | Unblock-File
```

**If the window stays open and shows an error instead**, that is the
launcher working as intended — read the message, and send `sync-log.txt` and
`agent-output.txt` (both written next to the launcher on every run) to
Chris.

<details>
<summary>Running it manually instead (only needed for debugging)</summary>

```powershell
$env:APPS_SCRIPT_URL="https://script.google.com/macros/s/AKfycbzjYKhai8yyCYq8JbNPGS_crPqXvvbqJGewm-SKxPRehiWt_qtmrG1vDcaUJt9oyab4ww/exec"
$env:QBD_PUSH_SECRET="abc123"
node server1.3.js
```

(If you're running this from a Unix shell instead — e.g. Git Bash — the
syntax is `APPS_SCRIPT_URL=... QBD_PUSH_SECRET=... node server1.3.js` on one
line. PowerShell does **not** support that inline form; setting `$env:`
variables first, as above, is required there.)

Two things that will silently break this if wrong: the URL must be the
actual one you copied in Step 2, not a placeholder — a wrong or unreplaced
URL just means every push 404s. And the secret must be *character-for-
character* identical to what you entered in Save Credentials — a mismatch
makes `doPost` reject every push as "Forbidden," with no other symptom.

</details>

## Step 5 — Register the connector with QuickBooks Web Connector

1. Open `connector.qwc` (this folder) and confirm `AppURL` matches the
   port the agent is listening on (default `http://localhost:8090/` — fine
   as plain HTTP, since QBWC and the agent run on the same machine and this
   is never reachable from outside it).
2. In QuickBooks Desktop, open **File → App Management → Update Web
   Services** (or launch QuickBooks Web Connector directly if it's already
   installed — it ships with QuickBooks Desktop).
3. **Add an Application**, browse to `connector.qwc`, and confirm.
4. QuickBooks Desktop will ask you to authorize the app for that company
   file — approve it (matches the Employee/Vendor/Customer/TimeTracking
   read-only scope in `AppDescription`).
5. QBWC will ask you to set a password for the `consystec-sync` user shown
   in the connector row — any password works, the agent doesn't check it;
   it's QBWC's own login gate, not this integration's.
6. Check the box next to the connector and click **Update Now** to run a
   sync immediately (or set an auto-run interval in QBWC's own scheduler).

## Step 6 — Confirm and refresh

Back in the Google Sheet: **QuickBooks → Test Connection** should report the
last time data was received from the agent. If it says nothing's arrived
yet, check the agent's terminal output for errors and confirm QBWC's log
(in the Web Connector app) doesn't show an authorization or connection
error.

Once data has landed:

1. **QuickBooks → Rebuild Mapping Tabs.** `Current!C` holds last names
   (`Chan`, `Lahiri`) while QuickBooks holds full names, and QuickBooks
   Projects are stored as *sub-customers* — so a project may appear as
   `ITE:NTCIP Compliance Testing`. The script guesses the obvious matches
   and **highlights the rest in yellow**. For every yellow row, pick the
   right value from the dropdown in column B; a row left blank means those
   hours land on **QBO Unmapped** instead of the report. Rebuilding later
   never overwrites a name you chose by hand, so it's safe to re-run
   whenever a project or a person is added to `Current`.
2. **QuickBooks → Refresh Hours.** You'll get a summary: how many entries
   were read, how many hours landed on the report, how many were skipped.
   **If the skipped number isn't zero, open QBO Unmapped** — it says which
   project or person needs mapping.

Default history is **1 January of two years ago through the last complete
month** (run in 2026, that is Jan 2024 onward). The in-progress month is
deliberately left out, since a partial month next to full ones invites bad
comparisons. The window is anchored to a year boundary, not a rolling month
count, so it steps forward one whole year each January and the oldest year on
the report is always complete. Override it with an explicit month count under
**Setup → Set Months Of History**.

## Keep the agent's window wide enough

The sync agent pulls **5 whole calendar years** — from 1 January of five
years ago — automatically (`YEARS_BACK` in `server1.3.js`, default `5`),
matching `GRID_YEARS - 1` (`Code1.6.gs`, `GRID_YEARS = 6`). The live
`test_current` sheet has been widened to match — the 24 extra columns
inserted and the header formulas extended — so the grid actually reaches 5
years back. Every push still fully replaces the `QBD Time` sheet, so if the
Sheet's grid is ever widened past what the agent pulled, the oldest months
would silently come back empty — an unattended sync that silently drops
hours is worse than no sync at all. Widen `YEARS_BACK` first, then the grid.

### …but not wider than the row cap

qbXML is **not paginated**, so entries older than the grid still count
against the row cap below even though `refreshHours()` excludes them from
`test_current` — reported instead as "unplaced" in the Refresh Hours alert.
The obvious move is to set the window very wide — and that is a trap.

qbXML is **not paginated**. It returns at most `MAX_RETURNED.TimeTracking`
rows (`server1.3.js`) and gives no indication whatsoever that it truncated.
ConSysTec logs roughly **530 time entries a month**, so the old 10000-row cap
was only ~19 months of headroom. Both numbers have been raised together:

| Setting                       | Where                        | Value   |
| ----------------------------- | ---------------------------- | ------- |
| `YEARS_BACK`                  | `server1.3.js`               | `5`     |
| `MAX_RETURNED.TimeTracking`   | `server1.3.js`               | `50000` |
| `QBD_TIME_ROW_CAP`            | `Code1.6.gs`                 | `50000` |

`YEARS_BACK = 5` reaches ~5.7 years back (to 1 Jan five years ago, plus this
year to date) ≈ 36000 entries, comfortably inside 50000 — roughly 8 years is
the ceiling. **Never raise `YEARS_BACK` without checking it still fits**, and
keep the last two numbers equal — the Sheet re-checks the row count at read
time and puts a warning at the top of the Refresh Hours alert if it comes back
at or near the cap, which is the only safety net there is.

Two ways to tell the window is actually wide enough: the **Billed Hours
Since …** column header always names the real earliest date in the data, and
that alert warns you if truncation is suspected.

## What's not supported yet

Time entries logged against QuickBooks Desktop's "Other Names" list (people
who are neither an Employee nor a Vendor) aren't resolved to a person yet —
they land on `QBO Unmapped` as an unresolved entry rather than being
misattributed to the wrong person. If `QBO Unmapped` shows entries like that
after a real sync, that's the signal this is actually needed for ConSysTec
and worth adding.

---

## Troubleshooting

**Nothing shows up after "Update Now" in QuickBooks Web Connector** — check
the agent's terminal window first; it logs every SOAP call and qbXML
request/response it handles. Then check QBWC's own log (the Web Connector
app has a log tab) for an authorization or connection error on the
QuickBooks Desktop side.

**"Found 0 time entries" / hours look low** — check the `QBO Time Raw` tab.
Every entry the agent pulled is there with its date, person, project, and
billable status. If an entry is present in Raw but missing from the report,
it's a mapping problem, and `QBO Unmapped` says why. If Raw itself is empty,
confirm QBWC actually ran (Step 5.6) and that the agent's window
(`YEARS_BACK` in `server1.3.js`, 3 calendar years by default) covers the
dates you expect.

**A person's hours are missing even though they're in QuickBooks** — likely
an "Other Names" entry; see "What's not supported yet" above.

## Two limitations worth knowing

**Duplicate last names.** `Current` identifies people by last name only, one
row per person per project. If QuickBooks ever holds two people with the
same last name, the sheet has no way to keep them apart — the mapping tab
forces a single choice. Splitting them would mean changing column C to full
names.

**Row 71 on `Current`** has an hourly rate in column S but no name in column
C — an orphaned leftover row. It's harmless and the script skips it, but you
may want to delete it.

## A note on automation

Once the numbers are trusted, **Refresh Hours** can run nightly on its own
(**Apps Script → Triggers → Add Trigger → `refreshHours`, time-driven**).
Hold off until a manual refresh has produced a clean run with zero unmapped
hours. The local agent and QuickBooks Web Connector have their own separate
schedule (Step 5.6) — both need to run before an automated `refreshHours`
would see new data.
