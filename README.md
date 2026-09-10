# What's what

This project has four moving parts, split across two machines: the cloud
(Google) and the Windows PC that runs QuickBooks Desktop. This doc explains
what each file does and where it lives. For the step-by-step install, see
[SETUP.md](SETUP.md), right alongside this file.

This README and SETUP.md both live in `tools/qbwc-agent/QuickBooks Sync
Agent/` — next to the three files that actually run (`server1.3.js`,
`connector.qwc`, `Sync QuickBooks Hours.ps1`) — so the whole integration can
be understood from one folder. `Code1.3.gs` is the one exception: it has to
live in the project root (two folders up), since that's where the rest of
the Google Sheet project lives.

```
QuickBooks Desktop  <--(same machine)-->  QuickBooks Web Connector
                                                  |
                                    reads connector.qwc to find server1.3.js
                                                  |  SOAP, localhost only
                                                  v
                                  tools/qbwc-agent/.../server1.3.js  (Node)
                                                  |  HTTPS POST
                                                  v
                                       Code1.3.gs  (Google Apps Script,
                                       lives inside the Google Sheet)
```

## `Code1.3.gs` — the Sheet's brain

**Lives in:** the Google Sheet itself, under **Extensions → Apps Script**
(pasted in as that project's `Code.gs`); the source copy, `Code1.3.gs`, sits
in the project root (two folders up from this README). It is not a file you
run locally — Google hosts and runs it.

This is the only piece with a user interface — everything in the Sheet's
**QuickBooks** menu is a function in this file:

- **Refresh Hours** — reads the `QBD Time` sheet (see below), matches each
  entry to a project/person on `Current` using the mapping tabs, and rewrites
  `Hours Actual`.
- **Rebuild Mapping Tabs** — refreshes `Map Projects` / `Map People`,
  guessing the obvious name matches and highlighting the rest for a manual
  pick.
- **Test Connection** / **Show Sample Time Entries** — diagnostics.
- **Setup → Save Credentials** — stores `QBD_PUSH_SECRET` as a script
  property, so it can be checked against every push.
- **Setup → Set Months Of History** — how far back Refresh Hours looks.

It also has to be **deployed as a Web App** (Deploy → New deployment) so it
has a public `/exec` URL — that's the endpoint `server1.3.js` posts to.
`doPost()` is the receiving end: it checks the posted `secret` against the
saved `QBD_PUSH_SECRET`, and if it matches, writes the incoming
customers/people/time entries into three raw staging sheets (`QBD
Customers`, `QBD People`, `QBD Time`). Nothing from QuickBooks lands directly
on `Hours Actual` — that only happens when someone clicks **Refresh Hours**,
which reads those staging sheets.

`SCRIPT_VERSION` (currently `'1.3'`) is echoed back in every response
specifically so "is the deployed Web App actually running this version?" is
answerable from outside the Apps Script editor — pasting new code in and
saving does **not** update what the live `/exec` URL serves; that requires a
new deployment (or updating the existing one) each time this file changes.

> Note: the project root also has `Code.gs`, `Code1.1.gs`, and `Code1.2.gs`.
> Despite the plain name, `Code.gs` is the *oldest* of the four — it predates
> `SCRIPT_VERSION` entirely and is missing fixes present by 1.3. `Code1.3.gs`
> is the one actually pasted into Apps Script. Ignore the older three unless
> diffing history.
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
it, plus the shared `secret`, to `Code1.3.gs`'s `/exec` URL.

Reads its configuration entirely from environment variables — no config
file — which is why the launcher script below exists: to set those
variables and start it without the admin ever touching `node` or an
env var directly. It does nothing on its own; it only reacts when QBWC
calls it.

> Same naming trap as `Code.gs` above: `tools/qbwc-agent/server.js` is the
> stale original, with `server1.1.js` and `server1.2.js` as intermediate
> steps. `server1.3.js` is current — its header notes the qbXML side is
> verified working end to end. v1.3 is a rename of v1.2 with identical
> code; the version bump exists so the filename, `AGENT_VERSION`, and
> these docs all agree.

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
`server1.3.js` and `Code1.4.gs`.
