#!/usr/bin/env node
/**
 * SOAP server for the QuickBooks Web Connector (QBWC). Runs locally,
 * alongside QuickBooks Desktop and QBWC itself - see ../../SETUP.md for the
 * one-time registration steps (connector.qwc, Apps Script Web App URL).
 *
 * Session flow QBWC drives: authenticate -> sendRequestXML (repeated) ->
 * receiveResponseXML (repeated) -> closeConnection. Method contract verified
 * against Intuit's QBWebConnectorSvc WSDL and the QBWC Programmer's Guide.
 *
 * AppURL only ever needs to be http://localhost:PORT/... - QBWC and this
 * server run on the same Windows machine (QBWC drives QuickBooks Desktop
 * over local COM automation), so nothing here is reachable from outside
 * that machine. The only outbound call this process makes is the final
 * HTTPS POST to the Apps Script Web App.
 *
 * Config via environment variables (no config file):
 *   APPS_SCRIPT_URL   - the deployed Web App's /exec URL (required)
 *   QBD_PUSH_SECRET   - must match QBD_PUSH_SECRET in Save Credentials (required)
 *   QBWC_PORT         - local port to listen on (default 8090)
 *   YEARS_BACK        - how many whole calendar years of TimeTracking to pull
 *                       (default 5). The floor is 1 January of (this year -
 *                       YEARS_BACK): run in 2026 with the default, that is
 *                       2021-01-01. Nothing normally needs to set this - it is
 *                       an env var only so the window can be widened for a
 *                       one-off backfill. Keep it equal to GRID_YEARS - 1 in
 *                       Code1.6.gs (currently 6, so 5, matching this default):
 *                       the month grid only displays/totals that many years
 *                       back FROM THE SHEET'S OWN A1 (the reporting year,
 *                       hand-edited), not from today - unlike this agent's
 *                       floor, which moves on its own every January. If A1
 *                       ever drifts behind the real year, the two floors
 *                       drift apart even with the numbers matching here.
 *                       Anything wider than the grid lands as "unplaced"
 *                       hours in the Refresh Hours alert instead of on the
 *                       sheet. GRID_YEARS was raised to 6 alongside this
 *                       default, and the live "test_current" sheet's header
 *                       formulas and post-grid columns have been widened to
 *                       match. Also not so wide that the row count exceeds
 *                       MAX_RETURNED.TimeTracking below, which qbXML
 *                       truncates silently - see that constant)
 *   QBXML_VERSION     - qbXML schema version to request (default "13.0";
 *                       first real run may need to bump this to match the
 *                       installed QuickBooks Desktop/QBWC version)
 *
 * v1.2 - the qbXML side of this has been verified working end to end (QWCLog
 * shows all four steps returning hresult="" and progress 25/50/75/100). The
 * failure this version exists to catch is the *next* link: the HTTPS POST to
 * Apps Script. That POST can fail while still returning HTTP 200, so status
 * alone is not a success signal - see pushToAppsScript_.
 *
 * v1.3 - renamed from server1.2.js; the code is unchanged from v1.2. The
 * launcher and the docs in this folder were updated to match the new name.
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');

const AGENT_VERSION = '1.3';
const PORT = Number(process.env.QBWC_PORT || 8090);
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const PUSH_SECRET = process.env.QBD_PUSH_SECRET;
const YEARS_BACK = Number(process.env.YEARS_BACK || 5);
const QBXML_VERSION = process.env.QBXML_VERSION || '13.0';

if (!APPS_SCRIPT_URL || !PUSH_SECRET) {
  console.error('Set APPS_SCRIPT_URL and QBD_PUSH_SECRET environment variables first.');
  console.error('Example:');
  console.error('  APPS_SCRIPT_URL=https://script.google.com/macros/s/AKfycbzjYKhai8yyCYq8JbNPGS_crPqXvvbqJGewm-SKxPRehiWt_qtmrG1vDcaUJt9oyab4ww/exec QBD_PUSH_SECRET=abc123 node server.js');
  process.exit(1);
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/**
 * Prints an unmissable block. The whole reason v1.2 exists is that the v1.1
 * failure ("Apps Script responded: 200 <!DOCTYPE html>...") looked, at a
 * glance in a scrolling console, exactly like a success line. Anything that
 * means "your data did not land in the Sheet" gets printed through here.
 */
