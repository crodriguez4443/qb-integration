# What's what

This project has four moving parts, split across two machines: the cloud
(Google) and the Windows PC that runs QuickBooks Desktop. This doc explains
what each file does and where it lives. For the step-by-step install, see
[SETUP.md](SETUP.md), right alongside this file.

This README and SETUP.md live in the same folder as every file the
integration uses — the three that actually run (`server1.3.js`,
`connector.qwc`, `Sync QuickBooks Hours.ps1`), plus `Code1.6.gs`, the source
copy of the Apps Script — so the whole thing can be understood from one
folder. `Code1.6.gs` is not run locally; it's the copy you paste into the
Google Sheet's Apps Script editor.

```
QuickBooks Desktop  <--(same machine)-->  QuickBooks Web Connector
                                                  |
                                    reads connector.qwc to find server1.3.js
                                                  |  SOAP, localhost only
                                                  v
                                  tools/qbwc-agent/.../server1.3.js  (Node)
                                                  |  HTTPS POST
                                                  v
                                       Code1.6.gs  (Google Apps Script,
                                       lives inside the Google Sheet)
```

## `Code1.6.gs` — the Sheet's brain

**Lives in:** the Google Sheet itself, under **Extensions → Apps Script**
(pasted in as that project's `Code.gs`); the source copy, `Code1.6.gs`, sits
in this folder alongside this README. It is not a file you run locally —
Google hosts and runs it.

**What changed since the docs' last big revision:** the two mapping tabs
(`Map Projects`, `Map People`) are gone. `test_current` column B now holds
the full QuickBooks DisplayName ("Chan, Patrick"), so it joins straight to
`QBD People` column B; and `QBD Customers` column D tags each customer with
the project it rolls up to, matching the project names in `test_current`
column A. Both joins are now exact text — no fuzzy guessing, nothing to
rebuild. A customer with a blank column D is simply skipped (its hours are
reported as untagged, never silently lost). The QuickBooks Online code path
is also fully removed — Desktop only — with the last dual-mode version kept
in `archive/`.

This is the only piece with a user interface — everything in the Sheet's
**QuickBooks** menu is a function in this file:

- **Refresh Hours** — reads the `QBD Time` sheet (see below), matches each
  entry to a project/person on `test_current`, and writes the hours straight
  into that tab's month grid. There is no separate report tab: the numbers
  land in the grid itself, and font weight/color mark how much of each cell
  QuickBooks has already billed (bold = every hour billed; bold, `#cc33b3` =
  billed hours mixed with unbilled or non-billable; plain `#cc33b3` = nothing
  billed yet). Months outside the synced window, spacer rows, and the
  hand-maintained forward-estimate columns are read and written back
  untouched. The run ends in an alert summarising what landed and what
  didn't.
  Since v3.2 the same click also does three more things:
  - **Adds missing people.** Anyone QuickBooks shows hours for on a project,
    in a complete month inside the grid, who has no row under that project
    gets one. The row is a copy of an existing person row with every typed
    value cleared, so it keeps the formulas and formatting the other rows
    have. It is inserted just above the block's last person row, because
    Sheets only stretches a block's `SUM` ranges for a row inserted *inside*
    them. Rate is left blank for you to fill in. Switch off with
    `ADD_MISSING_PEOPLE`.
  - **Total cost rollup (column BX).** Each project's first row gets its
    total cost to date: everything invoiced (invoices minus credit memos)
    plus hours QuickBooks marks `Billable` but not yet invoiced, through the
    last complete month, priced at each person's Rate. Each BX cell carries
    a note with its own breakdown, including each QuickBooks customer
    feeding it (dollars and hours). Two rules decide which invoices count:
    - *From when:* the block's **Start Date (column CH)**. Earlier invoices
      on the same customers — last year's contract, a client invoiced
      directly years ago — are left out and listed in the alert. A blank
      Start Date counts everything; `COST_ROLLUP_START` overrides per
      project.
    - *To which project:* hours are logged on tasks and invoices are raised
      on the job above them, so an invoice follows the tags on the **tasks
      beneath its job**, not the job's own row. A job tagged to a project
      none of its tasks carry is reported as **WRONG TAG** and kept out of
      that project. A job whose tasks belong to two blocks (NYSDOT 4502 →
      ICF Task 3 and Task 5) is split between them by the hours each logged
      around the invoice date — an estimate, and marked as one.
  - **Funds Remaining (column CB).** Written as the formula
    `Contract Value − BX` on each project's first row. QuickBooks Desktop has
    no such figure of its own. Rows with no numeric Contract Value, and cells
    holding some other formula, are left alone. Switch off with
    `WRITE_FUNDS_REMAINING`.
- **Explain Cost Rollup (selected project)** — read-only. Select any cell in
  a project's block and it lists which QuickBooks customers feed that
  project's BX, how much each contributes over what dates, the hours logged
  on each, what was left out, and the counted invoices themselves by number.
  The first place to look when a rollup seems wrong.
- **Check Project Tags** — read-only health check, replacing the old
  "Rebuild Mapping Tabs". Reports which `test_current` project blocks have no
  matching customer tag, which customers carry no tag in `QBD Customers`
  column D, and any person on `test_current` who matches no `QBD People`
  name.
- **Show Last QuickBooks Sync** — when the Sheet last received data from the
  agent, how many rows each `QBD` tab holds, and the newest time entry and
  invoice dates in them. (Was "Test Connection"; it never tested anything.)
- **Setup → Save Credentials** — stores `QBD_PUSH_SECRET` as a script
  property (checked against every push), and records the spreadsheet's ID as
  `QBD_SPREADSHEET_ID` so `doPost`/`doGet` can still find the sheet when
  `SpreadsheetApp.getActive()` can't.

(There is no longer a "Set Months Of History" item — how far back the report
reaches is set entirely by the agent's `YEARS_BACK`, below.)

It also has to be **deployed as a Web App** (Deploy → New deployment) so it
has a public `/exec` URL — that's the endpoint `server1.3.js` posts to.
`doPost()` is the receiving end: it checks the posted `secret` against the
saved `QBD_PUSH_SECRET`, and if it matches, writes the incoming
customers/people/time entries into three raw staging sheets (`QBD
Customers`, `QBD People`, `QBD Time`). Column D of `QBD Customers` — the
hand-maintained project tag — is read back and rewritten on every push, so a
sync never erases it. Nothing from QuickBooks lands on the `test_current`
grid directly; that only happens when someone clicks **Refresh Hours**,
which reads those staging sheets.

`doGet()` returns the deployed `SCRIPT_VERSION` plus a few diagnostics as
JSON: open the `/exec` URL in any browser to confirm which version is
actually live, whether a secret is saved, and whether the script can reach
the spreadsheet — no QuickBooks or agent needed.

`SCRIPT_VERSION` (currently `'3.4'`) is echoed back in every response
specifically so "is the deployed Web App actually running this version?" is
answerable from outside the Apps Script editor — pasting new code in and
saving does **not** update what the live `/exec` URL serves; that requires a
new deployment (or updating the existing one) each time this file changes.

> Note: `archive/` at the project root holds the older cuts — `Code.gs` (the
> oldest; predates `SCRIPT_VERSION` entirely) through `Code1.4.gs`, plus the
> dual Online/Desktop version. All are missing fixes present by `Code1.6.gs`,
> the mapping-tab removal among them. `Code1.6.gs` in this folder is the one
> actually pasted into Apps Script. Ignore the rest unless diffing history.
>
> The deployed Web App URL and the `QBD_PUSH_SECRET` it checks are set up in
> [SETUP.md](SETUP.md) Steps 2–3 — including why the deployment's **Execute
> as: Me / Who has access: Anyone** settings specifically matter for
> `resolveSpreadsheet_()` to work.

## `connector.qwc` — QuickBooks Web Connector's registration file

**Lives in:** this folder (a copy also sits one level up, in
`tools/qbwc-agent/` itself) — on the **Windows PC with QuickBooks Desktop**.

Not code — a small XML file. QuickBooks Web Connector (QBWC, the Intuit app
that lets outside programs talk to QuickBooks Desktop) reads it once, during
**Add an Application**, to learn three things: the app's name (`ConSysTec
Hours Sync`), where to find it (`http://localhost:8090/` — `server1.3.js`'s
address), and that it only needs read-only access. After that one-time
registration, QBWC remembers it; the file itself isn't touched again unless
the port or app name changes.

## `server1.3.js` — the local agent

**Lives in:** this folder (and the same file, same content, sits one level
up in `tools/qbwc-agent/` — that copy is the dev/source copy; the one in
this folder is what actually ships to the admin). Runs on the **Windows PC
with QuickBooks Desktop**, via Node.

This is the only piece that speaks to QuickBooks Desktop directly, and the
only way to do that at all — QuickBooks Desktop has no REST API. It runs a
small local SOAP server that QBWC calls into on its own schedule (or on
**Update Now**). Each session it: pulls Customers, Employees, Vendors, and
TimeActivity entries via qbXML, then does one outbound HTTPS POST of all of
it, plus the shared `secret`, to `Code1.6.gs`'s `/exec` URL.

The TimeTracking pull is date-bounded to whole calendar years: `YEARS_BACK`
(default 5) means "from 1 January of five years ago." qbXML is not
paginated and gives no signal when it truncates, so the agent caps
TimeTracking at `MAX_RETURNED.TimeTracking` (50000 rows, ~8 years at
ConSysTec's measured rate) and prints a loud banner whenever a query comes
back *exactly* full — the only available evidence that rows were dropped.
Keep `QBD_TIME_ROW_CAP` in `Code1.6.gs` equal to that number; the Sheet
re-checks it at read time.

`GRID_YEARS` in `Code1.6.gs` is `6`, so `GRID_YEARS - 1` (`5`) matches the
agent's pull depth, and the six fixed columns after the grid
(`COL_HOURS_ROLLUP` → col 76, `COL_FUNDS_REMAINING` → 79, `COL_AS_OF` → 81,
`COL_TYPE` → 82, `COL_CONTRACT_VALUE` → 83, `COL_RATE` → 84) have been
shifted right by 24 columns in the code to match. Those 24 columns have
already been inserted into the live `test_current` sheet, its header
formulas extended to match, and the old per-cell background fill (from
before billed status moved to bold/font-color styling — see above) cleared
by hand.

v3.1 / agent v1.4: a "Previous years cost rollup" column was inserted at BX
(col 76), shifting everything after it right by one more
(`COL_HOURS_ROLLUP` → 77, `COL_FUNDS_REMAINING` → 80, `COL_AS_OF` → 82,
`COL_TYPE` → 83, `COL_CONTRACT_VALUE` → 84, `COL_RATE` → 85). The agent now
also pulls every Invoice and CreditMemo (no date bound) into a
`QBD Invoices` tab, and **Refresh Hours** wrote each project's net billed
dollars dated before 1 January of the A1 year into BX on its first row.
Keep `QBD_INVOICE_ROW_CAP` in `Code1.6.gs` equal to `MAX_RETURNED.Invoice`
(20000).

v3.2 (agent unchanged, still v1.4): BX is now the *total* cost to date
rather than prior years only, and the constant is renamed
`COL_PREV_YEARS_BILLED` → `COL_COST_ROLLUP` (still col 76). Billed work
still comes from invoice amounts, not hours × rate, because rates change
yearly; only the not-yet-invoiced hours are priced at today's Rate. The
header cell is renamed to "Total cost rollup" if it still reads "Previous
years cost rollup". Any sheet formula that adds this year's cost on top of
BX will now double-count and needs adjusting.

v3.4 (agent unchanged, still v1.4): BX numbers change. Invoices count from
the block's Start Date (new constant `COL_START_DATE`, col 86 / CH) instead
of from the project's first logged hours, and an invoice is charged to the
project(s) its job's tasks are tagged to rather than to the job's own tag.
The BX note and Explain Cost Rollup show each customer's dollars beside its
hours. v3.3's CHECK flag and `COST_ROLLUP_FROM_HOURS` are removed. Menu:
"Test Connection" became "Show Last QuickBooks Sync" and "Show Sample Time
Entries" is gone.

Most of what this agent does after the POST is scrutinise the reply. A
broken Apps Script deployment answers HTTP 200 with an HTML error page or a
Google login page, so the status code alone cannot tell success from total
failure — the agent classifies the response body and prints an unmissable
banner, with the specific fix, for each failure mode, rather than letting a
"200" scroll past as if it worked.

Reads its configuration entirely from environment variables — no config
file — which is why the launcher script below exists: to set those
variables (`APPS_SCRIPT_URL`, `QBD_PUSH_SECRET`, and optionally `QBWC_PORT`,
`YEARS_BACK`, `QBXML_VERSION`) and start it without the admin ever touching
`node` or an env var directly. It does nothing on its own; it only reacts
when QBWC calls it.

> Same naming trap as `Code.gs` above: the older `server.js` / `server1.1.js`
> / `server1.2.js` are stale (kept under `archive/`). `server1.3.js` is
> current — its header notes the qbXML side is verified working end to end.
> v1.3 is a rename of v1.2 with identical code; the version bump exists so
> the filename, `AGENT_VERSION`, and these docs all agree.

## `Sync QuickBooks Hours.ps1` — the admin-facing launcher

**Lives in:** this folder, alongside `server1.3.js`, its `node_modules`, and
`connector.qwc` — this whole folder (zipped as `QuickBooks Sync Agent.zip`
one level up) is what actually gets sent to the non-technical admin, to
unzip anywhere on their machine (Desktop is fine). This README and
`SETUP.md` are along for the ride too, but are for you, not the admin — they
don't need to open either.

The admin does not run this file directly any more — they double-click
**`Sync QuickBooks Hours.bat`**, which unblocks the folder and then runs
this script. See that file's own comments for why, or the note below. The
old way (right-click → **Run with PowerShell**) still works on a folder
that has already been unblocked. This script:

1. Checks Node.js is installed, and explains how to install it if not.
2. Sets `APPS_SCRIPT_URL` and `QBD_PUSH_SECRET` (baked in, so the admin
   never sees or edits them) and starts `server1.3.js`.
3. Confirms it actually came up, then prints the two manual steps the admin
   still has to do by hand — click **Update Now** in QuickBooks Web
   Connector, then **QuickBooks → Refresh Hours** in the Sheet — since
   nothing here can trigger those from outside their own apps.
4. Waits for Enter, then stops the agent cleanly.

It also writes two log files next to itself on every run — `sync-log.txt`
(the launcher's own output and any error) and `agent-output.txt` (everything
`server1.3.js` prints, including the push-failure banners). Those exist so a
failure is still readable after the window is gone; ask the admin for them
before asking them to describe what they saw.

## `Sync QuickBooks Hours.bat` — the double-click front door

**Lives in:** this folder, next to the `.ps1` it launches.

Exists for one reason: **Mark of the Web**. When this folder is sent as a
`.zip` and extracted, Windows tags every file inside as internet-sourced. On
a machine whose PowerShell execution policy is `RemoteSigned` (a common
default), PowerShell then refuses to load the `.ps1` *before its first line
runs* — so the window flashes and closes, no error is readable, and none of
the `.ps1`'s own logging or error handling gets a chance to fire. Batch files
are not subject to execution policy, so this one can clear the tag
(`Unblock-File`) and then start the launcher with `-ExecutionPolicy Bypass`.

The equivalent manual fix, if you would rather not ship the `.bat`:
right-click the `.zip` → **Properties** → **Unblock** → **OK**, *before*
extracting. That clears the tag for everything inside in one step.

It has no logic of its own beyond that — all the real work is in
`server1.3.js` and `Code1.6.gs`.
