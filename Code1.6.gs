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
 * The "test_current" tab is never modified. The month columns are
 * forward-looking estimates; Contract Value (AU), Funds Remaining (AQ), As Of
 * (AS) and Rate (AV) are manually maintained and are only referenced, never
 * overwritten.
 *
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
 * Test Connection.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Echoed by doGet() and by every doPost() reply. Its only job is to make
// "which version of this file is actually deployed?" answerable from outside
// the editor - a question that cost real time, because Apps Script Web App
// deployments are pinned to a saved version and editing + Ctrl+S does not
// change what the /exec URL serves. Bump this whenever this file changes.
var SCRIPT_VERSION = '3.0';

var SOURCE_SHEET = 'test_current';

// This script creates no tabs. Hours are written straight into the month grid
// on "test_current"; the only other sheets it touches are the three the local
// agent pushes into, below.

// Populated by the local QuickBooks Desktop agent's doPost push; read back
// out by qbdRead_(). See "QuickBooks Desktop" section below.
var QBD_CUSTOMERS_SHEET = 'QBD Customers';
var QBD_PEOPLE_SHEET = 'QBD People';
var QBD_TIME_SHEET = 'QBD Time';

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
var COL_HOURS_ROLLUP = 76;    // BX - only populated on a project's first row
var COL_FUNDS_REMAINING = 79; // CA
var COL_AS_OF = 81;           // CC
var COL_TYPE = 82;            // CD - CPFF / Fixed Fee / Time & Materials / ...
var COL_CONTRACT_VALUE = 83;  // CE
var COL_RATE = 84;            // CF - $/hour, per person per project

// How far right readCurrentLayout_ has to read. Rate is the last column it
// needs, but naming it separately keeps the range obvious if columns move.
var SOURCE_LAST_COL = COL_RATE;

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

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('QuickBooks')
    .addItem('Refresh Hours', 'refreshHours')
    .addSeparator()
    .addItem('Check Project Tags', 'checkProjectTags')
    .addItem('Test Connection', 'testConnection')
    .addItem('Show Sample Time Entries', 'showSampleTimeEntries')
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

  ui.alert('Credentials saved. Now run QuickBooks > Test Connection.');
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

function testConnection() {
  var ui = SpreadsheetApp.getUi();
  var last = PropertiesService.getScriptProperties().getProperty('QBD_LAST_PUSH');
  ui.alert('QuickBooks Desktop\n\n' + (last
    ? 'Last data received from the local agent: ' + last
    : 'No data received yet. Start tools/qbwc-agent and click "Update Now" in ' +
      'QuickBooks Web Connector, then try again.'));
}

/**
 * Dumps a handful of raw TimeActivity records to the execution log. Use this
 * to confirm how hours, people, and projects are actually shaped in your
 * company file before trusting the aggregated numbers.
 */