function banner_(title, lines) {
  const bar = '='.repeat(76);
  console.log('\n' + bar + '\n  ' + title + '\n' + bar);
  lines.forEach(function (l) { console.log('  ' + l); });
  console.log(bar + '\n');
}

// ---------------------------------------------------------------------------
// qbXML request builders
// ---------------------------------------------------------------------------

function fromDate_() {
  // First day of the calendar year YEARS_BACK years ago - run in 2026 with the
  // default 5, this is "2021-01-01". Anchoring to a year boundary rather than a
  // rolling month count means the agent always pulls whole calendar years, so
  // the Sheet can always show a complete oldest year, and the floor only steps
  // (forward one year) each January instead of drifting every month. Built as a
  // string, not via Date formatting: a TxnDate is a plain calendar date and a
  // locally-built Date turned into a UTC string can slip across a boundary.
  const year = new Date().getFullYear() - YEARS_BACK;
  return year + '-01-01';
}

function qbxmlEnvelope_(body) {
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<?qbxml version="' + QBXML_VERSION + '"?>\n' +
    '<QBXML><QBXMLMsgsRq onError="continueOnError">' + body + '</QBXMLMsgsRq></QBXML>';
}

// Order matters: Employee and Vendor must be pulled before TimeTracking, so
// the ListID -> type lookup exists by the time TimeTracking rows are parsed.
const REQUEST_STEPS = ['Customer', 'Employee', 'Vendor', 'TimeTracking'];

// These caps are not paginated - qbXML returns at most MaxReturned rows and
// says nothing about what it dropped. Named here (rather than inlined in the
// request strings) so parseResponse_ can compare the row count it actually
// parsed against the cap and warn when a query came back exactly full, which
// is the only signal available that data was silently truncated.
//
// TimeTracking was 10000, which at ConSysTec's measured rate of ~530 entries a
// month is only ~19 months of headroom. That was fine while this data only fed
// a 12-month grid, but the Sheet's month grid now totals multiple years, so
// the window wants to be years wide and the cap became the binding constraint.
// YEARS_BACK=5 reaches ~5.7 years back (to 1 Jan five years ago, plus this
// year to date) - roughly 36000 entries, so 50000 leaves real room (~8 years
// is the new ceiling). Keep QBD_TIME_ROW_CAP in Code1.6.gs equal to this
// number: the Sheet re-checks it at read time and warns in the Refresh Hours
// alert, because a console warning nobody reads is not a safeguard.
const MAX_RETURNED = {
  Customer: 1000,
  Employee: 1000,
  Vendor: 1000,
  TimeTracking: 50000
};

function buildRequest_(step) {
  if (step === 'Customer') {
    return qbxmlEnvelope_('<CustomerQueryRq requestID="1"><MaxReturned>' +
      MAX_RETURNED.Customer + '</MaxReturned></CustomerQueryRq>');
  }
  if (step === 'Employee') {
    return qbxmlEnvelope_('<EmployeeQueryRq requestID="2"><MaxReturned>' +
      MAX_RETURNED.Employee + '</MaxReturned></EmployeeQueryRq>');
  }
  if (step === 'Vendor') {
    return qbxmlEnvelope_('<VendorQueryRq requestID="3"><MaxReturned>' +
      MAX_RETURNED.Vendor + '</MaxReturned></VendorQueryRq>');
  }
  if (step === 'TimeTracking') {
    // qbXML enforces element order per the schema sequence; MaxReturned must
    // come before the ModifiedDateRangeFilter/TxnDateRangeFilter choice, or
    // QuickBooks rejects the whole request as a stream parse error (0x80040400)
    // rather than a field-level validation error.
    return qbxmlEnvelope_(
      '<TimeTrackingQueryRq requestID="4">' +
      '<MaxReturned>' + MAX_RETURNED.TimeTracking + '</MaxReturned>' +
      '<TxnDateRangeFilter><FromTxnDate>' + fromDate_() + '</FromTxnDate></TxnDateRangeFilter>' +
      '</TimeTrackingQueryRq>');
  }
  throw new Error('unknown step ' + step);
}

