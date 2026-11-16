/**
 * ConSysTec Project Status <-> QuickBooks Desktop
 *
 * Pulls actual hours per person, per project, per month from QuickBooks
 * TimeActivity records - via the local Web Connector agent in
 * tools/qbwc-agent/, since QuickBooks Desktop has no REST API - and writes
 * them to an "Hours Actual" tab, plus "Hours Billed" and "Hours Unbilled"
 * tabs that split the same time by QuickBooks' BillableStatus: hours already
 * pulled onto an invoice vs. hours that are chargeable but not invoiced yet.
 * Those two are what answer "how much of this contract is left?" - "Hours
 * Actual" contains both and must not be added to either.
 *
 * On "test_current", current and future month columns are forward-looking
 * estimates and are never written. Contract Value (CF), As Of (CD) and Rate
 * (CG) are manually maintained and are only referenced, never overwritten.
 *
 * ---------------------------------------------------------------------------
 * v3.4 - the cost rollup no longer charges one project with another's
 * invoices. Two causes, both in how an invoice found its project:
 *
 *   Wrong job tag - hours are logged on tasks, invoices are raised on the job
 *                   above them. The job's row in "QBD Customers" carries no
 *                   hours, so nothing showed when its tag was wrong: the NYSDOT
 *                   4502 job was tagged "Puerto Rico" and put that contract's
 *                   billing on the Puerto Rico block. An invoice now follows
 *                   the tags on the tasks beneath its job, a job tag that
 *                   disagrees with all of them is reported, and a job whose
 *                   tasks belong to two blocks is split between them by hours.
 *   Start date    - invoices counted from the project's first logged hours, a
 *                   guess that dropped real invoices on older projects (time
 *                   in QuickBooks starts later than they did) and let last
 *                   year's contract through on newer ones. They now count from
 *                   the block's own Start Date, column CH.
 *
 * See buildCostRollup_ and rollupStart_. v3.3's CHECK flag and
 * COST_ROLLUP_FROM_HOURS are gone - both were workarounds for the above.
 * The note and Explain Cost Rollup still list each customer's dollars beside
 * its hours, and Explain lists the invoices themselves.
 *
 * Menu: "Test Connection" is now "Show Last QuickBooks Sync", which is what it
 * does; "Show Sample Time Entries" is removed.
 *
 * v3.2 - three changes to Refresh Hours:
 *
 *   Cost rollup  - column BX is now the project's TOTAL cost to date, not
 *                  prior years only: everything invoiced, plus billable hours
 *                  not yet invoiced (through the last complete month) x Rate.
 *                  Invoices count from the project's first logged hours, so a
 *                  customer's earlier unrelated billing no longer lands on a
 *                  new project. See buildCostRollup_ and rollupStart_.
 *   Funds        - column CB (Funds Remaining) is written as the formula
 *     remaining    Contract Value - BX. See writeFundsRemaining_. Turn off
 *                  with WRITE_FUNDS_REMAINING.
 *   New people   - a person with hours on a project but no row under it gets
 *                  a row inserted, carrying the formulas the other rows have.
 *                  See addMissingPeople_. Turn off with ADD_MISSING_PEOPLE.
 *
 * New menu item "Explain Cost Rollup" breaks one project's BX down by
 * QuickBooks customer. The agent (server1.3.js v1.4) needs no change.
 *
 * v3.1 - Refresh Hours began filling column BX on each project's first row
 * from the invoices and credit memos agent v1.4+ pushes into "QBD Invoices".
 * It was then "Previous years cost rollup": net dollars invoiced before
 * 1 January of the A1 year.
 * ---------------------------------------------------------------------------
 * v2.0 - the two mapping tabs are gone.
 *
 * v1.x kept "Map Projects" and "Map People" because the old "Current" tab held
 * only staff last names and project labels that had to be guessed against
 * QuickBooks' own customer names. Neither guess is needed any more:
 *
 *   People   - "test_current" column B now holds the full QuickBooks
 *              DisplayName ("Chan, Patrick"), so it joins to "QBD People"
 *              column B exactly, with no fuzzy matching.
 *   Projects - "QBD Customers" column D tags each QuickBooks customer with the
 *              Project it rolls up to, and those values are exactly the project
 *              names in "test_current" column A. One Project covers a whole
 *              tree of customers/sub-customers (Anaheim SMART Grant spans 29),
 *              so the join sums every customer carrying that tag.
 *
 * A customer with a blank column D is skipped, not an error - tag it in
 * "QBD Customers" when you want its hours counted. Its hours still show up on
 * "QBO Unmapped" so nothing disappears silently.
 * ---------------------------------------------------------------------------
 *
 * This file only supports QuickBooks Desktop. It used to also support
 * QuickBooks Online (REST + OAuth2) via a QBO_SOURCE toggle; that path has
 * been removed since ConSysTec only has Desktop. The last version that
 * supported both, plus the Online setup guide, are kept in archive/ (see
 * archive/README.md) in case Online is ever needed again.
 *
 * Setup: see SETUP.md. Menu: QuickBooks > Setup > Save Credentials, then
 * Show Last QuickBooks Sync.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Echoed by doGet() and by every doPost() reply. Its only job is to make
// "which version of this file is actually deployed?" answerable from outside
// the editor - a question that cost real time, because Apps Script Web App
// deployments are pinned to a saved version and editing + Ctrl+S does not
// change what the /exec URL serves. Bump this whenever this file changes.
var SCRIPT_VERSION = '3.4';

var SOURCE_SHEET = 'test_current';

// This script creates no tabs. Hours are written straight into the month grid
// on "test_current", total cost to date into column BX and funds remaining
// into CB; the only other sheets it touches are the four the local agent
// pushes into, below.

// Populated by the local QuickBooks Desktop agent's doPost push; read back
// out by qbdRead_(). See "QuickBooks Desktop" section below.
var QBD_CUSTOMERS_SHEET = 'QBD Customers';
var QBD_PEOPLE_SHEET = 'QBD People';
var QBD_TIME_SHEET = 'QBD Time';
// Invoices and credit memos (agent v1.4+). Credit memos are stored with a
// negative Amount so the column simply sums to net billed.
var QBD_INVOICES_SHEET = 'QBD Invoices';

// Column D of "QBD Customers": which project each QuickBooks customer rolls up
// to. Hand-maintained, and the entire basis of the project join - so doPost()
// below goes out of its way to preserve it across syncs.
var QBD_CUSTOMER_PROJECT_COL = 4;

// Columns on the "test_current" tab.
//
// Row 1 holds the reporting year in A1 (the month headers are CONCAT formulas
// off it); row 2 is the header row; project data starts on row 3.
var SOURCE_HEADER_ROW = 2;
var COL_PROJECT = 1;   // A
var COL_PERSON = 2;    // B - full QuickBooks DisplayName, e.g. "Chan, Patrick"
// Shifted right by 24 columns (from 52/55/57/58/59/60) when GRID_YEARS went
// 4 -> 6: the grid now runs C..BV (72 columns) instead of C..AX (48), so
// everything after it had to move to stay clear. The 24 columns have been
// inserted ahead of these in the live "test_current" sheet to match.
//
// Shifted right by 1 more in v3.1, when "Previous years cost rollup" was
// inserted at BX. Before that shift COL_RATE pointed at Contract Value.
// BX was "Previous years cost rollup" (and this was COL_PREV_YEARS_BILLED)
// until v3.2 made it total cost to date.
var COL_COST_ROLLUP = 76;     // BX - written by refreshHours, project's first row only
var COL_HOURS_ROLLUP = 77;    // BY - only populated on a project's first row
var COL_FUNDS_REMAINING = 80; // CB - written by refreshHours as =CF-BX, first row only
var COL_AS_OF = 82;           // CD
var COL_TYPE = 83;            // CE - CPFF / Fixed Fee / Time & Materials / ...
var COL_CONTRACT_VALUE = 84;  // CF
var COL_RATE = 85;            // CG - $/hour, per person per project
var COL_START_DATE = 86;      // CH - project's first row; where its invoices start counting

// How far right readCurrentLayout_ has to read. Start Date is the last column
// it needs, but naming it separately keeps the range obvious if columns move.
var SOURCE_LAST_COL = COL_START_DATE;

// The month grid: 72 columns starting at C, six calendar years wide, because
// the headers are CONCAT formulas running A1-5 .. A1. Raised from 4 to match
// server1.3.js's YEARS_BACK=5 (see the YEARS_BACK doc comment there) - the
// agent's pull floor and the grid's display floor must agree, or entries the
// agent pulls land as "unplaced" in the Refresh Hours alert instead of on the
// sheet. The live sheet's header formulas have been extended to cover the
// new columns, and the columns after the grid (COL_HOURS_ROLLUP onward,
// already shifted above) physically inserted to match.
var COL_MONTH_FIRST = 3;   // C
var GRID_YEARS = 6;

// How billed each cell is is marked with font weight/color, not fill:
// bold, default color where every hour has been invoiced; bold, #cc33b3
// where billed hours sit alongside unbilled or non-billable ones; plain
// (not bold), #cc33b3 where none of the cell's hours have been billed yet.
var STYLE_BILLED_ONLY = { weight: 'bold', color: '#000000' };
var STYLE_MIXED = { weight: 'bold', color: '#cc33b3' };
var STYLE_UNBILLED = { weight: 'normal', color: '#cc33b3' };
var STYLE_RESET = { weight: 'normal', color: '#000000' }; // no hours at all

function styleKey_(weight, color) {
  return String(weight) + '|' + String(color || '').toLowerCase();
}

// Every (weight, color) pair this script writes, as "weight|color" keys. A
// cell wearing one of these got it from a previous run rather than from the
// sheet's own formatting, so writeGrid_ may overwrite it when a cell that
// used to have hours no longer does - any other styling is left alone.
var MARKER_STYLES = [STYLE_BILLED_ONLY, STYLE_MIXED, STYLE_UNBILLED].map(
  function (s) { return styleKey_(s.weight, s.color); });

// A month inside the sync window with no hours: write nothing (true) or a
// literal 0 (false). The sheet currently holds explicit zeros from an earlier
// process; blanks read more cleanly and sum identically. Flip this if the
// zeros are wanted back. Either way, months OUTSIDE the sync window are never
// touched at all - see writeGrid_.
var BLANK_WHEN_ZERO = true;

// Insert a row for anyone QuickBooks shows hours for on a project who has no
// row under it. false restores the old behaviour: those hours are only named
// in the Refresh Hours alert. See addMissingPeople_.
var ADD_MISSING_PEOPLE = true;

// Write Funds Remaining (CB) as the formula Contract Value - cost rollup on
// each project's first row. This REPLACES a hand-typed number there; a cell
// holding some other formula is left alone. false leaves the column to you.
var WRITE_FUNDS_REMAINING = true;

// A project's invoices count from its Start Date in column CH (see
// rollupStart_). This overrides that per project, without touching the sheet.
// Keyed by the project name in "test_current" column A. A 'yyyy-MM-dd' date
// counts invoices from that day; 'all' counts every invoice on its jobs.
var COST_ROLLUP_START = {
  // 'Some Project': '2024-07-01',
  // 'Another Project': 'all'
};

// MUST match MAX_RETURNED.TimeTracking in tools/qbwc-agent/server1.3.js.
//
// qbXML is not paginated: it returns at most MaxReturned rows and offers no
// "there were more" flag, so a query that hit the cap looks exactly like one
// that did not. The agent logs a warning to its own console when the count
// lands on the cap, but nobody watches that console - and the tabs that would
// be silently short are the ones whose whole job is to be trusted for billing.
// So the check is repeated here, where the rows are actually read, and the
// result goes in the alert where someone will see it.
var QBD_TIME_ROW_CAP = 50000;

// MUST match MAX_RETURNED.Invoice in server1.3.js, for the same reason. A
// short invoice pull understates column BX with no other symptom.
var QBD_INVOICE_ROW_CAP = 20000;

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('QuickBooks')
    .addItem('Refresh Hours', 'refreshHours')
    .addSeparator()
    .addItem('Check Project Tags', 'checkProjectTags')
    .addItem('Explain Cost Rollup (selected project)', 'explainCostRollup')
    .addItem('Show Last QuickBooks Sync', 'showLastSync')
    .addSubMenu(
      SpreadsheetApp.getUi()
        .createMenu('Setup')
        .addItem('Save Credentials', 'saveCredentials'))
    .addToUi();
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function saveCredentials() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();

  var existing = props.getProperty('QBD_PUSH_SECRET');
  var hint = existing ? ' [currently set - leave blank to keep]' : '';
  var res = ui.prompt('QuickBooks Setup',
    'Shared secret the local agent (tools/qbwc-agent) must send with each push.' +
    ' Put the same value in the agent\'s QBD_PUSH_SECRET environment variable.' + hint,
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var val = res.getResponseText().trim();
  if (val) props.setProperty('QBD_PUSH_SECRET', val);

  // Recorded here because this menu item always runs bound to the spreadsheet,
  // where getActive() cannot fail. doPost/doGet run in a Web App context where
  // it can, and then fall back to openById() with this. Costs the user nothing.
  props.setProperty('QBD_SPREADSHEET_ID', SpreadsheetApp.getActive().getId());

  ui.alert('Credentials saved. After the next sync, QuickBooks > Show Last QuickBooks Sync ' +
    'confirms the data arrived.');
}

/**
 * Reads a QuickBooks entity ("Customer", "Employee", "Vendor", or
 * "TimeActivity") from the data the local Desktop agent pushed via doPost.
 * `whereClause` is accepted but unused - the agent already date-bounds its
 * TimeTracking query to its own YEARS_BACK window (see SETUP.md), so
 * there's nothing left here to filter.
 */