function showSampleTimeEntries() {
  var rows = qboQueryAll_('TimeActivity', "TxnDate >= '" + monthStart_(new Date(), 3) + "'");
  Logger.log('Found ' + rows.length + ' TimeActivity records in the last 3 months.');
  for (var i = 0; i < Math.min(rows.length, 5); i++) {
    Logger.log(JSON.stringify(rows[i], null, 2));
  }
  SpreadsheetApp.getUi().alert(
    'Found ' + rows.length + ' time entries in the last 3 months.\n\n' +
    'Open Extensions > Apps Script > Executions to see the raw records.');
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
      qbdTime: dataRows_(found.ss, QBD_TIME_SHEET)
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

  if (entity === 'TimeActivity') {
    return readRows_(QBD_TIME_SHEET).map(function (r) {
      var personType = String(r[2] || '');
      // A date-looking string in a plain cell gets auto-coerced to a Date by
      // Sheets on write, so getValues() hands this back as a Date object, not
      // the "yyyy-MM-dd" string doPost() wrote. Read local date parts (never
      // Date-to-string formatting) to avoid the UTC month-boundary shift
      // readCurrentLayout_'s Date guard above is already written to avoid.
      var txnDateRaw = r[1];
      var txnDate = (txnDateRaw instanceof Date)
        ? txnDateRaw.getFullYear() + '-' + pad2_(txnDateRaw.getMonth() + 1) + '-' + pad2_(txnDateRaw.getDate())
        : String(txnDateRaw || '');
      var ta = {
        Id: String(r[0]),
        TxnDate: txnDate,
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
      current = { name: name, headerRow: rowNum, people: [] };
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
      'COL_HOURS_ROLLUP, COL_FUNDS_REMAINING, COL_AS_OF, COL_TYPE, COL_CONTRACT_VALUE, and ' +
      'COL_RATE still point at the right columns before running this again.');
    return;
  }

  // ---- aggregate -------------------------------------------------------
  // byCell["<row>|||<yyyy-MM>"] = { total, billed } for rows on this sheet.
  var byCell = {};
  var rowOf = {};            // "project|||person" -> the FIRST sheet row for that pair
  layout.forEach(function (p) {
    p.people.forEach(function (person) {
      var k = normalize_(p.name) + '|||' + normalize_(person.name);
      if (!(k in rowOf)) rowOf[k] = person.row;   // a repeated person must not double-count
    });
  });

  var entries = qboQueryAll_('TimeActivity');
  var unplaced = {};
  var placedHours = 0, untaggedHours = 0, dataSince = '', dataUntil = '';

  entries.forEach(function (ta) {
    var hours = entryHours_(ta);
    var txnDate = String(ta.TxnDate || '');
    var monthKey = txnDate.slice(0, 7);
    if (txnDate) {
      if (!dataSince || txnDate < dataSince) dataSince = txnDate;
      if (!dataUntil || txnDate > dataUntil) dataUntil = txnDate;
    }

    var person = entryPerson_(ta);
    var customerId = ta.CustomerRef ? String(ta.CustomerRef.value) : '';
    var customerName = (ta.CustomerRef && ta.CustomerRef.name) || '(no customer)';
    var project = resolveProject_(idx, customerId, customerName);
    var sheetProject = project ? join.projectNameToSheet[normalize_(project)] : '';
    var sheetPerson = join.personNameToSheet[normalize_(person.name)];
    var row = (sheetProject && sheetPerson)
      ? rowOf[normalize_(sheetProject) + '|||' + normalize_(sheetPerson)]
      : null;

    if (row && grid.colOf[monthKey]) {
      var key = row + '|||' + monthKey;
      if (!byCell[key]) byCell[key] = { total: 0, billed: 0 };
      byCell[key].total += hours;
      if (billableClass_(ta.BillableStatus) === 'billed') byCell[key].billed += hours;
      placedHours += hours;
      return;
    }

    // Nothing is written to a tab any more, so anything that cannot land in the
    // grid is counted here and summarised in the alert instead. The order
    // matters: each test assumes the ones above it passed, so a person who
    // exists on the sheet but not under THIS project reports as exactly that,
    // rather than falling through to a month-range message that would be false.
    if (!project) untaggedHours += hours;
    var why = !project
      ? 'customer has no Project tag in "' + QBD_CUSTOMERS_SHEET + '" column D'
      : !sheetProject ? 'Project "' + project + '" has no block on "' + SOURCE_SHEET + '"'
      : !sheetPerson ? '"' + person.name + '" is not listed anywhere on "' + SOURCE_SHEET + '"'
      : !row ? '"' + person.name + '" is not listed under "' + sheetProject + '" on "' +
          SOURCE_SHEET + '" - add the row there'
      : 'month ' + (monthKey || '(no date)') + ' is outside the grid on "' + SOURCE_SHEET + '"';
    if (!unplaced[why]) unplaced[why] = 0;
    unplaced[why] += hours;
  });

  var written = writeGrid_(sheet, layout, grid, byCell, dataSince, dataUntil);

  // ---- report ----------------------------------------------------------
  var msg = 'Hours refreshed on "' + SOURCE_SHEET + '".\n\n' +
    entries.length + ' time entries read.\n' +
    round2_(written.hours) + ' hours written into ' + written.cells + ' cells, ' +
    (written.firstLabel === written.lastLabel
      ? written.firstLabel
      : written.firstLabel + ' through ' + written.lastLabel) + '.\n' +
    written.billedOnly + ' cell(s) fully billed, ' + written.mixed + ' mixed.\n\n';

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