// ---------------------------------------------------------------------------
// qbXML response parsing -> the same shapes Code.gs's qbdRead_ expects
// ---------------------------------------------------------------------------

const qbxmlParser = new XMLParser({ ignoreAttributes: true, trimValues: true });

function asArray_(v) {
  return v == null ? [] : (Array.isArray(v) ? v : [v]);
}

// qbXML Duration is an ISO-8601-ish duration, e.g. "PT8H0M0S" or "PT2H30M".
function parseDuration_(d) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(d || ''));
  if (!m) return { hours: 0, minutes: 0 };
  const hours = Number(m[1] || 0);
  const minutes = Number(m[2] || 0) + Number(m[3] || 0) / 60;
  return { hours: hours, minutes: minutes };
}

/**
 * qbXML silently returns at most MaxReturned rows with no indication that it
 * dropped any. A count that lands exactly on the cap is therefore the only
 * available evidence of truncation - and truncation here means hours that
 * exist in QuickBooks quietly go missing from the report, which SETUP.md
 * rightly calls worse than no sync at all.
 */
function checkTruncation_(step, count) {
  const cap = MAX_RETURNED[step];
  if (!cap || count < cap) return;
  banner_('POSSIBLE TRUNCATION: ' + step + ' returned exactly ' + count + ' rows', [
    'MaxReturned for ' + step + ' is ' + cap + ', and QuickBooks returned exactly that',
    'many. qbXML gives no "there were more" flag, so this may be a full result',
    'set that happens to hit the cap - or it may be silently cut short.',
    '',
    'If it is cut short, hours are missing from the report with no other symptom.',
    'Raise MAX_RETURNED.' + step + ' in this file and re-run to check: if the count',
    'goes up, you were being truncated.'
  ]);
}