function qboQueryAll_(entity, whereClause) {
  return qbdRead_(entity);
}

/**
 * Menu: what the Sheet last received from QuickBooks, and when. It tests
 * nothing - the Sheet cannot reach QuickBooks, only the local agent can push
 * to it - so this reports the last push: its time, how much each staging tab
 * holds, and how recent the newest time entry and invoice in them are.
 */
function showLastSync() {
  var ss = SpreadsheetApp.getActive();
  var ui = SpreadsheetApp.getUi();
  var last = PropertiesService.getScriptProperties().getProperty('QBD_LAST_PUSH');
  if (!last) {
    ui.alert('QuickBooks Desktop\n\nNo data received yet. Run "Sync QuickBooks Hours" and ' +
      'click "Update Now" in QuickBooks Web Connector, then try again.');
    return;
  }

  // Column B of "QBD Time" and column C of "QBD Invoices" hold the TxnDate.
  function newest_(sheetName, col) {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet || sheet.getLastRow() < 2) return '';
    var newest = '';
    sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getValues().forEach(function (r) {
      var ymd = ymdOf_(r[0]);
      if (ymd > newest) newest = ymd;
    });
    return newest;
  }
  function rows_(sheetName, newest) {
    var n = dataRows_(ss, sheetName);
    return '- ' + sheetName + ': ' + (typeof n === 'number' ? n + ' row(s)' : n) +
      (newest ? ', newest dated ' + newest : '') + '\n';
  }

  ui.alert('QuickBooks Desktop\n\n' +
    'Last data received from the local agent: ' +
    Utilities.formatDate(new Date(last), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm') +
    ' (' + ss.getSpreadsheetTimeZone() + ')\n\n' +
    rows_(QBD_CUSTOMERS_SHEET, '') +
    rows_(QBD_PEOPLE_SHEET, '') +
    rows_(QBD_TIME_SHEET, newest_(QBD_TIME_SHEET, 2)) +
    rows_(QBD_INVOICES_SHEET, newest_(QBD_INVOICES_SHEET, 3)));
}

// ---------------------------------------------------------------------------
// QuickBooks Desktop (via the local Web Connector agent in tools/qbwc-agent)
//
// QuickBooks Desktop has no REST API. tools/qbwc-agent/server.js runs locally
// alongside QuickBooks Desktop, pulls Customer/Employee/Vendor/TimeTracking
// data via qbXML through the QuickBooks Web Connector, reshapes it to the
// per-entity object arrays qboQueryAll_ returns, and POSTs it here. doPost()
// writes that payload into three plain sheets; qbdRead_() reads them back
// out, so every function above this point (buildQboIndexes_,
// refreshHours, ...) needs no changes at all.
// ---------------------------------------------------------------------------

/**
 * Finds the spreadsheet to write to, and reports HOW it found it.
 *
 * getActive() is the normal path and works whenever this script runs bound to
 * its container (menu items, triggers). In a Web App it can fail outright -
 * notably when the deployment's "Execute as" is "User accessing the web app"
 * and access is "Anyone", because the request then carries no Google identity
 * at all and has permission to nothing. openById() is a second chance for the
 * case where the container link is the problem rather than the identity; it
 * cannot rescue an anonymous execution, since an anonymous caller has no
 * access to that ID either.
 *
 * Returns { ss, how, errors } rather than throwing, so callers can report the
 * whole picture instead of only the first failure.
 */
function resolveSpreadsheet_() {
  var errors = [];

  try {
    var active = SpreadsheetApp.getActive();
    if (active) {
      active.getName(); // force the lazy handle to actually resolve
      return { ss: active, how: 'getActive', errors: errors };
    }
    errors.push('getActive() returned null (script may not be bound to a spreadsheet)');
  } catch (err) {
    errors.push('getActive() threw: ' + err.message);
  }

  var id = PropertiesService.getScriptProperties().getProperty('QBD_SPREADSHEET_ID');
  if (!id) {
    errors.push('no QBD_SPREADSHEET_ID saved - run QuickBooks > Setup > Save Credentials ' +
      'from the Sheet to record it, then redeploy');
    return { ss: null, how: null, errors: errors };
  }

  try {
    return { ss: SpreadsheetApp.openById(id), how: 'openById', errors: errors };
  } catch (err) {
    errors.push('openById(' + id + ') threw: ' + err.message);
    return { ss: null, how: null, errors: errors };
  }
}

/**
 * Translates Google's generic errors into the setting that is actually wrong.
 * "No item with the given ID could be found" is the one that matters here: it
 * says nothing about which of several very different misconfigurations caused
 * it, and guessing wrong costs a redeploy cycle each time.
 */
function diagnoseError_(message) {
  if (/No item with the given ID could be found/i.test(message)) {
    return 'The script ran, but could not open the spreadsheet. Check the ' +
      '"effectiveUser" field in this response first: if it is blank, the request ' +
      'executed with NO Google identity, which means Deploy > Manage deployments > ' +
      '(pencil) > "Execute as" is set to "User accessing the web app". With ' +
      '"Who has access: Anyone" that always yields an anonymous run with ' +
      'permission to nothing. Set Execute as: "Me", leave access on "Anyone", ' +
      'and redeploy. If effectiveUser instead shows your email address, the ' +
      'identity is fine and the container link is the problem - run QuickBooks > ' +
      'Setup > Save Credentials from the Sheet to record QBD_SPREADSHEET_ID.';
  }
  if (/Authorization is required|has not been authoriz/i.test(message)) {
    return 'The deployment has not been granted the scopes this version needs. ' +
      'Open the script editor, run any function once to trigger the consent ' +
      'screen, accept it, then deploy a new version.';
  }
  return null;
}

/**
 * Browser-checkable proof of what is actually deployed.
 *
 * Open the Web App's /exec URL in any browser. If this returns JSON naming a
 * version, the deployment is live and reachable and has this file in it. If
 * it instead shows Apps Script's "Script function not found: doGet" page, the
 * deployed version predates this file - editing the code and saving does NOT
 * change what /exec serves; you have to publish a new version under
 * Deploy > Manage deployments > (pencil) > Version: New version.
 *
 * That distinction is the entire reason this function exists: it turns a
 * silent failure that only showed up as an empty spreadsheet into a one-click
 * check that needs neither QuickBooks nor the local agent running.
 *
 * Returns no secrets - only whether one is saved.
 */
function doGet(e) {
  var out = {
    ok: true,
    scriptVersion: SCRIPT_VERSION,
    doPostPresent: (typeof doPost === 'function'),
    serverTime: new Date().toISOString()
  };

  // Each independent group gets its own try. v1.2 wrapped all of this in a
  // single try, so one throw inside the spreadsheet lookup also erased
  // pushSecretSaved and lastPush - the very fields needed to diagnose it.
  // A diagnostic that hides its other readings when one of them fails is
  // worse than no diagnostic.

  // Identity first, and on its own: this is the field that distinguishes
  // "Execute as: Me" (your address) from an anonymous run (blank), which is
  // the single most useful fact when the spreadsheet lookup fails below.
  try {
    var email = Session.getEffectiveUser().getEmail();
    out.effectiveUser = email || '(blank - running anonymously)';
  } catch (err) {
    out.effectiveUser = '(unavailable: ' + err.message + ')';
  }

  try {
    var props = PropertiesService.getScriptProperties();
    out.pushSecretSaved = !!props.getProperty('QBD_PUSH_SECRET');
    out.spreadsheetIdSaved = !!props.getProperty('QBD_SPREADSHEET_ID');
    out.lastPush = props.getProperty('QBD_LAST_PUSH') || 'never';
  } catch (err) {
    out.ok = false;
    out.propertiesError = err.message;
  }

  try {
    var found = resolveSpreadsheet_();
    out.spreadsheetResolvedBy = found.how;
    if (found.errors.length) out.spreadsheetWarnings = found.errors;

    if (!found.ss) {
      throw new Error(found.errors.join(' | ') ||
        'could not resolve a spreadsheet by any method');
    }

    out.spreadsheet = found.ss.getName();
    out.rows = {
      qbdCustomers: dataRows_(found.ss, QBD_CUSTOMERS_SHEET),
      qbdPeople: dataRows_(found.ss, QBD_PEOPLE_SHEET),
      qbdTime: dataRows_(found.ss, QBD_TIME_SHEET),
      qbdInvoices: dataRows_(found.ss, QBD_INVOICES_SHEET)
    };
  } catch (err) {
    out.ok = false;
    out.message = err.message;
    var hint = diagnoseError_(err.message);
    if (hint) out.diagnosis = hint;
    // doPost resolves the spreadsheet exactly the same way, so this is a
    // preview of the push failing - not a doGet-only quirk.
    out.note = 'doPost() uses the same lookup, so the QuickBooks push will fail ' +
      'the same way until this is resolved.';
  }

  return ContentService.createTextOutput(JSON.stringify(out, null, 2))
    .setMimeType(ContentService.MimeType.JSON);
}

function dataRows_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) return 'sheet does not exist yet';
  return Math.max(0, sheet.getLastRow() - 1);
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('No POST body received - e.postData.contents was empty. ' +
        'If you are seeing this, the request DID reach Apps Script, which rules out ' +
        'a deployment/URL/access problem.');
    }

    var payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (err) {
      throw new Error('Bad JSON: ' + err.message);
    }

    var expected = PropertiesService.getScriptProperties().getProperty('QBD_PUSH_SECRET');
    if (!expected) {
      throw new Error('Forbidden: no QBD_PUSH_SECRET is saved. Run QuickBooks > Setup > Save Credentials.');
    }
    if (payload.secret !== expected) {
      throw new Error('Forbidden: secret in the push did not match the saved QBD_PUSH_SECRET.');
    }

    var found = resolveSpreadsheet_();
    if (!found.ss) {
      throw new Error('Could not open the spreadsheet: ' +
        (found.errors.join(' | ') || 'no method succeeded'));
    }
    var ss = found.ss;

    var customers = payload.customers || [];
    var people = payload.people || [];
    var timeEntries = payload.timeEntries || [];

    // Column D ("Project") is maintained by hand and is the entire basis of the
    // project join, but writeQbdSheet_ clears the tab before writing. Read the
    // existing tags first and write them back, or every sync would silently
    // erase them and the next Refresh Hours would report zero hours everywhere
    // with nothing to indicate why.
    var priorProjects = readCustomerProjects_(ss);
    var carried = 0;
    writeQbdSheet_(ss, QBD_CUSTOMERS_SHEET,
      ['Id', 'DisplayName', 'FullyQualifiedName', 'Project'],
      customers.map(function (c) {
        var full = c.FullyQualifiedName || c.DisplayName || '';
        var project = priorProjects[normalize_(full)] || '';
        if (project) carried++;
        return [c.Id, c.DisplayName || '', full, project];
      }));

    writeQbdSheet_(ss, QBD_PEOPLE_SHEET, ['Id', 'DisplayName', 'Type'],
      people.map(function (p) { return [p.Id, p.DisplayName || '', p.Type || '']; }));

    writeQbdSheet_(ss, QBD_TIME_SHEET,
      ['Id', 'TxnDate', 'PersonType', 'PersonId', 'PersonName', 'CustomerId', 'CustomerName',
       'Hours', 'Minutes', 'StartTime', 'EndTime', 'BillableStatus', 'Description'],
      timeEntries.map(function (t) {
        return [t.Id, t.TxnDate || '', t.PersonType || '', t.PersonId || '', t.PersonName || '',
          t.CustomerId || '', t.CustomerName || '', t.Hours != null ? t.Hours : '',
          t.Minutes != null ? t.Minutes : '', t.StartTime || '', t.EndTime || '',
          t.BillableStatus || '', t.Description || ''];
      }));

    // Only rewritten when the push actually carries invoices. An agent older
    // than v1.4 sends no "invoices" key at all, and treating that as "zero
    // invoices" would wipe the tab and zero column BX on the next refresh.
    var invoices = payload.invoices;
    if (Array.isArray(invoices)) {
      writeQbdSheet_(ss, QBD_INVOICES_SHEET,
        ['Id', 'Type', 'TxnDate', 'RefNumber', 'CustomerId', 'CustomerName', 'Amount'],
        invoices.map(function (v) {
          return [v.Id, v.Type || '', v.TxnDate || '', v.RefNumber || '', v.CustomerId || '',
            v.CustomerName || '', v.Amount != null ? v.Amount : ''];
        }));
    }

    PropertiesService.getScriptProperties().setProperty('QBD_LAST_PUSH', new Date().toISOString());

    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      scriptVersion: SCRIPT_VERSION,
      spreadsheet: ss.getName(),
      spreadsheetResolvedBy: found.how,
      customers: customers.length,
      projectTagsCarriedOver: carried,
      people: people.length,
      timeEntries: timeEntries.length,
      invoices: Array.isArray(invoices) ? invoices.length : 'not sent (agent older than v1.4)',
      timestamp: new Date().toISOString()
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    // Deliberately still returns HTTP 200 with success:false in the body,
    // rather than throwing - Apps Script Web Apps turn an uncaught
    // exception into its own generic HTML error page, which would put us
    // right back to being unable to tell "Google rejected this" apart from
    // "our code failed." A 200 with a JSON body guarantees the agent's
    // `text` actually contains this message, and server1.3.js treats
    // success:false as a failure rather than just logging it.
    var body = {
      success: false,
      scriptVersion: SCRIPT_VERSION,
      message: err.message,
      stack: err.stack
    };
    try {
      body.effectiveUser = Session.getEffectiveUser().getEmail() || '(blank - running anonymously)';
    } catch (e2) { /* identity is a nicety here, never worth masking err */ }
    var hint = diagnoseError_(err.message);
    if (hint) body.diagnosis = hint;
    return ContentService.createTextOutput(JSON.stringify(body))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * The current "QBD Customers" column D tags, keyed by normalized
 * FullyQualifiedName so they survive a customer being renamed in case or
 * spacing. Keyed by name rather than id on purpose - see buildQboIndexes_ on
 * why customer ids in this data cannot be trusted as keys.
 */
function readCustomerProjects_(ss) {
  var map = {};
  var sheet = ss.getSheetByName(QBD_CUSTOMERS_SHEET);
  if (!sheet) return map;

  var lastRow = sheet.getLastRow();
  if (lastRow < 2 || sheet.getLastColumn() < QBD_CUSTOMER_PROJECT_COL) return map;

  var rows = sheet.getRange(2, 1, lastRow - 1, QBD_CUSTOMER_PROJECT_COL).getValues();
  rows.forEach(function (r) {
    var full = String(r[2] || r[1] || '').trim();
    var project = String(r[QBD_CUSTOMER_PROJECT_COL - 1] || '').trim();
    if (full && project) map[normalize_(full)] = project;
  });
  return map;
}

function writeQbdSheet_(ss, name, headers, rows) {
  rows.forEach(function (row, i) {
    if (row.length !== headers.length) {
      throw new Error('writeQbdSheet_(' + name + '): row ' + i + ' has ' + row.length +
        ' columns, expected ' + headers.length + '.');
    }
  });
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
  sheet.setFrozenRows(1);
  return sheet;
}

/**
 * Reads the sheets doPost() populates and reshapes them back into the
 * per-entity object arrays qboQueryAll_ returns, so entryHours_/entryPerson_/
 * buildQboIndexes_ don't need to know where the data came from.
 *
 * A TimeActivity row's PersonType is only 'Employee' or 'Vendor' when the
 * agent could resolve the time entry's EntityRef against one of those lists.
 * If it couldn't (e.g. an unsupported "Other Name" entry), PersonType is left
 * blank on purpose: leaving both EmployeeRef/VendorRef unset makes
 * entryPerson_ treat it as an unresolved person rather than guessing wrong.
 */
function qbdRead_(entity) {
  var ss = SpreadsheetApp.getActive();

  function readRows_(sheetName) {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet || sheet.getLastRow() < 2) return [];
    return sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  }

  if (entity === 'Customer') {
    return readRows_(QBD_CUSTOMERS_SHEET).map(function (r) {
      return {
        Id: String(r[0]),
        DisplayName: String(r[1] || ''),
        FullyQualifiedName: String(r[2] || r[1] || ''),
        // Column D, hand-maintained: the project this customer rolls up to.
        Project: String(r[QBD_CUSTOMER_PROJECT_COL - 1] || '')
      };
    });
  }

  if (entity === 'Employee' || entity === 'Vendor') {
    return readRows_(QBD_PEOPLE_SHEET)
      .filter(function (r) { return String(r[2]) === entity; })
      .map(function (r) { return { Id: String(r[0]), DisplayName: String(r[1] || '') }; });
  }

  // A date-looking string in a plain cell gets auto-coerced to a Date by
  // Sheets on write, so getValues() hands it back as a Date object, not the
  // "yyyy-MM-dd" string doPost() wrote. Read local date parts (never
  // Date-to-string formatting) to avoid the UTC month-boundary shift
  // readCurrentLayout_'s Date guard above is already written to avoid.
  function ymd_(raw) {
    return (raw instanceof Date)
      ? raw.getFullYear() + '-' + pad2_(raw.getMonth() + 1) + '-' + pad2_(raw.getDate())
      : String(raw || '');
  }

  if (entity === 'Invoice') {
    return readRows_(QBD_INVOICES_SHEET).map(function (r) {
      return {
        Id: String(r[0]),
        Type: String(r[1] || ''),
        TxnDate: ymd_(r[2]),
        RefNumber: String(r[3] || ''),
        CustomerId: String(r[4] || ''),
        CustomerName: String(r[5] || ''),
        Amount: Number(r[6]) || 0   // credit memos already negative
      };
    });
  }

  if (entity === 'TimeActivity') {
    return readRows_(QBD_TIME_SHEET).map(function (r) {
      var personType = String(r[2] || '');
      var ta = {
        Id: String(r[0]),
        TxnDate: ymd_(r[1]),
        NameOf: personType,
        BillableStatus: String(r[11] || ''),
        Description: String(r[12] || '')
      };
      var personRef = { value: String(r[3] || ''), name: String(r[4] || '') };
      if (personType === 'Vendor') ta.VendorRef = personRef;
      else if (personType === 'Employee') ta.EmployeeRef = personRef;

      if (r[5] !== '' && r[5] != null) ta.CustomerRef = { value: String(r[5]), name: String(r[6] || '') };
      if (r[7] !== '' && r[7] != null) ta.Hours = Number(r[7]);
      if (r[8] !== '' && r[8] != null) ta.Minutes = Number(r[8]);
      if (r[9]) ta.StartTime = String(r[9]);
      if (r[10]) ta.EndTime = String(r[10]);
      return ta;
    });
  }

  throw new Error('qbdRead_: unexpected entity ' + entity);
}

// ---------------------------------------------------------------------------
// Reading the "Current" tab layout
// ---------------------------------------------------------------------------

/**
 * The "test_current" tab groups rows into project blocks. A block's first row
 * carries the project name in column A plus the rollup/contract columns;
 * following rows carry only a person in column B.
 *
 * v1.x decided where a block started by looking for a value in the
 * rollup/funds/contract columns, because the old "Current" tab reused column A
 * mid-block for sub-labels ("Arch Team"). "test_current" does not do that -
 * every non-empty column A below the header is a real project name - so the
 * scan keys off column A directly. That matters for at least one live row:
 * "NYSDOT Statewide ITS Architecture" has a name but no rollup formulas yet,
 * and the old rule would have folded its people into the block above it.
 *
 * Two things are still deliberately skipped:
 *  - Row 3's column A holds a date (the Basecamp "as of" stamp), not a project.
 *  - Below the projects sits a footer: a grand-total row, then a per-person
 *    utilization table whose column B repeats the same staff names. Those must
 *    never be read as project rows or every person's hours would double.
 */
var FOOTER_MARKER = 'total hours'; // column B of the footer's first row

function readCurrentLayout_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(SOURCE_SHEET);
  if (!sheet) throw new Error('No sheet named "' + SOURCE_SHEET + '".');

  var lastRow = sheet.getLastRow();
  if (lastRow <= SOURCE_HEADER_ROW) return [];
  var values = sheet.getRange(1, 1, lastRow, SOURCE_LAST_COL).getValues();

  var projects = [];
  var current = null;

  // 0-indexed, so starting at SOURCE_HEADER_ROW lands on the first data row.
  for (var r = SOURCE_HEADER_ROW; r < lastRow; r++) {
    var rowNum = r + 1;
    var project = values[r][COL_PROJECT - 1];
    var person = values[r][COL_PERSON - 1];

    // Everything from the footer down is summary, not project data.
    if (String(person).trim().toLowerCase() === FOOTER_MARKER) break;

    // A date in column A is the sheet's own timestamp row, not a project.
    var name = (project instanceof Date) ? '' : String(project || '').trim();

    if (name) {
      current = {
        name: name,
        headerRow: rowNum,
        contractValue: values[r][COL_CONTRACT_VALUE - 1],  // number, or whatever is typed there
        startDate: values[r][COL_START_DATE - 1],          // a Date, or blank
        people: []
      };
      projects.push(current);
    }

    if (current && person !== '' && person != null) {
      var personName = String(person).trim();
      // Guard against free-text notes parked in column B.
      if (personName && personName.length <= 40) {
        // The rate travels with the person because a blank one silently turns
        // that person's dollar estimate into $0, which overstates how much of
        // a contract is left - the one direction this report must not err in.
        current.people.push({
          row: rowNum,
          name: personName,
          rate: Number(values[r][COL_RATE - 1]) || 0
        });
      }
    }
  }

  return projects.filter(function (p) { return p.name && p.people.length; });
}

// ---------------------------------------------------------------------------
// Mapping tabs
// ---------------------------------------------------------------------------

function normalize_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Employee ids and Vendor ids are separate sequences in QuickBooks, so id "3"
 * can be both an employee and a vendor. Any lookup of a person by id must carry
 * the type alongside it or one person's hours land on the other's row.
 */
function personKey_(type, id) {
  return (type === 'Vendor' ? 'Vendor' : 'Employee') + ':' + String(id);
}

var AMBIGUOUS = '__ambiguous__';

/**
 * Builds the two lookups the join needs, straight from the pushed data:
 *
 *   customer  -> Project   (from "QBD Customers" column D)
 *   person    -> {id,type} (from "QBD People" column B, matched by name)
 *
 * Customers are keyed by FullyQualifiedName first and by Id only second, which
 * is the opposite of what you would normally do. The reason is concrete: in the
 * live data 11 customer rows arrive with an Id of "0" - among them NTTA's
 * T2-ConOps and MassDOT's T206 - and 53 time entries point at that same "0".
 * Keyed by id, those would all collapse onto whichever customer was read last
 * and silently bill the wrong project. FullyQualifiedName is unique across
 * every customer and present on every time entry, so it is the safer key; the
 * id is kept only as a fallback for a customer whose name somehow does not
 * match, and any id that repeats is marked ambiguous rather than guessed at.
 */
function buildQboIndexes_() {
  var customers = qboQueryAll_('Customer');
  var employees = qboQueryAll_('Employee');
  var vendors = qboQueryAll_('Vendor');

  var projectByCustomerName = {};
  var projectByCustomerId = {};
  var projectsTagged = {};   // normalized project name -> as written in column D
  var untaggedCustomers = [];
  var idSeen = {};

  customers.forEach(function (c) {
    var full = c.FullyQualifiedName || c.DisplayName || '';
    var project = String(c.Project || '').trim();

    // No Project tag: skip it, by design. Its hours are still accounted for on
    // "QBO Unmapped" - they just don't land on a project block.
    if (!project) {
      if (full) untaggedCustomers.push(full);
      return;
    }

    projectsTagged[normalize_(project)] = project;
    if (full) projectByCustomerName[normalize_(full)] = project;

    var id = String(c.Id || '').trim();
    if (!id || id === '0') return;
    if (idSeen[id]) {
      projectByCustomerId[id] = AMBIGUOUS;
      return;
    }
    idSeen[id] = true;
    projectByCustomerId[id] = project;
  });

  var people = []
    .concat(employees.map(function (e) {
      return { name: e.DisplayName, id: String(e.Id), type: 'Employee' };
    }))
    .concat(vendors.map(function (v) {
      return { name: v.DisplayName, id: String(v.Id), type: 'Vendor' };
    }));

  var personByName = {};
  people.forEach(function (p) {
    var n = normalize_(p.name);
    if (!n) return;
    if (n in personByName && personByName[n].key !== personKey_(p.type, p.id)) {
      personByName[n] = AMBIGUOUS; // an employee and a vendor share a display name
    } else {
      personByName[n] = { key: personKey_(p.type, p.id), id: p.id, type: p.type, name: p.name };
    }
  });

  return {
    customers: customers,
    people: people,
    projectByCustomerName: projectByCustomerName,
    projectByCustomerId: projectByCustomerId,
    projectsTagged: projectsTagged,
    untaggedCustomers: untaggedCustomers,
    personByName: personByName
  };
}