function parseResponse_(step, xml, session) {
  const doc = qbxmlParser.parse(xml);
  const msgsRs = doc && doc.QBXML && doc.QBXML.QBXMLMsgsRs;
  if (!msgsRs) {
    log('WARN: no QBXMLMsgsRs in response for', step, '\n', xml);
    return;
  }

  if (step === 'Customer') {
    const rets = asArray_(msgsRs.CustomerQueryRs && msgsRs.CustomerQueryRs.CustomerRet);
    checkTruncation_(step, rets.length);
    rets.forEach(function (c) {
      session.customers.push({
        Id: String(c.ListID),
        DisplayName: String(c.Name || ''),
        // qbXML calls the colon-delimited parent:child path "FullName" -
        // this is what QBO calls FullyQualifiedName, and the whole
        // project-mapping design (customerByLeaf/leafName_ in Code.gs)
        // depends on this surviving the reshape.
        FullyQualifiedName: String(c.FullName || c.Name || '')
      });
    });
  } else if (step === 'Employee') {
    const rets = asArray_(msgsRs.EmployeeQueryRs && msgsRs.EmployeeQueryRs.EmployeeRet);
    checkTruncation_(step, rets.length);
    rets.forEach(function (e) {
      const id = String(e.ListID);
      session.people.push({ Id: id, DisplayName: String(e.Name || ''), Type: 'Employee' });
      session.listIdToType.set(id, 'Employee');
    });
  } else if (step === 'Vendor') {
    const rets = asArray_(msgsRs.VendorQueryRs && msgsRs.VendorQueryRs.VendorRet);
    checkTruncation_(step, rets.length);
    rets.forEach(function (v) {
      const id = String(v.ListID);
      session.people.push({ Id: id, DisplayName: String(v.Name || ''), Type: 'Vendor' });
      session.listIdToType.set(id, 'Vendor');
    });
  } else if (step === 'TimeTracking') {
    const rets = asArray_(msgsRs.TimeTrackingQueryRs && msgsRs.TimeTrackingQueryRs.TimeTrackingRet);
    checkTruncation_(step, rets.length);
    rets.forEach(function (t) {
      const entityListId = t.EntityRef ? String(t.EntityRef.ListID) : '';
      // Cross-reference against the Employee/Vendor lists pulled earlier in
      // this same session - never guess. If the ListID matches neither (e.g.
      // an "Other Name" list entry, not supported yet), leave PersonType
      // blank so Code.gs's entryPerson_ reports the row as unresolved rather
      // than silently attributing the hours to the wrong person.
      const personType = session.listIdToType.get(entityListId) || '';
      const dur = parseDuration_(t.Duration);
      session.timeEntries.push({
        Id: String(t.TxnID),
        TxnDate: String(t.TxnDate || ''),
        PersonType: personType,
        PersonId: entityListId,
        PersonName: t.EntityRef ? String(t.EntityRef.FullName || '') : '',
        CustomerId: t.CustomerRef ? String(t.CustomerRef.ListID) : '',
        CustomerName: t.CustomerRef ? String(t.CustomerRef.FullName || '') : '',
        Hours: dur.hours,
        Minutes: dur.minutes,
        BillableStatus: String(t.BillableStatus || ''),
        Description: String(t.Notes || '')
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Pushing the finished session to the Apps Script Web App
// ---------------------------------------------------------------------------

// Outcome of the most recently COMPLETED push, as a short one-liner. Reported
// back to QBWC from closeConnection so it lands in the Web Connector's status
// column and in QWCLog.txt. Deliberately the *previous* result rather than the
// in-flight one: closeConnection arrives ~2s after the final
// receiveResponseXML (see QWCLog 17:14:04 -> 17:14:06) and waiting on a push
// that writes thousands of rows would add unbounded latency to a SOAP call
// that currently always succeeds. Diagnostics are not worth risking the one
// link in this chain that works.
let lastPushResult = 'none yet in this agent run';

/**
 * Classifies what came back from the Apps Script Web App.
 *
 * The trap this exists for: a broken deployment answers with HTTP 200 and an
 * HTML error page ("Script function not found: doPost"), so status code alone
 * cannot distinguish success from total failure. Only the body can. Three
 * distinct failures all present as 200:
 *   - HTML error page   -> the deployed version has no doPost (redeploy needed)
 *   - HTML login page   -> deployment access is not "Anyone"
 *   - JSON success:false -> doPost ran and rejected the push (e.g. bad secret)
 */
function classifyAppsScriptReply_(status, contentType, text) {
  const looksHtml = /^\s*</.test(text) || contentType.includes('text/html');

  // Checked first: a 401/403 is refused by Google's front door before any
  // script runs, and the body is often empty or an HTML shell, so none of the
  // content-based checks below would say anything useful about it.
  if (status === 401 || status === 403) {
    return {
      ok: false,
      short: 'FAILED - HTTP ' + status + ', deployment is not open to "Anyone"',
      title: 'PUSH REJECTED BY GOOGLE - HTTP ' + status + ' (the script never ran)',
      lines: [
        'Google demanded credentials this agent does not have and cannot get.',
        'It runs unattended with no signed-in Google session, so any access',
        'setting narrower than "Anyone" blocks it permanently.',
        '',
        'The URL opening fine in YOUR browser proves nothing here - the browser',
        'sends your signed-in session; this process cannot.',
        '',
        'Fix: Apps Script > Deploy > Manage deployments > (pencil) >',
        '     Who has access: "Anyone"   <- not "Anyone with a Google Account",',
        '     and not "Anyone within <your domain>".',
        '     Execute as: "Me".',
        '',
        'Then re-copy the /exec URL. When access is "Anyone", the URL has NO',
        '"/a/macros/<domain>/" segment in it - it is a plain',
        'https://script.google.com/macros/s/<ID>/exec. A URL containing',
        '/a/macros/ is domain-restricted by definition.',
        '',
        'The shared secret is what protects this endpoint - see SETUP.md Step 2.'
      ]
    };
  }

  if (looksHtml && /Script function not found:\s*doPost/i.test(text)) {
    return {
      ok: false,
      short: 'FAILED - deployed script has no doPost (redeploy needed)',
      title: 'PUSH FAILED - the deployed Apps Script has no doPost()',
      lines: [
        'Apps Script returned HTTP 200 with its own error page:',
        '  "Script function not found: doPost"',
        '',
        'Your data reached Google and was thrown away. Apps Script Web App',
        'deployments are pinned to a saved VERSION - editing the code and',
        'pressing Ctrl+S does not change what the /exec URL runs.',
        '',
        'Fix: Apps Script editor > Deploy > Manage deployments > pencil icon on',
        'the existing deployment > Version: "New version" > Deploy. Use Edit,',
        'NOT "New deployment" - a new deployment mints a different /exec URL',
        'and you would have to update APPS_SCRIPT_URL too.',
        '',
        'Verify before re-running: open the /exec URL in a browser. Code1.2.gs',
        'adds a doGet that returns its version as JSON. If you still see',
        '"Script function not found: doGet", the redeploy did not take.'
      ]
    };
  }

  if (looksHtml && /(accounts\.google\.com|ServiceLogin|Sign in)/i.test(text)) {
    return {
      ok: false,
      short: 'FAILED - Google demanded a login (deployment access too narrow)',
      title: 'PUSH FAILED - the Web App is not reachable without a Google login',
      lines: [
        'Google served a sign-in page instead of running the script, so the',
        'push was never seen by doPost().',
        '',
        'Fix: Deploy > Manage deployments > Edit > Who has access: "Anyone"',
        '(and Execute as: "Me"). The shared secret is what protects this URL,',
        'not the access setting - see SETUP.md Step 2.'
      ]
    };
  }

  if (looksHtml) {
    return {
      ok: false,
      short: 'FAILED - Apps Script returned an HTML page, not JSON',
      title: 'PUSH FAILED - HTML page returned instead of JSON',
      lines: [
        'HTTP ' + status + ', content-type: ' + (contentType || '(none)'),
        'Apps Script served a web page rather than running doPost(). First 500',
        'characters of what came back:',
        '',
        text.slice(0, 500)
      ]
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      short: 'FAILED - reply was not JSON (HTTP ' + status + ')',
      title: 'PUSH FAILED - could not parse the reply as JSON',
      lines: [
        'HTTP ' + status + ', content-type: ' + (contentType || '(none)'),
        'JSON.parse said: ' + err.message,
        '',
        text.slice(0, 500)
      ]
    };
  }

  if (parsed && parsed.success === true) {
    return {
      ok: true,
      short: 'OK - ' + parsed.timeEntries + ' time entries written to "' +
        parsed.spreadsheet + '"' + (parsed.scriptVersion ? ' (Code v' + parsed.scriptVersion + ')' : ''),
      parsed: parsed
    };
  }

  // doPost ran and refused the push. Code1.1+ puts the reason in .message.
  return {
    ok: false,
    short: 'FAILED - ' + ((parsed && parsed.message) || 'doPost reported success:false'),
    title: 'PUSH REJECTED by doPost()',
    lines: [
      'The script DID run - which rules out any deployment, URL, or access',
      'problem - and then refused the push:',
      '',
      '  ' + ((parsed && parsed.message) || JSON.stringify(parsed)),
      '',
      'A secret mismatch is the usual cause: the QBD_PUSH_SECRET environment',
      'variable must match QuickBooks > Setup > Save Credentials exactly.'
    ]
  };
}

async function pushToAppsScript_(session) {
  const body = JSON.stringify({
    secret: PUSH_SECRET,
    customers: session.customers,
    people: session.people,
    timeEntries: session.timeEntries
  });
  const mb = (Buffer.byteLength(body, 'utf8') / 1048576).toFixed(2);
  log('Pushing', session.customers.length, 'customers,', session.people.length,
    'people,', session.timeEntries.length, 'time entries to Apps Script (' + mb + ' MB JSON)...');

  let res;
  let text;
  try {
    res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    });
    text = await res.text();
  } catch (err) {
    lastPushResult = 'FAILED - could not reach Apps Script: ' + err.message;
    banner_('PUSH FAILED - the HTTPS request never completed', [
      err.message,
      '',
      'Nothing was written to the Sheet. Check APPS_SCRIPT_URL and this',
      "machine's internet access."
    ]);
    return;
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const verdict = classifyAppsScriptReply_(res.status, contentType, text);

  if (verdict.ok) {
    lastPushResult = verdict.short;
    log('Apps Script responded:', res.status, text);
    log('PUSH OK -', verdict.short);
    return;
  }

  lastPushResult = verdict.short;
  log('Apps Script responded:', res.status, contentType);
  banner_(verdict.title, verdict.lines);
}

// ---------------------------------------------------------------------------
// SOAP envelope handling
// ---------------------------------------------------------------------------

const soapParser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, trimValues: true });

function extractMethodAndParams_(bodyText) {
  const doc = soapParser.parse(bodyText);
  const body = doc.Envelope && doc.Envelope.Body;
  if (!body) throw new Error('SOAP request has no Envelope/Body');
  const method = Object.keys(body)[0];
  const raw = body[method];
  const params = {};
  if (raw && typeof raw === 'object') {
    if ('ticket' in raw) params.ticket = String(raw.ticket);
    if ('strUserName' in raw) params.userName = String(raw.strUserName);
    if ('strPassword' in raw) params.password = String(raw.strPassword);
    if ('response' in raw) params.response = String(raw.response);
    if ('hresult' in raw) params.hresult = String(raw.hresult || '');
    if ('message' in raw) params.message = String(raw.message || '');
  }
  return { method: method, params: params };
}

function xmlEscape_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function soapEnvelope_(bodyXml) {
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xmlns:xsd="http://www.w3.org/2001/XMLSchema" ' +
    'xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<soap:Body>' + bodyXml + '</soap:Body></soap:Envelope>';
}

function simpleResult_(method, value) {
  return soapEnvelope_(
    '<' + method + 'Response xmlns="http://developer.intuit.com/">' +
    '<' + method + 'Result>' + xmlEscape_(value) + '</' + method + 'Result>' +
    '</' + method + 'Response>');
}

function arrayResult_(method, values) {
  const items = values.map(function (v) { return '<string>' + xmlEscape_(v) + '</string>'; }).join('');
  return soapEnvelope_(
    '<' + method + 'Response xmlns="http://developer.intuit.com/">' +
    '<' + method + 'Result>' + items + '</' + method + 'Result>' +
    '</' + method + 'Response>');
}

// ---------------------------------------------------------------------------
// Session state and the 8 methods QBWC expects
// ---------------------------------------------------------------------------

const sessions = new Map();

function newSession_() {
  return {
    step: 0,
    customers: [],
    people: [],
    timeEntries: [],
    listIdToType: new Map()
  };
}

function handleMethod_(method, params) {
  if (method === 'serverVersion') return simpleResult_(method, '1.0');
  if (method === 'clientVersion') return simpleResult_(method, ''); // '' = no warning, proceed

  if (method === 'authenticate') {
    const ticket = crypto.randomUUID();
    sessions.set(ticket, newSession_());
    log('authenticate: new session', ticket, 'user=', params.userName);
    // Second element '' tells QBWC to use whichever company file is already
    // open in QuickBooks Desktop, rather than pointing at a specific path.
    return arrayResult_(method, [ticket, '']);
  }

  if (method === 'sendRequestXML') {
    const session = sessions.get(params.ticket);
    if (!session || session.step >= REQUEST_STEPS.length) return simpleResult_(method, '');
    const step = REQUEST_STEPS[session.step];
    const req = buildRequest_(step);
    log('sendRequestXML: step=' + step, '\n' + req);
    return simpleResult_(method, req);
  }

  if (method === 'receiveResponseXML') {
    const session = sessions.get(params.ticket);
    if (!session) return simpleResult_(method, '100');
    const step = REQUEST_STEPS[session.step];
    log('receiveResponseXML: step=' + step, 'hresult=', params.hresult || '(none)',
      '\n' + params.response);
    if (!params.hresult) {
      parseResponse_(step, params.response, session);
    } else {
      log('WARN: qbXML error for step', step, params.hresult, params.message);
    }
    session.step += 1;
    const progress = Math.round((session.step / REQUEST_STEPS.length) * 100);
    if (session.step >= REQUEST_STEPS.length) {
      pushToAppsScript_(session);
    }
    return simpleResult_(method, String(progress));
  }

  if (method === 'connectionError') {
    log('connectionError:', params.hresult, params.message);
    return simpleResult_(method, 'done');
  }

  if (method === 'getLastError') return simpleResult_(method, '');

  if (method === 'closeConnection') {
    sessions.delete(params.ticket);
    log('closeConnection:', params.ticket);
    // QBWC shows this string in its status column and writes it to QWCLog.txt.
    // "Sync complete." on its own was actively misleading - it reported only
    // that the qbXML round-trip worked, which it always did. Appending the last
    // push outcome puts the part that actually broke in front of whoever is
    // looking at the Web Connector. Note this is the PREVIOUS run's result when
    // the current push is still in flight; the agent console always has the
    // authoritative, current one.
    return simpleResult_(method, 'Sync complete. Last push: ' + lastPushResult);
  }

  throw new Error('Unknown SOAP method: ' + method);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(function (req, res) {
  if (req.method !== 'POST') {
    // AppSupport in connector.qwc points here too, and QBWC expects it to
    // return 200 OK - answer any GET (health check / "Get Support" link)
    // instead of depending on an external URL.
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('qbwc-agent v' + AGENT_VERSION + ' is running.\n' +
      'Apps Script URL: ' + APPS_SCRIPT_URL + '\n' +
      'Last push: ' + lastPushResult + '\n');
    return;
  }
  const chunks = [];
  req.on('data', function (c) { chunks.push(c); });
  req.on('end', function () {
    const bodyText = Buffer.concat(chunks).toString('utf8');
    try {
      const parsed = extractMethodAndParams_(bodyText);
      log('SOAP call:', parsed.method);
      const responseXml = handleMethod_(parsed.method, parsed.params);
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
      res.end(responseXml);
    } catch (err) {
      log('ERROR handling SOAP call:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error: ' + err.message);
    }
  });
});

server.listen(PORT, function () {
  log('QBWC agent v' + AGENT_VERSION + ' listening on http://localhost:' + PORT +
    '/ - register this URL in connector.qwc');
  // Echoing the target URL at startup makes "which deployment am I actually
  // pushing to?" answerable from the console, instead of having to inspect
  // the environment of an already-running process. This matters more than it
  // looks: the URL comes from the environment, so editing the example string
  // further up THIS FILE changes nothing. What is printed here is what will
  // actually be used.
  log('Will push to:', APPS_SCRIPT_URL);
  log('(That comes from $env:APPS_SCRIPT_URL - editing this file does not set it.)');

  // Caught at startup rather than at push time: a domain-scoped URL cannot
  // work from an unattended process, so there is no reason to let a whole
  // QuickBooks sync run before saying so.
  if (/\/a\/macros\//.test(APPS_SCRIPT_URL)) {
    banner_('THIS URL WILL FAIL - it is restricted to a Google Workspace domain', [
      'The URL contains "/a/macros/<domain>/", which means the deployment\'s',
      'access is set to your Workspace domain rather than "Anyone". Google will',
      'answer this agent with HTTP 401 every time - it has no signed-in session.',
      '',
      'It works when you paste it into your browser only because the browser',
      'sends your Google login. This process cannot.',
      '',
      'Fix: Deploy > Manage deployments > (pencil) > Who has access: "Anyone",',
      'Execute as: "Me" > Deploy. The correct URL then has no /a/macros/ part:',
      '  https://script.google.com/macros/s/<ID>/exec',
      '',
      'Set it with:  $env:APPS_SCRIPT_URL="<that url>"   then restart this agent.'
    ]);
  }
});