/**
 * The Project a time entry's customer rolls up to, or '' if that customer has
 * no tag in "QBD Customers" column D. Name first, id second - see the note in
 * buildQboIndexes_ about id "0".
 */
function resolveProject_(idx, customerId, customerName) {
  var byName = idx.projectByCustomerName[normalize_(customerName)];
  if (byName) return byName;

  var id = String(customerId || '').trim();
  if (!id || id === '0') return '';
  var byId = idx.projectByCustomerId[id];
  return (byId && byId !== AMBIGUOUS) ? byId : '';
}

/**
 * Read-only health check on the join, replacing "Rebuild Mapping Tabs".
 *
 * There is nothing left to rebuild - the join reads "QBD Customers" column D
 * and "QBD People" column B directly - but there is still something worth
 * checking, because both failure modes are silent: a customer with no Project
 * tag contributes no hours, and a project on "test_current" whose name no
 * customer carries shows up as an empty row rather than an error.
 */
function checkProjectTags() {
  var ui = SpreadsheetApp.getUi();
  var layout = readCurrentLayout_();
  var idx = buildQboIndexes_();
  var join = buildJoin_(idx, layout);

  var taggedProjects = Object.keys(idx.projectsTagged).length;

  // Roll the untagged customers up to their top-level parent, or the list runs
  // to hundreds of sub-tasks and tells you nothing you can act on.
  var parents = {};
  idx.untaggedCustomers.forEach(function (full) {
    var top = String(full).split(':')[0].trim();
    parents[top] = (parents[top] || 0) + 1;
  });
  var parentList = Object.keys(parents).sort(function (a, b) { return parents[b] - parents[a]; });

  var msg = 'Project tags\n\n' +
    layout.length + ' project block(s) on "' + SOURCE_SHEET + '".\n' +
    taggedProjects + ' distinct Project value(s) tagged in "' + QBD_CUSTOMERS_SHEET +
      '" column D.\n' +
    join.mappedProjects + ' of them match a block and will receive hours.\n\n';

  if (join.unmatchedProjects.length) {
    msg += 'On "' + SOURCE_SHEET + '" but never tagged on any customer - these will ' +
      'stay empty:\n- ' + join.unmatchedProjects.join('\n- ') + '\n\n';
  }

  if (parentList.length) {
    msg += 'Customers with a blank column D (their hours are skipped):\n' +
      parentList.slice(0, 12).map(function (p) {
        return '- ' + p + ' (' + parents[p] + ' customer' + (parents[p] === 1 ? '' : 's') + ')';
      }).join('\n') +
      (parentList.length > 12 ? '\n- ... and ' + (parentList.length - 12) + ' more' : '') +
      '\n\n';
  }

  if (join.problems.length) {
    msg += 'Personnel problems:\n- ' + join.problems.join('\n- ');
  } else {
    msg += 'Every person listed on "' + SOURCE_SHEET + '" matches "' + QBD_PEOPLE_SHEET + '".';
  }

  ui.alert(msg);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

// QuickBooks TxnDate is a plain calendar date with no timezone, so these build
// date strings arithmetically rather than through Date formatting - converting a
// locally-constructed Date to a UTC string can shift it across a month boundary.

var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

/** First day of the month N months before today, as "yyyy-MM-dd". */
function monthStart_(from, monthsBack) {
  var d = new Date(from.getFullYear(), from.getMonth() - monthsBack, 1);
  return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-01';
}

function monthLabel_(key) {
  var parts = key.split('-');
  return MONTH_NAMES[Number(parts[1]) - 1] + ' ' + parts[0];
}

// ---------------------------------------------------------------------------
// Time entry parsing
// ---------------------------------------------------------------------------

/**
 * QuickBooks stores duration either as Hours/Minutes or as a StartTime and
 * EndTime pair, depending on how the entry was created. Handle both.
 */
function entryHours_(ta) {
  if (ta.Hours != null || ta.Minutes != null) {
    return Number(ta.Hours || 0) + Number(ta.Minutes || 0) / 60;
  }
  if (ta.StartTime && ta.EndTime) {
    var ms = new Date(ta.EndTime).getTime() - new Date(ta.StartTime).getTime();
    var hours = ms / 3600000;
    hours -= Number(ta.BreakHours || 0) + Number(ta.BreakMinutes || 0) / 60;
    return hours > 0 ? hours : 0;
  }
  return 0;
}

/**
 * QuickBooks' BillableStatus is the only record of whether time has actually
 * reached an invoice - QuickBooks sets "HasBeenBilled" itself when an entry is
 * pulled onto one via Add Time/Costs, so it is not a flag anyone has to
 * remember to tick. That makes it the definition of "billed" used everywhere
 * here.
 *
 *   HasBeenBilled - already invoiced           -> billed
 *   Billable      - chargeable, not yet billed -> unbilled
 *   NotBillable   - indirect, admin, vacation  -> nonbillable
 *   anything else - blank, "Empty", unexpected -> unknown
 *
 * "unknown" gets its own column rather than being folded into one of the other
 * three: a status QuickBooks did not set is not evidence that the hours are
 * non-billable, and silently treating it as such would understate what is
 * still owed on a contract.
 */
function billableClass_(status) {
  var s = String(status || '').toLowerCase().replace(/[^a-z]/g, '');
  if (s === 'hasbeenbilled') return 'billed';
  if (s === 'billable') return 'unbilled';
  if (s === 'notbillable') return 'nonbillable';
  return 'unknown';
}

function entryPerson_(ta) {
  var type = ta.NameOf === 'Vendor' ? 'Vendor' : 'Employee';
  var ref = type === 'Vendor' ? ta.VendorRef : ta.EmployeeRef;

  if (!ref) { // NameOf missing or inconsistent with the refs actually present
    if (ta.EmployeeRef) { ref = ta.EmployeeRef; type = 'Employee'; }
    else if (ta.VendorRef) { ref = ta.VendorRef; type = 'Vendor'; }
  }
  if (!ref) return { key: '', id: '', type: '', name: '(no name on entry)' };

  return {
    key: personKey_(type, ref.value),
    id: String(ref.value),
    type: type,
    name: ref.name || ''
  };
}

// ---------------------------------------------------------------------------
// Main refresh
// ---------------------------------------------------------------------------

/**
 * Lookups from what QuickBooks says to the exact row labels on "test_current".
 *
 * Both are identity joins on normalized text, because the data already lines
 * up: a Project tag in "QBD Customers" column D is written to match a project
 * name in column A, and a person in column B is a QuickBooks DisplayName. The
 * only work left is normalizing case and punctuation so a stray double space
 * or a trailing period does not break a match that is obviously correct to a
 * human reader.
 *
 * Nothing here fails the run. A project that no customer tags simply receives
 * no hours, and is reported instead.
 */
function buildJoin_(idx, layout) {
  var projectNameToSheet = {};
  var personNameToSheet = {};
  var problems = [];

  layout.forEach(function (p) {
    projectNameToSheet[normalize_(p.name)] = p.name;
  });

  // A project block with no matching tag anywhere in column D will render as an
  // empty row rather than an error, so name it explicitly.
  var unmatchedProjects = [];
  layout.forEach(function (p) {
    if (!idx.projectsTagged[normalize_(p.name)]) unmatchedProjects.push(p.name);
  });

  var seen = {};
  layout.forEach(function (p) {
    p.people.forEach(function (person) {
      var n = normalize_(person.name);
      if (!n || seen[n]) return;
      seen[n] = true;
      personNameToSheet[n] = person.name;

      var hit = idx.personByName[n];
      if (!hit) {
        problems.push('"' + person.name + '" on ' + SOURCE_SHEET +
          ' matches no DisplayName in "' + QBD_PEOPLE_SHEET + '".');
      } else if (hit === AMBIGUOUS) {
        problems.push('"' + person.name + '" matches both an employee and a vendor in "' +
          QBD_PEOPLE_SHEET + '" - their hours cannot be told apart.');
      }
    });
  });

  var mappedProjects = 0;
  Object.keys(idx.projectsTagged).forEach(function (n) {
    if (projectNameToSheet[n]) mappedProjects++;
  });

  return {
    projectNameToSheet: projectNameToSheet,
    personNameToSheet: personNameToSheet,
    problems: problems,
    unmatchedProjects: unmatchedProjects,
    mappedProjects: mappedProjects,
    mappedPeople: Object.keys(personNameToSheet).length
  };
}

function refreshHours() {
  var ss = SpreadsheetApp.getActive();
  var ui = SpreadsheetApp.getUi();
  var sheet = ss.getSheetByName(SOURCE_SHEET);
  if (!sheet) throw new Error('No sheet named "' + SOURCE_SHEET + '".');

  var layout = readCurrentLayout_();
  var idx = buildQboIndexes_();
  var join = buildJoin_(idx, layout);

  if (!layout.length) {
    ui.alert('No project blocks found on "' + SOURCE_SHEET + '".\n\n' +
      'Expected project names in column A and personnel in column B, starting on row ' +
      (SOURCE_HEADER_ROW + 1) + '.');
    return;
  }
  if (!idx.customers.length) {
    ui.alert('"' + QBD_CUSTOMERS_SHEET + '" is empty.\n\nThe local agent has not pushed ' +
      'customer data yet. Start tools/qbwc-agent and click "Update Now" in QuickBooks ' +
      'Web Connector.');
    return;
  }
  if (!join.mappedProjects) {
    ui.alert('No project on "' + SOURCE_SHEET + '" matches a Project tag in "' +
      QBD_CUSTOMERS_SHEET + '" column D.\n\nRun QuickBooks > Check Project Tags to see ' +
      'which names disagree.');
    return;
  }

  var grid = gridMonths_(sheet);
  if (!grid.months.length) {
    ui.alert('Could not read the month grid.\n\nCell A1 of "' + SOURCE_SHEET +
      '" should hold the reporting year (the month headers are CONCAT formulas off it).');
    return;
  }

  // writeGrid_ below writes columns COL_MONTH_FIRST..COL_MONTH_FIRST+72-1
  // and readCurrentLayout_ reads through SOURCE_LAST_COL (COL_RATE) - both
  // assume the hand-maintained Hours Rollup / Funds Remaining / As Of / Type
  // / Contract Value / Rate columns sit at their expected positions. If a
  // future GRID_YEARS change (or any other reshuffle) ever outruns the live
  // sheet again, the grid write would land on top of those columns instead
  // of the intended blank ones. Bail rather than risk that.
  if (sheet.getLastColumn() < SOURCE_LAST_COL) {
    ui.alert('"' + SOURCE_SHEET + '" only has ' + sheet.getLastColumn() + ' columns, but ' +
      'this script expects data through column ' + SOURCE_LAST_COL + ' (GRID_YEARS = ' +
      GRID_YEARS + '). Stopping before writing anything.\n\n' +
      'The live sheet\'s columns no longer match what this script expects - check that ' +
      'COL_COST_ROLLUP, COL_HOURS_ROLLUP, COL_FUNDS_REMAINING, COL_AS_OF, COL_TYPE, COL_CONTRACT_VALUE, ' +
      'COL_RATE and COL_START_DATE still point at the right columns before running this again.');
    return;
  }

  // ---- resolve ---------------------------------------------------------
  var entries = qboQueryAll_('TimeActivity');
  var targets = resolveEntries_(entries, idx, join, rowIndex_(layout).rowOf);

  // Anyone with hours on a project but no row under it gets a row now, before
  // anything is aggregated, so those hours land in the grid on this same run.
  var people = addMissingPeople_(sheet, layout, idx, join, grid, targets);
  if (people.added.length) {
    SpreadsheetApp.flush();
    layout = readCurrentLayout_();   // every row below an insert has moved
    join = buildJoin_(idx, layout);
    targets = resolveEntries_(entries, idx, join, rowIndex_(layout).rowOf);
  }

  // ---- aggregate -------------------------------------------------------
  // byCell["<row>|||<yyyy-MM>"] = { total, billed } for rows on this sheet.
  var byCell = {};
  var unplaced = {};
  var placedHours = 0, untaggedHours = 0, dataSince = '', dataUntil = '';

  targets.forEach(function (t) {
    var hours = t.hours;
    var monthKey = t.monthKey;
    if (t.txnDate) {
      if (!dataSince || t.txnDate < dataSince) dataSince = t.txnDate;
      if (!dataUntil || t.txnDate > dataUntil) dataUntil = t.txnDate;
    }

    if (t.row && grid.colOf[monthKey]) {
      var key = t.row + '|||' + monthKey;
      if (!byCell[key]) byCell[key] = { total: 0, billed: 0 };
      byCell[key].total += hours;
      if (t.billable === 'billed') byCell[key].billed += hours;
      placedHours += hours;
      return;
    }

    // Nothing is written to a tab any more, so anything that cannot land in the
    // grid is counted here and summarised in the alert instead. The order
    // matters: each test assumes the ones above it passed, so a person who
    // exists on the sheet but not under THIS project reports as exactly that,
    // rather than falling through to a month-range message that would be false.
    //
    // Since v3.2 addMissingPeople_ gives most such people a row before this
    // loop runs, so the two "not listed" reasons now only fire for hours it
    // deliberately skips: the current month, months outside the grid, or
    // everything when ADD_MISSING_PEOPLE is off.
    if (!t.project) untaggedHours += hours;
    var why = !t.project
      ? 'customer has no Project tag in "' + QBD_CUSTOMERS_SHEET + '" column D'
      : !t.sheetProject ? 'Project "' + t.project + '" has no block on "' + SOURCE_SHEET + '"'
      : !t.sheetPerson ? '"' + t.person.name + '" is not listed anywhere on "' + SOURCE_SHEET + '"'
      : !t.row ? '"' + t.person.name + '" is not listed under "' + t.sheetProject + '" on "' +
          SOURCE_SHEET + '"'
      : 'month ' + (monthKey || '(no date)') + ' is outside the grid on "' + SOURCE_SHEET + '"';
    if (!unplaced[why]) unplaced[why] = 0;
    unplaced[why] += hours;
  });

  var written = writeGrid_(sheet, layout, grid, byCell, dataSince, dataUntil);
  var roll = buildCostRollup_(layout, idx, join, targets);
  var cost = writeCostRollup_(sheet, layout, roll);
  var funds = writeFundsRemaining_(sheet, layout, roll);

  // ---- report ----------------------------------------------------------
  var msg = 'Hours refreshed on "' + SOURCE_SHEET + '".\n\n' +
    entries.length + ' time entries read.\n' +
    round2_(written.hours) + ' hours written into ' + written.cells + ' cells, ' +
    (written.firstLabel === written.lastLabel
      ? written.firstLabel
      : written.firstLabel + ' through ' + written.lastLabel) + '.\n' +
    written.billedOnly + ' cell(s) fully billed, ' + written.mixed + ' mixed.\n\n';

  msg += peopleAddedReport_(people, layout);
  msg += costRollupReport_(roll, cost);
  msg += fundsRemainingReport_(funds) + '\n';

  msg += 'QuickBooks data covers ' +
    (dataSince ? monthLabel_(dataSince.slice(0, 7)) : '(none)') + ' to ' +
    (dataUntil ? monthLabel_(dataUntil.slice(0, 7)) : '(none)') + '.\n';

  // The single most common cause of "why is 2023 empty?" - the agent simply
  // never pulled it, and no amount of refreshing here will invent it.
  if (dataSince && dataSince.slice(0, 7) > grid.months[0]) {
    msg += 'The grid starts at ' + monthLabel_(grid.months[0]) + ', earlier than any data ' +
      'received. Those columns are left untouched rather than zeroed - raise YEARS_BACK ' +
      'in server1.3.js and sync again to fill them.\n';
  }
  if (dataUntil && dataUntil.slice(0, 7) < grid.lastWritable) {
    msg += 'No data yet for ' + monthLabel_(grid.lastWritable) + ', the last complete ' +
      'month. The agent may not have run since ' + dataUntil + '.\n';
  }

  var reasons = Object.keys(unplaced);
  if (reasons.length) {
    msg += '\nHours not placed:\n';
    reasons.sort(function (a, b) { return unplaced[b] - unplaced[a]; });
    reasons.slice(0, 6).forEach(function (r) {
      msg += '  ' + round2_(unplaced[r]) + ' hrs - ' + r + '\n';
    });
    if (untaggedHours > 0) {
      msg += '  (Indirect and other untagged customers are expected here.)\n';
    }
  }

  if (join.unmatchedProjects.length) {
    msg += '\nProjects with no Project tag anywhere - these rows stay empty:\n- ' +
      join.unmatchedProjects.join('\n- ');
  }
  if (join.problems.length) msg += '\n\nPersonnel problems:\n- ' + join.problems.join('\n- ');

  ui.alert(msg);
}

/**
 * The month grid on "test_current": which spreadsheet column holds which month,
 * and how far right it is legitimate to write.
 *
 * The headers are CONCAT formulas off A1, so the grid always spans six
 * calendar years - A1-5 .. A1 - as 72 columns starting at C. Reading A1
 * rather than the header text means a changed reporting year moves the grid
 * here automatically, and it avoids depending on how Sheets renders a formula.
 *
 * "lastWritable" is the last COMPLETE month. Columns at or after the current
 * month hold forward-looking estimates that are maintained by hand, and are
 * never written by this script.
 */
function gridMonths_(sheet) {
  var year = Number(sheet.getRange(1, 1).getValue());
  var months = [], colOf = {};
  if (!year || year < 1900) return { months: months, colOf: colOf };

  var startYear = year - (GRID_YEARS - 1);
  for (var i = 0; i < GRID_YEARS * 12; i++) {
    var y = startYear + Math.floor(i / 12);
    var m = (i % 12) + 1;
    var key = y + '-' + pad2_(m);
    months.push(key);
    colOf[key] = COL_MONTH_FIRST + i;
  }

  var now = new Date();
  var thisMonth = now.getFullYear() + '-' + pad2_(now.getMonth() + 1);
  var writable = months.filter(function (k) { return k < thisMonth; });

  return {
    year: year,
    months: months,
    colOf: colOf,
    thisMonth: thisMonth,
    lastWritable: writable.length ? writable[writable.length - 1] : ''
  };
}

/**
 * Writes hours into the month grid in place.
 *
 * Deliberately narrow: it touches only the cells belonging to a person row in
 * `layout`, within complete months, at or after the first month QuickBooks
 * actually sent. Everything else in the block - blank spacer rows, the
 * forward-looking estimate columns, months older than the sync window - is read
 * and written back exactly as found, so a refresh cannot quietly erase planning
 * data or assert a zero for a month nobody has pulled yet.
 *
 * Billed status is marked with font weight/color, not fill:
 *   every hour billed         -> bold
 *   billed plus anything else -> bold, #cc33b3
 *   nothing billed            -> #cc33b3
 *   no hours at all           -> reset to normal weight, default color
 */
function writeGrid_(sheet, layout, grid, byCell, dataSince, dataUntil) {
  var firstCol = COL_MONTH_FIRST;
  var lastCol = COL_MONTH_FIRST + grid.months.length - 1;

  var rowNums = [];
  layout.forEach(function (p) {
    p.people.forEach(function (person) { rowNums.push(person.row); });
  });
  var firstRow = Math.min.apply(null, rowNums);
  var lastRow = Math.max.apply(null, rowNums);
  var nRows = lastRow - firstRow + 1;
  var nCols = lastCol - firstCol + 1;

  var range = sheet.getRange(firstRow, firstCol, nRows, nCols);
  var values = range.getValues();
  var fontWeights = range.getFontWeights();
  var fontColors = range.getFontColors();

  // Only months QuickBooks actually reported on are touched. Outside that
  // range "no data pulled" and "zero hours worked" are indistinguishable here,
  // and writing a blank would assert the second - wiping the forward-looking
  // estimates in the process. August 2026 is the live example: it is a complete
  // month, so it is writable, but the agent has sent nothing for it, and the
  // NTTA rows hold planned hours there.
  var sinceMonth = dataSince ? dataSince.slice(0, 7) : '';
  var untilMonth = dataUntil ? dataUntil.slice(0, 7) : '';

  var isPersonRow = {};
  layout.forEach(function (p) {
    p.people.forEach(function (person) { isPersonRow[person.row] = true; });
  });

  var hours = 0, cells = 0, billedOnly = 0, mixed = 0;
  var firstWritten = '', lastWritten = '';

  grid.months.forEach(function (monthKey, i) {
    if (grid.lastWritable && monthKey > grid.lastWritable) return; // current + future
    if (sinceMonth && monthKey < sinceMonth) return;               // never pulled
    if (untilMonth && monthKey > untilMonth) return;               // not pulled yet

    var c = i;
    if (!firstWritten) firstWritten = monthKey;
    lastWritten = monthKey;

    for (var r = 0; r < nRows; r++) {
      var rowNum = firstRow + r;
      if (!isPersonRow[rowNum]) continue;

      var agg = byCell[rowNum + '|||' + monthKey];
      var total = agg ? round2_(agg.total) : 0;
      var billed = agg ? agg.billed : 0;

      values[r][c] = total ? total : (BLANK_WHEN_ZERO ? '' : 0);
      if (total) { hours += total; cells++; }

      // Keyed off total, not off what was written: a cell with no hours is not
      // a billing state at all, so it keeps whatever styling it already had
      // whether BLANK_WHEN_ZERO leaves it empty or writes a literal 0.
      if (!total) {
        var key = styleKey_(fontWeights[r][c], fontColors[r][c]);
        if (MARKER_STYLES.indexOf(key) >= 0) {
          // stale marker from a previous run - reset rather than leave it
          fontWeights[r][c] = STYLE_RESET.weight;
          fontColors[r][c] = STYLE_RESET.color;
        }
      } else if (billed < 0.005) {
        fontWeights[r][c] = STYLE_UNBILLED.weight;
        fontColors[r][c] = STYLE_UNBILLED.color;
      } else if (Math.abs(billed - agg.total) < 0.005) {
        fontWeights[r][c] = STYLE_BILLED_ONLY.weight;
        fontColors[r][c] = STYLE_BILLED_ONLY.color;
        billedOnly++;
      } else {
        fontWeights[r][c] = STYLE_MIXED.weight;
        fontColors[r][c] = STYLE_MIXED.color;
        mixed++;
      }
    }
  });

  // Three writes for the whole grid rather than one per cell - Apps Script
  // charges per call, and a per-cell loop here would take minutes.
  range.setValues(values);
  range.setFontWeights(fontWeights);
  range.setFontColors(fontColors);

  return {
    hours: hours,
    cells: cells,
    billedOnly: billedOnly,
    mixed: mixed,
    firstLabel: firstWritten ? monthLabel_(firstWritten) : '(nothing)',
    lastLabel: lastWritten ? monthLabel_(lastWritten) : '(nothing)'
  };
}

// ---------------------------------------------------------------------------
// Resolving time entries against the sheet
// ---------------------------------------------------------------------------

/**
 * "project|||person" -> the FIRST sheet row for that pair (a repeated person
 * must not double-count), plus each person row's Rate.
 */
function rowIndex_(layout) {
  var rowOf = {}, rateOf = {};
  layout.forEach(function (p) {
    p.people.forEach(function (person) {
      var k = normalize_(p.name) + '|||' + normalize_(person.name);
      if (!(k in rowOf)) rowOf[k] = person.row;
      rateOf[person.row] = person.rate;
    });
  });
  return { rowOf: rowOf, rateOf: rateOf };
}

/**
 * Every time entry, resolved once against the sheet: which project block and
 * which person row it belongs to, if any. The grid, the cost rollup and the
 * add-missing-people step all need the same answer, so it is worked out in
 * one place rather than three.
 */
function resolveEntries_(entries, idx, join, rowOf) {
  return entries.map(function (ta) {
    var txnDate = String(ta.TxnDate || '');
    var person = entryPerson_(ta);
    var customerId = ta.CustomerRef ? String(ta.CustomerRef.value) : '';
    var customerName = (ta.CustomerRef && ta.CustomerRef.name) || '(no customer)';
    var project = resolveProject_(idx, customerId, customerName);
    var sheetProject = (project && join.projectNameToSheet[normalize_(project)]) || '';
    var sheetPerson = join.personNameToSheet[normalize_(person.name)] || '';
    var row = (sheetProject && sheetPerson)
      ? rowOf[normalize_(sheetProject) + '|||' + normalize_(sheetPerson)]
      : null;
    return {
      hours: entryHours_(ta),
      txnDate: txnDate,
      monthKey: txnDate.slice(0, 7),
      billable: billableClass_(ta.BillableStatus),
      person: person,
      customer: customerName,
      project: project,
      sheetProject: sheetProject,
      sheetPerson: sheetPerson,
      row: row || null
    };
  });
}

// ---------------------------------------------------------------------------
// Adding people who have hours on a project but no row under it
// ---------------------------------------------------------------------------

/**
 * Inserts a row for every person QuickBooks shows hours for on a project
 * block, in a complete month inside the grid, who has no row in that block.
 *
 * Where the row goes matters more than it looks. A block's rollup formulas
 * are ranges over its rows, and Sheets only stretches a range when a row is
 * inserted INSIDE it - a row added after the last one is silently left out of
 * every total. So the new row goes immediately above the block's last person
 * row, which is inside any range that spans the block. A block whose only
 * person sits on the project's own first row has no "inside", so the row goes
 * directly below it; either way the first row's formulas are compared before
 * and after, and a block whose formulas did not stretch is named in the alert.
 *
 * The new row is a copy of an existing person row (formulas, formatting, data
 * validation) with every constant cleared, so it keeps the formulas the other
 * rows have and nothing else. The copy source is the block's last person row,
 * or - when that is the project's first row, which also carries the
 * project-level rollup formulas - the nearest ordinary person row elsewhere.
 * Rate is one of the constants cleared; a blank Rate is reported, because it
 * prices that person's unbilled hours at $0 in the cost rollup.
 *
 * Returns { added: [{project, person, row}], warnings: [] }. Row numbers are
 * final: blocks are processed top-down, so later inserts are always below.
 */
function addMissingPeople_(sheet, layout, idx, join, grid, targets) {
  var out = { added: [], warnings: [] };
  if (!ADD_MISSING_PEOPLE || !grid.lastWritable) return out;

  var wanted = {};   // normalized project -> { normalized person -> name to write }
  var tooLong = {};
  targets.forEach(function (t) {
    if (t.row || !t.sheetProject || !t.person.key || !(t.hours > 0)) return;
    if (!grid.colOf[t.monthKey] || t.monthKey > grid.lastWritable) return;
    var n = normalize_(t.person.name);
    if (!n) return;

    // Prefer the spelling already on the sheet, then QuickBooks' own
    // DisplayName - column B has to match "QBD People" for hours to land.
    var hit = idx.personByName[n];
    var name = String(t.sheetPerson || (hit && hit !== AMBIGUOUS && hit.name) ||
      t.person.name).trim();
    // readCurrentLayout_ ignores a column B longer than 40 characters, so
    // such a row would never be recognised and would be re-added every run.
    if (name.length > 40) { tooLong[name] = true; return; }

    var pk = normalize_(t.sheetProject);
    if (!wanted[pk]) wanted[pk] = {};
    wanted[pk][n] = name;
  });
  Object.keys(tooLong).forEach(function (name) {
    out.warnings.push('"' + name + '" has hours but was not added: the name is over 40 ' +
      'characters, which "' + SOURCE_SHEET + '" column B treats as a note.');
  });

  // Ordinary (non-first-row) person rows, usable as a copy source for a block
  // that has none of its own.
  var spares = [];
  layout.forEach(function (p) {
    p.people.forEach(function (person) {
      if (person.row !== p.headerRow) spares.push(person.row);
    });
  });

  // Row numbers in `layout` were read before any insert. shifted() converts
  // one to where that row is now.
  var shifts = [];
  function shifted(row) {
    var r = row;
    shifts.forEach(function (s) { if (row >= s.from) r += s.n; });
    return r;
  }

  var width = sheet.getLastColumn();
  var rollupWidth = COL_CONTRACT_VALUE - COL_COST_ROLLUP + 1;
  var done = {};

  layout.forEach(function (p) {
    var pk = normalize_(p.name);
    if (!wanted[pk] || done[pk]) return;
    done[pk] = true;

    var names = Object.keys(wanted[pk]).map(function (k) { return wanted[pk][k]; }).sort();
    var n = names.length;
    var last = p.people[p.people.length - 1].row;
    var header = shifted(p.headerRow);
    var before = sheet.getRange(header, COL_COST_ROLLUP, 1, rollupWidth).getFormulas()[0];

    var first, template, templateIsHeader = false;
    if (last !== p.headerRow) {
      first = shifted(last);
      sheet.insertRowsBefore(first, n);
      shifts.push({ from: last, n: n });
      template = shifted(last);          // the old last row, now below the new ones
    } else {
      first = shifted(last) + 1;
      sheet.insertRowsAfter(first - 1, n);
      shifts.push({ from: last + 1, n: n });
      if (spares.length) {
        var nearest = spares.reduce(function (a, b) {
          return Math.abs(b - last) < Math.abs(a - last) ? b : a;
        });
        template = shifted(nearest);
      } else {
        template = shifted(last);
        templateIsHeader = true;
      }
    }

    try {
      var source = sheet.getRange(template, 1, 1, width);
      for (var i = 0; i < n; i++) {
        var r = first + i;
        source.copyTo(sheet.getRange(r, 1, 1, width));
        clearConstants_(sheet, r, width);
        sheet.getRange(r, 1, 1, width).clearNote();
        if (templateIsHeader) {
          // The project's first row was the only thing to copy: drop its
          // project-level formulas, which belong on that row alone.
          sheet.getRange(r, COL_COST_ROLLUP, 1, rollupWidth).clearContent();
        }
      }
    } catch (err) {
      out.warnings.push('Row(s) were added under "' + p.name + '" but the formulas could ' +
        'not be copied into them (' + err.message + ') - copy them down by hand.');
    }

    names.forEach(function (name, i) {
      sheet.getRange(first + i, COL_PERSON).setValue(name);
      out.added.push({ project: p.name, person: name, row: first + i });
    });

    var after = sheet.getRange(header, COL_COST_ROLLUP, 1, rollupWidth).getFormulas()[0];
    var had = before.some(function (f) { return !!f; });
    var stretched = before.some(function (f, i) { return f !== after[i]; });
    if (had && !stretched) {
      out.warnings.push('The formulas on row ' + header + ' ("' + p.name + '") did not ' +
        'stretch to cover new row' + (n === 1 ? ' ' + first : 's ' + first + '-' + (first + n - 1)) +
        ' - check that the project\'s totals include ' + (n === 1 ? 'it' : 'them') + '.');
    }
  });

  return out;
}

/** Clears every cell in a row that is not a formula, keeping all formatting. */
function clearConstants_(sheet, row, width) {
  var formulas = sheet.getRange(row, 1, 1, width).getFormulas()[0];
  var runs = [], start = -1;
  for (var c = 0; c <= width; c++) {
    var constant = c < width && !formulas[c];
    if (constant && start < 0) start = c;
    if (!constant && start >= 0) {
      runs.push(colLetter_(start + 1) + row + ':' + colLetter_(c) + row);
      start = -1;
    }
  }
  if (runs.length) sheet.getRangeList(runs).clearContent();
}

function peopleAddedReport_(people, layout) {
  if (!people.added.length && !people.warnings.length) return '';

  var msg = '';
  if (people.added.length) {
    var rateOf = rowIndex_(layout).rateOf;
    msg += 'Added ' + people.added.length + ' row(s) for people with hours but no row:\n';
    people.added.slice(0, 15).forEach(function (a) {
      msg += '- ' + a.person + ' -> ' + a.project + ' (row ' + a.row +
        (rateOf[a.row] ? '' : ', no Rate yet') + ')\n';
    });
    if (people.added.length > 15) msg += '- ... and ' + (people.added.length - 15) + ' more\n';
    if (people.added.some(function (a) { return !rateOf[a.row]; })) {
      msg += 'Fill in Rate (column ' + colLetter_(COL_RATE) + ') on the rows marked "no Rate ' +
        'yet" - until then their unbilled hours count as $0.\n';
    }
  }
  people.warnings.forEach(function (w) { msg += 'CHECK: ' + w + '\n'; });
  return msg + '\n';
}

// ---------------------------------------------------------------------------
// Cost rollup (column BX) and funds remaining (column CB)
// ---------------------------------------------------------------------------

/** A sheet cell holding a date, as "yyyy-MM-dd"; '' if it is not one. */
function ymdOf_(v) {
  if (v instanceof Date) {
    return isNaN(v.getTime()) ? ''
      : v.getFullYear() + '-' + pad2_(v.getMonth() + 1) + '-' + pad2_(v.getDate());
  }
  var s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  var m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);   // a date typed as text
  if (!m) return '';
  return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + pad2_(Number(m[1])) + '-' +
    pad2_(Number(m[2]));
}

/** "2026-01" -> "2025-12". */
function prevMonth_(ym) {
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1;
  if (!m) { y--; m = 12; }
  return y + '-' + pad2_(m);
}

/**
 * The date a project's invoices start counting from, or '' for all of them.
 *
 * A tag has no dates on it, and a QuickBooks customer outlives any one
 * contract: a client invoiced directly years ago, last year's job tagged to
 * the same block as this year's, a job reused from one contract period to the
 * next. Without a start, all of that lands on today's project.
 *
 * The start is the block's own Start Date (column CH), which someone typed
 * from the contract. Until v3.4 it was guessed from the project's first
 * logged hours instead, and that guess was wrong in both directions: time in
 * QuickBooks only goes back as far as timesheets have been kept there, so an
 * older project's "first hours" fell years after it really began and its
 * early invoices were dropped.
 *
 * COST_ROLLUP_START overrides column CH per project. A blank Start Date
 * counts every invoice, and the cell's note says so.
 */
function rollupStart_(name, startDate) {
  var forced = '';
  Object.keys(COST_ROLLUP_START).forEach(function (k) {
    if (normalize_(k) === normalize_(name)) forced = String(COST_ROLLUP_START[k] || '').trim();
  });
  if (forced) {
    return /^\d{4}-\d{2}-\d{2}$/.test(forced)
      ? { from: forced, why: 'set in COST_ROLLUP_START' }
      : { from: '', why: 'COST_ROLLUP_START says all' };
  }
  var ymd = ymdOf_(startDate);
  return ymd
    ? { from: ymd, why: 'Start Date, column ' + colLetter_(COL_START_DATE) }
    : { from: '', why: 'no Start Date in column ' + colLetter_(COL_START_DATE) };
}

/**
 * Total cost to date for each project block, from QuickBooks:
 *
 *   invoiced          net dollars on invoices minus credit memos, from the
 *                     project's Start Date (see rollupStart_) to today
 * + not yet invoiced  hours QuickBooks marks Billable (worked, chargeable, on
 *                     no invoice yet) through the last complete month, each
 *                     priced at that person's Rate for that project
 *
 * Billed work is taken from invoice amounts rather than hours x Rate because
 * rates change every year by uneven amounts; today's Rate applied to old
 * hours would not reproduce what was really billed. Unbilled hours have no
 * invoice to read, and are recent, so today's Rate is the right price.
 *
 * The two halves cannot overlap as long as invoices are built from time in
 * QuickBooks (Add Time/Costs), because that is what flips an entry from
 * Billable to HasBeenBilled. On a project invoiced some other way - a typed
 * fixed-fee amount, say - hours stay Billable forever and would be counted on
 * top of the invoices; the cell note shows both halves so that is visible.
 *
 * The current month is left out of the unbilled half: its grid column holds a
 * hand-entered estimate, and counting partial actuals here as well would
 * double up with it.
 *
 * WHICH PROJECT AN INVOICE BELONGS TO
 *
 * In this company file hours are logged on tasks and invoices are raised one
 * level up, on the job the tasks sit under:
 *
 *   Puerto Rico Highways And Transportation       client
 *     4120-TSMO & ITS Arch                        job    <- invoices
 *       T1-ProjManagement, T4-ITS Architecture    tasks  <- hours
 *
 * So an invoice's own row in "QBD Customers" is the one row of the job that
 * carries no hours, which makes its tag the one nothing else cross-checks. A
 * wrong tag there moved a whole contract's billing onto another project and
 * left the hours grid looking perfectly right. And where one job's tasks
 * belong to two blocks on the sheet, no single tag on the job can be right.
 *
 * So the tasks decide, not the job's own row:
 *
 *   - Nothing tagged beneath the invoiced customer, or the customers beneath
 *     it are invoiced themselves (it is a client, not a job): its own tag.
 *   - Otherwise the tags beneath it. One project: that project. Several: the
 *     invoice is split between them by the hours each logged under the job in
 *     the invoice's month and the month before, or by all their hours under
 *     it when those months have none.
 *
 * A job whose own tag appears on none of its tasks is reported as a wrong tag
 * (out.tagConflicts), and every split is reported (out.sharedJobs). A split
 * is an estimate - an invoice does not say which task it billed - and the
 * note says so.
 */
function buildCostRollup_(layout, idx, join, targets) {
  var now = new Date();
  var out = {
    skipped: false, capped: false, projects: {}, invoices: 0,
    untagged: 0, untaggedByParent: {}, noBlock: 0, noDate: 0, unsplit: 0,
    tagConflicts: [], sharedJobs: [],
    thisMonth: monthStart_(now, 0).slice(0, 7),
    through: monthStart_(now, 1).slice(0, 7),
    today: now.getFullYear() + '-' + pad2_(now.getMonth() + 1) + '-' + pad2_(now.getDate())
  };

  function project_(name) {
    if (!out.projects[name]) {
      out.projects[name] = {
        invoiced: 0, invoiceCount: 0, invFirst: '', invLast: '', shared: 0,
        unbilledHours: 0, unbilledDollars: 0, unpricedHours: 0, unknownHours: 0,
        firstHours: '', from: '', why: '',
        excluded: 0, excludedCount: 0, exclFirst: '', exclLast: '',
        customers: {}, counted: [], ignoredTags: []
      };
    }
    return out.projects[name];
  }

  function customer_(p, name) {
    return p.customers[name] || (p.customers[name] = {
      counted: 0, countedCount: 0, first: '', last: '', of: 0, sharedWith: [],
      excluded: 0, excludedCount: 0, exclFirst: '', exclLast: '',
      hours: 0, hoursFirst: '', hoursLast: ''
    });
  }

  function span_(o, first, last, date) {
    if (!o[first] || date < o[first]) o[first] = date;
    if (!o[last] || date > o[last]) o[last] = date;
  }

  /** Keys of every customer above this one: "A:B:C" -> [key("A"), key("A:B")]. */
  function ancestors_(full) {
    var parts = String(full || '').split(':');
    var keys = [];
    for (var i = 1; i < parts.length; i++) keys.push(normalize_(parts.slice(0, i).join(':')));
    return keys;
  }

  var rateOf = rowIndex_(layout).rateOf;

  // Hours logged at or beneath each customer, per project tag: what a split
  // invoice is shared out by. Hours marked Not Billable were never invoiced.
  var hoursUnder = {};

  targets.forEach(function (t) {
    if (!t.txnDate || !(t.hours > 0)) return;

    if (t.project && t.billable !== 'nonbillable') {
      var tagKey = normalize_(t.project);
      ancestors_(t.customer).concat(normalize_(t.customer)).forEach(function (a) {
        var byTag = hoursUnder[a] || (hoursUnder[a] = {});
        var h = byTag[tagKey] || (byTag[tagKey] = { all: 0, byMonth: {} });
        h.all += t.hours;
        h.byMonth[t.monthKey] = (h.byMonth[t.monthKey] || 0) + t.hours;
      });
    }

    if (!t.sheetProject) return;
    var p = project_(t.sheetProject);
    if (!p.firstHours || t.txnDate < p.firstHours) p.firstHours = t.txnDate;

    // Which customer the hours sit on, to set beside what each was invoiced.
    var c = customer_(p, t.customer);
    c.hours += t.hours;
    span_(c, 'hoursFirst', 'hoursLast', t.txnDate);

    if (t.monthKey >= out.thisMonth) return;
    // No status is not evidence the hours are free. They are not priced, but
    // they are reported, rather than quietly treated as non-billable.
    if (t.billable === 'unknown') { p.unknownHours += t.hours; return; }
    if (t.billable !== 'unbilled') return;

    var rate = t.row ? (rateOf[t.row] || 0) : 0;
    p.unbilledHours += t.hours;
    if (rate) p.unbilledDollars += t.hours * rate;
    else p.unpricedHours += t.hours;   // no row under the project, or a blank Rate
  });

  layout.forEach(function (lp) {
    var p = project_(lp.name);
    var start = rollupStart_(lp.name, lp.startDate);
    p.from = start.from;
    p.why = start.why;
  });

  var invoices = qboQueryAll_('Invoice');
  // Empty means the agent has never sent invoices (pre-v1.4). Leave the
  // column as it is rather than write numbers that are missing their main part.
  if (!invoices.length) { out.skipped = true; return out; }
  out.capped = invoices.filter(function (v) { return v.Type === 'Invoice'; }).length >=
    QBD_INVOICE_ROW_CAP;

  // The customer tree, as the tags see it: for each customer, the Project
  // tags on the rows beneath it, and whether anything beneath it is invoiced.
  var tagsBelow = {};
  idx.customers.forEach(function (c) {
    var tag = String(c.Project || '').trim();
    if (!tag) return;
    ancestors_(c.FullyQualifiedName || c.DisplayName).forEach(function (a) {
      (tagsBelow[a] || (tagsBelow[a] = {}))[normalize_(tag)] = tag;
    });
  });
  var invoicedBelow = {};
  invoices.forEach(function (v) {
    ancestors_(v.CustomerName).forEach(function (a) { invoicedBelow[a] = true; });
  });

  var conflicts = {}, shared = {};

  /**
   * Who an invoice is charged to: [{ tag, sheet, share }], shares summing to 1,
   * or [] when nothing says. `split` marks a job shared between projects.
   */
  function owners_(v) {
    var key = normalize_(v.CustomerName);
    var own = resolveProject_(idx, v.CustomerId, v.CustomerName);
    var below = tagsBelow[key] || {};
    var belowKeys = Object.keys(below).sort();

    if (!belowKeys.length || invoicedBelow[key]) {
      return { split: false, list: own ? [{ tag: own, share: 1 }] : [] };
    }

    if (own && !below[normalize_(own)]) {
      var k = conflicts[key] || (conflicts[key] = {
        job: v.CustomerName, tag: own, amount: 0, count: 0,
        below: belowKeys.map(function (b) { return below[b]; })
      });
      k.amount += v.Amount;
      k.count++;
    }

    if (belowKeys.length === 1) {
      return { split: false, list: [{ tag: below[belowKeys[0]], share: 1 }] };
    }

    // Several projects under one invoiced job. Only a project that had
    // started by the invoice date can have been billed on it.
    var live = belowKeys.filter(function (b) {
      var sheet = join.projectNameToSheet[b];
      return !sheet || !project_(sheet).from || v.TxnDate >= project_(sheet).from;
    });
    if (!live.length) {
      return { split: true, early: true,
        list: belowKeys.map(function (b) { return { tag: below[b], share: 1 }; }) };
    }

    var under = hoursUnder[key] || {};
    function shares_(hoursOf) {
      var w = live.map(function (b) { return under[b] ? hoursOf(under[b]) : 0; });
      var sum = w.reduce(function (a, x) { return a + x; }, 0);
      return sum > 0 ? w.map(function (x) { return x / sum; }) : null;
    }
    var month = v.TxnDate.slice(0, 7), before = prevMonth_(month);
    var shares = live.length === 1 ? [1]
      : shares_(function (h) { return (h.byMonth[month] || 0) + (h.byMonth[before] || 0); }) ||
        shares_(function (h) { return h.all; });
    if (!shares) return { split: true, list: [] };   // no hours anywhere to split by

    return {
      split: true,
      list: live.map(function (b, i) { return { tag: below[b], share: shares[i] }; })
        .filter(function (o) { return o.share > 0; })
    };
  }

  invoices.forEach(function (v) {
    if (!v.TxnDate) { out.noDate += v.Amount; return; }
    out.invoices++;

    var name = v.CustomerName || '(no customer)';
    var who = owners_(v);
    if (!who.list.length) {
      if (who.split) { out.unsplit += v.Amount; return; }
      // By top-level parent, as checkProjectTags does: invoices are often
      // raised on a parent job while time sits on its sub-jobs, so the parent
      // is the thing that needs a tag.
      var top = String(name).split(':')[0].trim();
      out.untaggedByParent[top] = (out.untaggedByParent[top] || 0) + v.Amount;
      out.untagged += v.Amount;
      return;
    }

    var partners = who.list.map(function (o) { return o.tag; });
    var job = null;
    if (who.split && !who.early) {
      job = shared[normalize_(name)] ||
        (shared[normalize_(name)] = { job: name, amount: 0, count: 0, to: {} });
      job.amount += v.Amount;
      job.count++;
    }

    who.list.forEach(function (o) {
      var amount = v.Amount * o.share;
      if (job) job.to[o.tag] = (job.to[o.tag] || 0) + amount;

      var sheetProject = join.projectNameToSheet[normalize_(o.tag)];
      if (!sheetProject) { if (!who.early) out.noBlock += amount; return; }

      var p = project_(sheetProject);
      var c = customer_(p, name);
      if (who.split) {
        partners.forEach(function (t) {
          if (t !== o.tag && c.sharedWith.indexOf(t) < 0) c.sharedWith.push(t);
        });
      }

      if (who.early || (p.from && v.TxnDate < p.from)) {
        p.excluded += amount; p.excludedCount++;
        c.excluded += amount; c.excludedCount++;
        span_(p, 'exclFirst', 'exclLast', v.TxnDate);
        span_(c, 'exclFirst', 'exclLast', v.TxnDate);
        return;
      }
      p.invoiced += amount; p.invoiceCount++;
      c.counted += amount; c.countedCount++;
      span_(p, 'invFirst', 'invLast', v.TxnDate);
      span_(c, 'first', 'last', v.TxnDate);
      if (who.split) { p.shared += amount; c.of += v.Amount; }
      p.counted.push({ invoice: v, amount: amount });
    });
  });

  Object.keys(conflicts).forEach(function (key) {
    var k = conflicts[key];
    out.tagConflicts.push(k);
    var sheetProject = join.projectNameToSheet[normalize_(k.tag)];
    if (sheetProject) project_(sheetProject).ignoredTags.push(k);
  });
  Object.keys(shared).forEach(function (key) { out.sharedJobs.push(shared[key]); });

  return out;
}

/** The breakdown behind one project's cost rollup, as lines of text. */
function costLines_(d, roll) {
  var lines = [
    'Invoiced: ' + money_(d.invoiced) + ' - ' + d.invoiceCount + ' invoice(s)/credit memo(s)' +
      (d.invFirst ? ', ' + d.invFirst + ' to ' + d.invLast : '')
  ];
  if (d.shared) {
    lines.push('  ' + money_(d.shared) + ' of that is an estimate: this project\'s share of ' +
      'invoices on a job it shares with other projects, split by hours');
  }
  lines.push('Not yet invoiced: ' + money_(d.unbilledDollars) + ' - ' + round2_(d.unbilledHours) +
    ' billable hrs through ' + monthLabel_(roll.through) + ' x Rate');
  if (d.unpricedHours) {
    lines.push('  ' + round2_(d.unpricedHours) + ' of those hrs have no Rate - counted as $0');
  }
  if (d.unknownHours) {
    lines.push(round2_(d.unknownHours) + ' hrs have no billable status in QuickBooks - not counted');
  }
  lines.push(d.from
    ? 'Counting invoices from ' + d.from + ' (' + d.why + ')'
    : 'Counting every invoice on its jobs (' + d.why + ')');
  if (d.excludedCount) {
    lines.push('Left out: ' + money_(d.excluded) + ' on ' + d.excludedCount +
      ' earlier invoice(s)/credit memo(s), ' + d.exclFirst + ' to ' + d.exclLast);
  }
  d.ignoredTags.forEach(function (k) {
    lines.push('WRONG TAG, not counted here: "' + k.job + '" is tagged to this project, but ' +
      'the tasks beneath it are tagged ' + k.below.join(', ') + '. Its ' + k.count +
      ' invoice(s), ' + money_(k.amount) + ', went to those instead. Fix the tag in "' +
      QBD_CUSTOMERS_SHEET + '" column D.');
  });
  return lines;
}

/**
 * One line per QuickBooks customer feeding a project: what it was invoiced,
 * and the hours logged on it. Invoices sit on the job and hours on its tasks,
 * so a job normally shows dollars and no hours, and its tasks the reverse.
 */
function customerLines_(d, max) {
  var names = Object.keys(d.customers).sort(function (a, b) {
    var ca = d.customers[a], cb = d.customers[b];
    return (Math.abs(cb.counted) + Math.abs(cb.excluded)) -
      (Math.abs(ca.counted) + Math.abs(ca.excluded)) || cb.hours - ca.hours;
  });
  var lines = names.slice(0, max).map(function (name) {
    var c = d.customers[name];
    var parts = [];
    if (c.countedCount) {
      parts.push(money_(c.counted) + ' counted (' + c.countedCount + ' inv, ' + c.first +
        ' to ' + c.last + ')' +
        (c.sharedWith.length ? ' - its share of ' + money_(c.of) + ', split by hours with ' +
          c.sharedWith.join(', ') : ''));
    }
    if (c.excludedCount) {
      parts.push(money_(c.excluded) + ' LEFT OUT (' + c.excludedCount + ' inv, ' +
        c.exclFirst + ' to ' + c.exclLast + ')');
    }
    if (!c.countedCount && !c.excludedCount) parts.push('no invoices');
    parts.push(c.hours
      ? round2_(c.hours) + ' hrs logged, ' + c.hoursFirst + ' to ' + c.hoursLast
      : 'no hours logged');
    return '- ' + name + ': ' + parts.join('; ');
  });
  if (names.length > max) lines.push('- ... and ' + (names.length - max) + ' more');
  return lines;
}

/**
 * Writes each project's total cost to date into column BX on its first row,
 * with the breakdown as a note on the cell so the number can always be traced.
 * A cell there holding a formula is left alone and reported, not overwritten.
 */
function writeCostRollup_(sheet, layout, roll) {
  var out = {
    total: 0, invoiced: 0, unbilled: 0, unbilledHours: 0, projects: 0,
    formulaCells: [], unpriced: [], unknown: [], excluded: [], noStart: []
  };
  if (roll.skipped) return out;

  // The column used to hold prior years only. Rename the header to match, but
  // only if it still carries the old name - a header someone chose is theirs.
  var head = sheet.getRange(SOURCE_HEADER_ROW, COL_COST_ROLLUP);
  if (!head.getFormula() &&
      /^previous years cost rollup$/i.test(String(head.getValue()).trim())) {
    head.setValue('Total cost rollup');
  }

  // One read for the whole column, so the formula check costs one call.
  var headerRows = layout.map(function (p) { return p.headerRow; });
  var firstRow = Math.min.apply(null, headerRows);
  var lastRow = Math.max.apply(null, headerRows);
  var formulas = sheet.getRange(firstRow, COL_COST_ROLLUP, lastRow - firstRow + 1, 1)
    .getFormulas();

  // Per-cell writes, not one setValues over the span: the span also covers
  // every person row in between, and rewriting those would flatten any
  // formula sitting in them. There are only a few dozen projects.
  layout.forEach(function (p) {
    if (formulas[p.headerRow - firstRow][0]) {
      out.formulaCells.push(colLetter_(COL_COST_ROLLUP) + p.headerRow + ' (' + p.name + ')');
      return;
    }
    var d = roll.projects[p.name];
    var amount = round2_(d.invoiced + d.unbilledDollars);
    var byCustomer = customerLines_(d, 6);
    sheet.getRange(p.headerRow, COL_COST_ROLLUP)
      .setValue(amount)
      .setNote(['Total cost to date, from QuickBooks - Refresh Hours ' + roll.today]
        .concat(costLines_(d, roll))
        .concat(byCustomer.length ? ['By QuickBooks customer:'].concat(byCustomer) : [])
        .join('\n'));

    out.total += amount;
    out.invoiced += d.invoiced;
    out.unbilled += d.unbilledDollars;
    out.unbilledHours += d.unbilledHours;
    if (amount) out.projects++;
    if (d.unpricedHours) out.unpriced.push({ name: p.name, hours: d.unpricedHours });
    if (d.unknownHours) out.unknown.push({ name: p.name, hours: d.unknownHours });
    if (!d.from && d.invoiceCount) out.noStart.push(p.name);
    if (d.excludedCount) {
      out.excluded.push({
        name: p.name, amount: d.excluded, count: d.excludedCount,
        first: d.exclFirst, last: d.exclLast, from: d.from
      });
    }
  });

  return out;
}

function costRollupReport_(roll, cost) {
  var col = 'Column ' + colLetter_(COL_COST_ROLLUP);
  if (roll.skipped) {
    return col + ' (total cost to date) NOT updated: "' + QBD_INVOICES_SHEET +
      '" is empty. The local agent must be v1.4 or later to send invoices - update ' +
      'server1.3.js, restart it, and sync again.\n';
  }

  function top_(list, weigh, line) {
    var sorted = list.slice().sort(function (a, b) { return Math.abs(weigh(b)) - Math.abs(weigh(a)); });
    var text = '';
    sorted.slice(0, 6).forEach(function (x) { text += '    - ' + line(x) + '\n'; });
    if (sorted.length > 6) text += '    - ... and ' + (sorted.length - 6) + ' more\n';
    return text;
  }

  var msg = col + ' (total cost to date): ' + money_(cost.total) + ' across ' + cost.projects +
    ' project(s) = ' + money_(cost.invoiced) + ' invoiced + ' + money_(cost.unbilled) +
    ' not yet invoiced (' + round2_(cost.unbilledHours) + ' billable hrs through ' +
    monthLabel_(roll.through) + ' x Rate). Each cell\'s note shows its own breakdown.\n';

  if (roll.tagConflicts.length) {
    msg += '  WRONG TAG in "' + QBD_CUSTOMERS_SHEET + '" column D - an invoiced job tagged to ' +
      'a project none of its tasks are tagged to. The tasks were followed, not the job:\n' +
      top_(roll.tagConflicts, function (k) { return k.amount; }, function (k) {
        return k.job + ' is tagged "' + k.tag + '"; its tasks are tagged ' +
          k.below.join(', ') + '. ' + money_(k.amount) + ' on ' + k.count +
          ' invoice(s) kept out of "' + k.tag + '"';
      }) +
      '    Clear or correct the tag on that row.\n';
  }
  if (roll.sharedJobs.length) {
    msg += '  Split by hours - invoices on a job whose tasks belong to more than one ' +
      'project. An estimate: an invoice does not say which task it billed.\n' +
      top_(roll.sharedJobs, function (j) { return j.amount; }, function (j) {
        return j.job + ': ' + money_(j.amount) + ' on ' + j.count + ' invoice(s) -> ' +
          Object.keys(j.to).sort().map(function (t) { return t + ' ' + money_(j.to[t]); })
            .join(', ');
      });
  }
  if (roll.unsplit) {
    msg += '  ' + money_(roll.unsplit) + ' on jobs shared between projects, with no hours ' +
      'logged beneath them to split by - not counted.\n';
  }
  if (cost.excluded.length) {
    msg += '  Invoices dated before the project\'s Start Date, left out:\n' +
      top_(cost.excluded, function (x) { return x.amount; }, function (x) {
        return x.name + ': ' + money_(x.amount) + ' on ' + x.count + ' invoice(s), ' +
          x.first + ' to ' + x.last + ' (start ' + x.from + ')';
      }) +
      '    If one of these does belong to the project, correct its Start Date in column ' +
      colLetter_(COL_START_DATE) + '.\n';
  }
  if (cost.noStart.length) {
    msg += '  No Start Date in column ' + colLetter_(COL_START_DATE) + ', so every invoice ' +
      'ever raised on their jobs is counted: ' + cost.noStart.join(', ') + '.\n';
  }
  if (cost.unpriced.length) {
    msg += '  Billable hours not yet invoiced that have no Rate in column ' +
      colLetter_(COL_RATE) + ' - counted as $0:\n' +
      top_(cost.unpriced, function (x) { return x.hours; }, function (x) {
        return x.name + ': ' + round2_(x.hours) + ' hrs';
      });
  }
  if (cost.unknown.length) {
    msg += '  Hours with no billable status in QuickBooks - not counted:\n' +
      top_(cost.unknown, function (x) { return x.hours; }, function (x) {
        return x.name + ': ' + round2_(x.hours) + ' hrs';
      });
  }
  if (roll.untagged) {
    msg += '  ' + money_(roll.untagged) + ' billed to customers with no Project tag in "' +
      QBD_CUSTOMERS_SHEET + '" column D - not counted. Largest:\n';
    var byParent = roll.untaggedByParent;
    msg += top_(Object.keys(byParent), function (k) { return byParent[k]; }, function (k) {
      return k + ': ' + money_(byParent[k]);
    });
  }
  if (roll.noBlock) {
    msg += '  ' + money_(roll.noBlock) + ' billed to tagged projects with no block on "' +
      SOURCE_SHEET + '" - not counted.\n';
  }
  if (roll.noDate) {
    msg += '  ' + money_(roll.noDate) + ' on invoices with no date - not counted.\n';
  }
  if (cost.formulaCells.length) {
    msg += '  Left alone because they hold a formula: ' + cost.formulaCells.join(', ') + '.\n';
  }
  if (roll.capped) {
    msg += '  WARNING: "' + QBD_INVOICES_SHEET + '" has ' + QBD_INVOICE_ROW_CAP + '+ rows, ' +
      'the agent\'s MaxReturned cap. QuickBooks may have cut the list short, which would ' +
      'understate ' + col + '. Raise MAX_RETURNED.Invoice in server1.3.js and ' +
      'QBD_INVOICE_ROW_CAP here, then sync again.\n';
  }
  return msg;
}

/**
 * Menu: shows exactly where one project's cost rollup comes from - which
 * QuickBooks customers feed it, how much each contributes, over what dates,
 * the hours on each, what was left out, and the invoices themselves. Read-only.
 * Select any cell in the project's block on "test_current" first.
 *
 * This exists because a wrong rollup is almost always a tagging question
 * ("which customer is pouring money into this project?") and the total alone
 * cannot answer it.
 */
function explainCostRollup() {
  var ss = SpreadsheetApp.getActive();
  var ui = SpreadsheetApp.getUi();
  var layout = readCurrentLayout_();

  var block = null;
  if (ss.getActiveSheet().getName() === SOURCE_SHEET) {
    var row = ss.getActiveCell().getRow();
    layout.forEach(function (p) { if (p.headerRow <= row) block = p; });
    if (block && row > Math.max(block.headerRow, block.people[block.people.length - 1].row)) {
      block = null;
    }
  }
  if (!block) {
    ui.alert('Select a cell in a project\'s block on "' + SOURCE_SHEET + '" first, then run ' +
      'this again.');
    return;
  }

  var idx = buildQboIndexes_();
  var join = buildJoin_(idx, layout);
  var targets = resolveEntries_(qboQueryAll_('TimeActivity'), idx, join, rowIndex_(layout).rowOf);
  var roll = buildCostRollup_(layout, idx, join, targets);
  if (roll.skipped) {
    ui.alert('"' + QBD_INVOICES_SHEET + '" is empty - there are no invoices to explain yet.');
    return;
  }

  var d = roll.projects[block.name];
  var msg = block.name + '\n\n' +
    'Total cost to date: ' + money_(round2_(d.invoiced + d.unbilledDollars)) + '\n' +
    costLines_(d, roll).join('\n') + '\n' +
    (d.firstHours ? 'First hours in the QuickBooks data: ' + d.firstHours + '\n' : '') +
    '\nBy QuickBooks customer:\n';

  var byCustomer = customerLines_(d, 20);
  msg += (byCustomer.length ? byCustomer.join('\n')
    : '- no invoices or hours on any customer tagged to this project') + '\n';

  // The invoices themselves, newest first: a customer name says where the
  // money came in, but only the invoice numbers can be checked in QuickBooks.
  if (d.counted.length) {
    var counted = d.counted.slice().sort(function (a, b) {
      return a.invoice.TxnDate < b.invoice.TxnDate ? 1 : a.invoice.TxnDate > b.invoice.TxnDate ? -1 : 0;
    });
    msg += '\nInvoices counted (' + counted.length + '), newest first:\n';
    counted.slice(0, 30).forEach(function (x) {
      var v = x.invoice;
      msg += '- ' + v.TxnDate + '  ' + (v.Type === 'CreditMemo' ? 'credit memo ' : '') +
        '#' + (v.RefNumber || '?') + '  ' + money_(x.amount) +
        (Math.abs(x.amount - v.Amount) > 0.005 ? ' of ' + money_(v.Amount) : '') + '  ' +
        (v.CustomerName || '(no customer)') + '\n';
    });
    if (counted.length > 30) msg += '- ... and ' + (counted.length - 30) + ' older\n';
  }

  ui.alert(msg);
}

/**
 * Column CB: Funds Remaining = Contract Value - total cost rollup, written as
 * a live formula on each project's first row so it follows later edits to
 * Contract Value.
 *
 * QuickBooks Desktop has no such figure to read - a job carries no contract
 * amount - so the contract value stays hand-entered in column CF and this is
 * the subtraction.
 *
 * Left alone, and reported: a row with no numeric Contract Value (the result
 * would be a negative number that looks like an overrun), and a cell that
 * already holds some other formula.
 */
function writeFundsRemaining_(sheet, layout, roll) {
  var out = { off: !WRITE_FUNDS_REMAINING, written: 0, noContract: [], kept: [] };
  if (out.off || roll.skipped) { out.off = true; return out; }

  var headerRows = layout.map(function (p) { return p.headerRow; });
  var firstRow = Math.min.apply(null, headerRows);
  var lastRow = Math.max.apply(null, headerRows);
  var formulas = sheet.getRange(firstRow, COL_FUNDS_REMAINING, lastRow - firstRow + 1, 1)
    .getFormulas();

  layout.forEach(function (p) {
    var want = '=' + colLetter_(COL_CONTRACT_VALUE) + p.headerRow + '-' +
      colLetter_(COL_COST_ROLLUP) + p.headerRow;
    var existing = formulas[p.headerRow - firstRow][0];
    if (existing) {
      if (existing.replace(/[\s$]/g, '').toUpperCase() === want) out.written++;
      else out.kept.push(colLetter_(COL_FUNDS_REMAINING) + p.headerRow + ' (' + p.name + ')');
      return;
    }
    if (typeof p.contractValue !== 'number' || !(p.contractValue > 0)) {
      out.noContract.push(p.name);
      return;
    }
    sheet.getRange(p.headerRow, COL_FUNDS_REMAINING).setFormula(want);
    out.written++;
  });

  return out;
}

function fundsRemainingReport_(funds) {
  if (funds.off) return '';
  var col = 'Column ' + colLetter_(COL_FUNDS_REMAINING);
  var msg = col + ' (funds remaining) = Contract Value - ' + colLetter_(COL_COST_ROLLUP) +
    ' on ' + funds.written + ' project(s).\n';
  if (funds.noContract.length) {
    msg += '  No numeric Contract Value in column ' + colLetter_(COL_CONTRACT_VALUE) +
      ', so left as is: ' + funds.noContract.slice(0, 8).join(', ') +
      (funds.noContract.length > 8 ? ', and ' + (funds.noContract.length - 8) + ' more' : '') + '.\n';
  }
  if (funds.kept.length) {
    msg += '  Left alone because they hold their own formula: ' + funds.kept.join(', ') + '.\n';
  }
  return msg;
}

function money_(n) {
  var s = Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '-$' : '$') + s;
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}

/** 1 -> "A", 27 -> "AA". Used when naming a column in a message. */
function colLetter_(n) {
  var s = '';
  while (n > 0) {
    var m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = (n - m - 1) / 26;
  }
  return s;
}
