/**
 * Samhithe Admin – backend for www.samhithe.in/admin
 *
 * A separate Apps Script project from "Samhithe Booking", so the public booking page is never affected.
 * Runs as nidhi@samhithe.in and reads/writes the same "Samhithe – Bookings & Availability" sheet,
 * the payment screenshots in Drive, Nidhi's Google Calendar and her "Notes by Gemini" Meet transcripts.
 *
 * Every request is a POST with a JSON body: { action, token, ... }.
 * Public actions: login, forgot, reset. Everything else needs a valid session token.
 *
 * Extra sheet tabs created by setup(): Users, Notes, Message templates, Transcript links, Audit log,
 * and for the CRM: Clients, Files, Schools, Workshops (see the CRM section for the Drive layout and the no-duplicates rules).
 *
 * After any CODE change: Deploy → Manage deployments → ✏️ → Version: New version → Deploy.
 */

var CFG = {
  SHEET_ID: '1IgDA7wQ3CFZP12hlGLRviHqda7kCkkJw0V1Mgxrn5AQ',
  PORTAL_URL: 'https://www.samhithe.in/admin/',
  SESSION_HOURS: 6,              // a session ends after this long without activity
  RESET_MINUTES: 30,             // password links expire after this
  MAX_FAILS: 5,                  // wrong passwords before the account is locked…
  LOCK_MINUTES: 15,              // …for this long
  MIN_PASSWORD: 10,
  HASH_ROUNDS: 1200,
  PRICE_INR: 1000,
  SENDER_NAME: 'Samhithe – Nidhi Rao'
};

var STATUSES = ['To verify', 'Verified', 'Problem'];
var USER_HEADERS = ['Username', 'Name', 'Email', 'Role', 'Active', 'Salt', 'Hash', 'Failed', 'Locked Until', 'Last Login', 'Created'];
var NOTE_HEADERS = ['Time', 'Family Key', 'Booking Row', 'Author', 'Note'];
var LINK_HEADERS = ['Doc ID', 'Family Key', 'Linked By', 'Linked At'];
var AUDIT_HEADERS = ['Time', 'User', 'Action', 'Detail'];
var TEMPLATE_HEADERS = ['Key', 'Name', 'Email subject', 'Message'];
var DEFAULT_TEMPLATES = [
  ['confirm', 'Session confirmed', 'Your session with Nidhi is confirmed – {date}',
    'Hi {parent}, this is Nidhi from Samhithe. Your session for {child} is confirmed for {date} at {time} (India time).\n\nGoogle Meet link: {meet}\n\nSee you then!\nNidhi'],
  ['payment_ok', 'Payment received', 'Payment received – thank you',
    'Hi {parent}, I have received your payment of ₹{fee} for {child}\'s session on {date} at {time}. Thank you!\n\nGoogle Meet link: {meet}\n\nNidhi'],
  ['reminder', 'Session reminder', 'Reminder: your session with Nidhi on {date}',
    'Hi {parent}, a gentle reminder of your session with Nidhi for {child} on {date} at {time} (India time).\n\nGoogle Meet link: {meet}\n\nSee you soon,\nNidhi'],
  ['payment_issue', 'Payment issue', 'About your payment for {date}',
    'Hi {parent}, I could not find your payment of ₹{fee} for {child}\'s session on {date} at {time}. Could you please check and share the UPI transaction ID or a fresh screenshot? Thank you.\n\nNidhi'],
  ['rescheduled', 'Session moved', 'Your session with Nidhi has moved to {date}',
    'Hi {parent}, your session for {child} has been moved to {date} at {time} (India time). The Google Meet link stays the same: {meet}\n\nAn updated calendar invite is on its way. See you then!\nNidhi'],
  ['cancelled', 'Session cancelled', 'Your session with Nidhi on {date} is cancelled',
    'Hi {parent}, your session for {child} on {date} at {time} has been cancelled. {reason}\n\nI will be in touch about a new time or a refund. Sorry for the inconvenience.\nNidhi']
];
var DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
var SETTING_LABELS = ['Session length (minutes)', 'Gap between sessions (minutes)', 'Minimum notice (hours)', 'Booking window (days ahead)'];
var ENQUIRY_STATUSES = ['New', 'Called', 'Follow up', 'Closed'];

/* ───────────────────────── Web endpoint ───────────────────────── */

function doGet() { return out_({ ok: true, service: 'Samhithe admin' }); }

function doPost(e) {
  var b;
  try { b = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (x) { return out_({ ok: false, message: 'Bad request.' }); }
  try {
    var a = String(b.action || '');
    if (a === 'login') return out_(login_(b));
    if (a === 'forgot') return out_(forgot_(b));
    if (a === 'reset') return out_(reset_(b));
    var s = session_(b.token);
    if (!s) return out_({ ok: false, code: 'AUTH', message: 'Please sign in again.' });
    var api = API[a];
    if (!api) return out_({ ok: false, message: 'Unknown request.' });
    if (api.admin && s.role !== 'admin') return out_({ ok: false, message: "You don't have access to this." });
    return out_(api.run(b, s));
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return out_({ ok: false, message: 'Something went wrong. Please try again.' });
  }
}

var API = {
  me:            { run: function (b, s) { return { ok: true, user: s }; } },
  logout:        { run: function (b, s) { endSession_(b.token); audit_(s.u, 'logout', ''); return { ok: true }; } },
  data:          { run: data_ },
  screenshot:    { run: screenshot_ },
  setStatus:     { run: setStatus_ },
  sendEmail:     { run: sendEmail_ },
  family:        { run: family_ },
  addNote:       { run: addNote_ },
  transcripts:   { run: transcripts_, admin: true },
  transcript:    { run: transcript_, admin: true },
  linkTranscript:{ run: linkTranscript_, admin: true },
  searchTranscripts: { run: searchTranscripts_, admin: true },
  changePassword:{ run: changePassword_ },
  availability:  { run: availability_ },
  saveAvailability: { run: saveAvailability_ },
  reschedule:    { run: reschedule_ },
  cancel:        { run: cancel_ },
  setEnquiry:    { run: setEnquiry_ },
  saveTemplates: { run: saveTemplates_, admin: true },
  users:         { run: usersList_, admin: true },
  saveUser:      { run: saveUser_, admin: true },
  sendLink:      { run: function (b, s) { var r = forgot_({ username: b.username }, true); audit_(s.u, 'send-password-link', b.username); return r; }, admin: true },
  // CRM
  crm:           { run: crm_ },
  sync:          { run: sync_, admin: true },
  saveClient:    { run: saveClient_ },
  newClient:     { run: newClient_ },
  upload:        { run: upload_, admin: true },
  createDoc:     { run: createDoc_, admin: true },
  prep:          { run: prep_, admin: true },
  search:        { run: search_ },
  inbox:         { run: inbox_, admin: true },
  fileItem:      { run: fileItem_, admin: true },
  dismiss:       { run: dismiss_ },
  schools:       { run: schools_ },
  school:        { run: school_ },
  saveSchool:    { run: saveSchool_ },
  schoolFromEnquiry: { run: schoolFromEnquiry_ },
  schoolFollow:  { run: schoolFollow_ },
  saveWorkshop:  { run: saveWorkshop_ },
  driveCheck:    { run: driveCheck_, admin: true },
  trashDupes:    { run: trashDupes_, admin: true }
};

/* ───────────────────────── Auth ───────────────────────── */

function login_(b) {
  var generic = { ok: false, message: 'Wrong username or password.' };
  var u = findUser_(b.username);
  if (!u || !u.active) { Utilities.sleep(500); audit_(String(b.username || '').slice(0, 40), 'login-failed', 'unknown user'); return generic; }
  var now = Date.now();
  if (u.lockedUntil && u.lockedUntil > now) {
    return { ok: false, message: 'Too many wrong attempts. Try again in ' + Math.ceil((u.lockedUntil - now) / 60000) +
      ' minutes, or use "Forgot password".' };
  }
  if (!u.hash) return { ok: false, message: 'No password has been set yet. Use "Forgot password" to set one.' };
  var failed = u.lockedUntil && u.lockedUntil <= now ? 0 : u.failed;
  if (hash_(String(b.password || ''), u.salt) !== u.hash) {
    failed++;
    setUser_(u, { 'Failed': failed, 'Locked Until': failed >= CFG.MAX_FAILS ? new Date(now + CFG.LOCK_MINUTES * 60000) : '' });
    audit_(u.username, 'login-failed', 'attempt ' + failed);
    return generic;
  }
  setUser_(u, { 'Failed': 0, 'Locked Until': '', 'Last Login': new Date() });
  var token = rand_();
  var s = { u: u.username, name: u.name || u.username, role: u.role };
  if (b.remember) {          // "Keep me signed in on this device": no expiry; ended by sign-out, password reset or deactivation
    PropertiesService.getScriptProperties().setProperty('ps_' + sha_(token), JSON.stringify({ u: u.username, at: Date.now() }));
    CacheService.getScriptCache().put('s_' + token, JSON.stringify(s), 600);
  } else CacheService.getScriptCache().put('s_' + token, JSON.stringify(s), CFG.SESSION_HOURS * 3600);
  audit_(u.username, 'login', b.remember ? 'remembered device' : '');
  var d = null;
  try { d = data_({}, s); } catch (x) { console.warn('login data: ' + x); }    // dashboard data in the same round trip
  return { ok: true, token: token, user: s, data: d };
}

/** Returns the session for a token (and keeps it alive), or null. */
function session_(token) {
  if (!token || !/^[a-f0-9]{64}$/.test(String(token))) return null;
  var c = CacheService.getScriptCache(), raw = c.get('s_' + token);
  var ps = PropertiesService.getScriptProperties().getProperty('ps_' + sha_(token));
  if (ps) {                                                  // remembered device: re-check the user every 10 minutes
    if (raw) return JSON.parse(raw);
    var u = findUser_(JSON.parse(ps).u);
    if (!u || !u.active) { endSession_(token); return null; }
    var s = { u: u.username, name: u.name || u.username, role: u.role };
    c.put('s_' + token, JSON.stringify(s), 600);
    return s;
  }
  if (!raw) return null;
  c.put('s_' + token, raw, CFG.SESSION_HOURS * 3600);
  return JSON.parse(raw);
}

function endSession_(token) {
  CacheService.getScriptCache().remove('s_' + token);
  PropertiesService.getScriptProperties().deleteProperty('ps_' + sha_(String(token)));
}

/** Ends every remembered device for a user (password reset/change, deactivation). */
function endUserSessions_(username) {
  var props = PropertiesService.getScriptProperties(), all = props.getProperties(), n = 0;
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('ps_') !== 0) return;
    try { if (JSON.parse(all[k]).u === username) { props.deleteProperty(k); n++; } } catch (x) { props.deleteProperty(k); }
  });
  return n;
}

function forgot_(b, byAdmin) {
  var msg = { ok: true, message: 'If that username exists, a link to set a new password has been sent to its email address. The link works for ' + CFG.RESET_MINUTES + ' minutes.' };
  var u = findUser_(b.username);
  if (byAdmin && (!u || !u.active || !u.email)) return { ok: false, message: 'That user is not active or has no email address.' };
  if (byAdmin) msg = { ok: true, message: 'Password link sent to ' + (u && u.email) + '.' };
  if (!u || !u.active || !u.email) { Utilities.sleep(500); audit_(String(b.username || '').slice(0, 40), 'reset-requested', 'unknown user'); return msg; }
  var c = CacheService.getScriptCache(), k = 'fg_' + u.username, n = Number(c.get(k) || 0);
  if (n >= 3) return msg;                                  // at most 3 emails an hour per user
  c.put(k, String(n + 1), 3600);
  cleanResets_();
  var t = rand_();
  PropertiesService.getScriptProperties().setProperty('rst_' + sha_(t),
    JSON.stringify({ u: u.username, exp: Date.now() + CFG.RESET_MINUTES * 60000 }));
  var link = CFG.PORTAL_URL + '#reset=' + t;
  MailApp.sendEmail({
    to: u.email, name: 'Samhithe Admin',
    subject: 'Set your Samhithe admin password',
    htmlBody: wrap_('<h2 style="font-family:Georgia,serif;font-weight:400;margin:0 0 12px">Set your password</h2>' +
      '<p>Hi ' + esc_(u.name || u.username) + ', use the button below to set a new password for the Samhithe admin portal ' +
      '(username <b>' + esc_(u.username) + '</b>).</p>' +
      '<p style="margin:24px 0"><a href="' + link + '" style="background:#CB5521;color:#fff;padding:13px 24px;border-radius:999px;text-decoration:none;font-weight:600">Set my password</a></p>' +
      '<p style="color:#6A5F57;font-size:14px">The link works once and expires in ' + CFG.RESET_MINUTES + ' minutes. If you did not ask for this, ignore this email – your password stays the same.</p>')
  });
  audit_(u.username, 'reset-requested', 'emailed ' + u.email);
  return msg;
}

function reset_(b) {
  var t = String(b.resetToken || '');
  if (!/^[a-f0-9]{64}$/.test(t)) return { ok: false, message: 'This link is not valid. Please ask for a new one.' };
  var props = PropertiesService.getScriptProperties(), key = 'rst_' + sha_(t), raw = props.getProperty(key);
  if (!raw) return { ok: false, message: 'This link has already been used or has expired. Please ask for a new one.' };
  var r = JSON.parse(raw);
  if (r.exp < Date.now()) { props.deleteProperty(key); return { ok: false, message: 'This link has expired. Please ask for a new one.' }; }
  var pw = String(b.password || '');
  var bad = passwordProblem_(pw);
  if (bad) return { ok: false, message: bad };
  var u = findUser_(r.u);
  if (!u || !u.active) return { ok: false, message: 'This account is not active.' };
  props.deleteProperty(key);
  var salt = rand_().slice(0, 32);
  setUser_(u, { 'Salt': salt, 'Hash': hash_(pw, salt), 'Failed': 0, 'Locked Until': '' });
  var ended = endUserSessions_(u.username);
  audit_(u.username, 'password-set', 'via email link' + (ended ? '; signed out ' + ended + ' device(s)' : ''));
  return login_({ username: u.username, password: pw, remember: b.remember !== false });
}

function changePassword_(b, s) {
  var u = findUser_(s.u);
  if (!u || hash_(String(b.current || ''), u.salt) !== u.hash) return { ok: false, message: 'Your current password is not correct.' };
  var bad = passwordProblem_(String(b.password || ''));
  if (bad) return { ok: false, message: bad };
  var salt = rand_().slice(0, 32);
  setUser_(u, { 'Salt': salt, 'Hash': hash_(String(b.password), salt) });
  var keep = PropertiesService.getScriptProperties().getProperty('ps_' + sha_(String(b.token)));
  endUserSessions_(u.username);
  if (keep) PropertiesService.getScriptProperties().setProperty('ps_' + sha_(String(b.token)), keep);
  audit_(s.u, 'password-changed', 'other devices signed out');
  return { ok: true, message: 'Password changed.' };
}

function passwordProblem_(pw) {
  if (pw.length < CFG.MIN_PASSWORD) return 'Please use at least ' + CFG.MIN_PASSWORD + ' characters.';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Please use both letters and numbers.';
  return '';
}

function cleanResets_() {
  var props = PropertiesService.getScriptProperties(), all = props.getProperties(), now = Date.now();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('rst_') !== 0) return;
    try { if (JSON.parse(all[k]).exp < now) props.deleteProperty(k); } catch (x) { props.deleteProperty(k); }
  });
}

function hash_(pw, salt) {
  var key = Utilities.newBlob(pepper_()).getBytes();
  var h = Utilities.computeHmacSha256Signature(Utilities.newBlob(salt + '|' + pw).getBytes(), key);
  for (var i = 0; i < CFG.HASH_ROUNDS; i++) h = Utilities.computeHmacSha256Signature(h, key);
  return Utilities.base64Encode(h);
}
function pepper_() {
  var p = PropertiesService.getScriptProperties(), v = p.getProperty('PEPPER');
  if (!v) { v = rand_(); p.setProperty('PEPPER', v); }
  return v;
}
function rand_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').toLowerCase(); }
function sha_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s).map(function (x) {
    return ('0' + (x & 255).toString(16)).slice(-2); }).join('');
}

/* ───────────────────────── Users ───────────────────────── */

function users_() {
  var sh = tab_('Users', USER_HEADERS), n = sh.getLastRow() - 1;
  if (n < 1) {                                             // first run: create Nidhi's admin account (no password yet)
    sh.appendRow(['nidhi', 'Nidhi Rao', 'nidhi@samhithe.in', 'admin', true, '', '', 0, '', '', new Date()]);
    n = 1;
  }
  return sh.getRange(2, 1, n, USER_HEADERS.length).getValues().map(function (r, i) {
    return {
      row: i + 2, username: String(r[0]).trim().toLowerCase(), name: String(r[1]), email: String(r[2]).trim(),
      role: String(r[3]).trim().toLowerCase() === 'admin' ? 'admin' : 'assistant',
      active: r[4] === true || String(r[4]).toUpperCase() === 'TRUE', salt: String(r[5]), hash: String(r[6]),
      failed: Number(r[7]) || 0, lockedUntil: r[8] instanceof Date ? r[8].getTime() : 0, lastLogin: iso_(r[9])
    };
  });
}
function findUser_(name) {
  var n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  return users_().filter(function (u) { return u.username === n; })[0] || null;
}
function setUser_(u, fields) {                            // one read + one write per change (sheet calls are slow)
  var sh = tab_('Users', USER_HEADERS), rg = sh.getRange(u.row, 1, 1, USER_HEADERS.length), row = rg.getValues()[0];
  Object.keys(fields).forEach(function (k) { var c = USER_HEADERS.indexOf(k); if (c >= 0) row[c] = fields[k]; });
  rg.setValues([row]);
}

/* ───────────────────────── Main data (one request per screen load) ───────────────────────── */

function data_(b, s) {
  var c = CacheService.getScriptCache(), key = 'data_' + s.role;
  if (!b.fresh) {
    var hit = c.get(key);
    if (hit) { var o = JSON.parse(hit); o.user = s; return o; }
  }
  var bk = bookings_();
  var fam = families_(bk, s.role === 'admin' ? intakeRows_() : intakeRows_());
  var out = {
    ok: true, user: s, now: new Date().toISOString(), fee: CFG.PRICE_INR,
    bookings: bk.map(function (x) { var y = Object.assign({}, x); delete y.shot; y.hasShot = !!x.shot; return y; }),
    families: fam.list, events: events_(), templates: templates_(), enquiries: enquiries_()
  };
  if (s.role === 'admin') {
    var t = tIndex_(fam);
    out.transcriptCount = t.length;
    out.unlinkedTranscripts = t.filter(function (x) { return !x.fam && !x.dismissed; }).length;
  }
  try { c.put(key, JSON.stringify(out), 90); } catch (x) {}
  return out;
}

function bookings_() { return memo_('bookings', bookingsRead_); }
function bookingsRead_() {
  var sh = ss_().getSheetByName('Bookings');
  if (!sh || sh.getLastRow() < 2) return [];
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  var col = function (name) { return head.indexOf(name); };
  return sh.getRange(2, 1, sh.getLastRow() - 1, head.length).getValues().map(function (r, i) {
    var g = function (n) { var c = col(n); return c < 0 ? '' : r[c]; };
    return {
      row: i + 2, bookedAt: iso_(g('Booked At')), start: iso_(g('Session Start')), end: iso_(g('Session End')),
      child: String(g('Child Name')), age: String(g('Child Age')), parent: String(g('Parent Name')),
      email: String(g('Email')).trim().toLowerCase(), phone: String(g('Phone')).replace(/^'/, ''),
      upi: String(g('Paid From UPI')), notes: String(g('Notes')), shot: String(g('Screenshot')),
      meet: String(g('Meet Link')), eventId: String(g('Calendar Event ID')), status: String(g('Payment Status') || 'To verify'),
      state: String(g('Booking Status') || 'Booked')
    };
  }).filter(function (x) { return x.start; });
}

function intakeRows_() { return memo_('intake', intakeRead_); }
function intakeRead_() {
  var sh = ss_().getSheetByName('Intake');
  if (!sh || sh.getLastRow() < 2) return [];
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  return sh.getRange(2, 1, sh.getLastRow() - 1, head.length).getValues().map(function (r, i) {
    var o = { row: i + 2, answers: [] };
    head.forEach(function (h, c) {
      var v = r[c];
      if (h === 'Submitted At') o.at = iso_(v);
      else if (h === 'Parent Name') o.parent = String(v).trim();
      else if (h === 'Email') o.email = String(v).trim().toLowerCase();
      else if (h === 'Phone') o.phone = String(v).replace(/^'/, '');
      else if (h === 'Child Name') o.child = String(v).trim();
      else if (h === 'Child Age') o.age = String(v);
      else if (h === 'Session') o.session = iso_(v);
      else if (h === 'Source') o.source = String(v);
      else if (v !== '' && v != null) o.answers.push([h, v instanceof Date ? Utilities.formatDate(v, tz_(), 'd MMM yyyy') : String(v)]);
    });
    return o;
  }).filter(function (x) { return x.parent || x.email || x.child; });
}

/** Groups bookings and intake forms into families (same email or same phone = same family). */
function families_(bk, intakes) {
  var byEmail = {}, byPhone = {}, fams = {}, order = [];
  var keyFor = function (email, phone) {
    var p = phoneKey_(phone);
    var k = (email && byEmail[email]) || (p && byPhone[p]);
    if (!k) { k = email ? email : 'p:' + p; fams[k] = { key: k, parents: [], emails: [], phones: [], children: [], bookings: [], intakes: [], last: '', next: '' }; order.push(k); }
    if (email) byEmail[email] = k;
    if (p) byPhone[p] = k;
    return k;
  };
  var addU = function (arr, v) {
    v = String(v || '').trim(); if (!v) return;
    var lv = v.toLowerCase();
    for (var i = 0; i < arr.length; i++) {
      var la = String(arr[i]).toLowerCase();
      if (la === lv || (la.length > 2 && lv.indexOf(la + ' ') === 0)) { if (v.length > arr[i].length) arr[i] = v; return; }   // "Shubhadha" → "Shubhadha Mathad"
      if (lv.length > 2 && la.indexOf(lv + ' ') === 0) return;
    }
    arr.push(v);
  };
  intakes.forEach(function (x) {
    if (!x.email && phoneKey_(x.phone).length < 10) return;
    var f = fams[keyFor(x.email, x.phone)];
    addU(f.parents, x.parent); addU(f.emails, x.email); addU(f.phones, x.phone); addU(f.children, x.child);
    f.intakes.push(x.row);
  });
  var now = new Date().toISOString();
  bk.forEach(function (x) {
    var f = fams[keyFor(x.email, x.phone)];
    x.fam = f.key;
    addU(f.parents, x.parent); addU(f.emails, x.email); addU(f.phones, x.phone); addU(f.children, x.child);
    f.bookings.push(x.row);
    if (x.state === 'Cancelled') return;
    if (x.start < now && x.start > f.last) f.last = x.start;
    if (x.start >= now && (!f.next || x.start < f.next)) f.next = x.start;
  });
  // CRM: clients Nidhi added by hand (phone enquiries etc). If one of them later books or fills the intake form
  // (same email or phone), it is the same family – shown once, never twice.
  var alias = {};
  clientRows_().forEach(function (c) {
    if (fams[c.key]) return;
    var hit = (c.emails.filter(function (e) { return byEmail[e]; }).map(function (e) { return byEmail[e]; })[0]) ||
              (c.phones.map(phoneKey_).filter(function (p) { return p && byPhone[p]; }).map(function (p) { return byPhone[p]; })[0]);
    if (hit) { alias[c.key] = hit; return; }
    if (c.key.indexOf('m:') !== 0) return;
    fams[c.key] = { key: c.key, parents: c.parents.slice(), emails: c.emails.slice(), phones: c.phones.slice(), children: c.child ? [c.child] : [],
      bookings: [], intakes: [], last: '', next: '', manual: true };
    order.push(c.key);
  });
  return { map: fams, list: order.map(function (k) { return fams[k]; }), alias: alias };
}
function famGet_(fam, key) { key = String(key || ''); return fam.map[key] || fam.map[fam.alias && fam.alias[key]] || null; }

function events_() {
  var from = new Date(); from.setHours(0, 0, 0, 0);
  var to = new Date(from.getTime() + 8 * 86400000);
  var res = Calendar.Events.list('primary', { timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 100 });
  return (res.items || []).filter(function (ev) { return ev.start && ev.start.dateTime && ev.status !== 'cancelled'; }).map(function (ev) {
    return {
      id: ev.id, title: ev.summary || '(no title)', start: ev.start.dateTime, end: ev.end.dateTime, meet: ev.hangoutLink || '',
      guests: (ev.attendees || []).filter(function (a) { return !a.self; }).map(function (a) { return a.email; })
    };
  });
}

function enquiries_() {
  var sh = ss_().getSheetByName('School enquiries');
  if (!sh || sh.getLastRow() < 2) return [];
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  return sh.getRange(2, 1, sh.getLastRow() - 1, head.length).getValues().map(function (r, i) {
    var o = { row: i + 2 };
    head.forEach(function (h, c) { o[h] = r[c] instanceof Date ? r[c].toISOString() : String(r[c]); });
    return o;
  });
}

function templates_() {
  var sh = tab_('Message templates', TEMPLATE_HEADERS);
  if (sh.getLastRow() < 2) sh.getRange(2, 1, DEFAULT_TEMPLATES.length, 4).setValues(DEFAULT_TEMPLATES);
  else {
    var have = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]); });
    DEFAULT_TEMPLATES.forEach(function (t) { if (have.indexOf(t[0]) < 0) sh.appendRow(t); });
  }
  return sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().filter(function (r) { return r[0]; }).map(function (r) {
    return { key: String(r[0]), name: String(r[1]), subject: String(r[2]), body: String(r[3]) };
  });
}

/* ───────────────────────── Bookings: screenshot, payment status, email ───────────────────────── */

function bookingAt_(row) {
  row = Number(row);
  var b = bookings_().filter(function (x) { return x.row === row; })[0];
  if (!b) throw new Error('Booking row ' + row + ' not found');
  return b;
}

function screenshot_(b, s) {
  var bk = bookingAt_(b.row);
  var m = bk.shot.match(/\/d\/([\w-]{20,})/) || bk.shot.match(/[?&]id=([\w-]{20,})/);
  if (!m) return { ok: false, message: 'No screenshot saved for this booking.' };
  var f = DriveApp.getFileById(m[1]);
  var blob = f.getSize() > 3 * 1024 * 1024 && f.getMimeType() !== 'application/pdf' ? f.getThumbnail() : f.getBlob();
  audit_(s.u, 'view-screenshot', 'row ' + bk.row);
  return { ok: true, type: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()), name: f.getName(), url: f.getUrl() };
}

function setStatus_(b, s) {
  var st = String(b.status || '');
  if (STATUSES.indexOf(st) < 0) return { ok: false, message: 'Unknown status.' };
  var bk = bookingAt_(b.row);
  var sh = ss_().getSheetByName('Bookings');
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  sh.getRange(bk.row, head.indexOf('Payment Status') + 1).setValue(st);
  bust_();
  audit_(s.u, 'payment-status', 'row ' + bk.row + ' → ' + st);
  return { ok: true, status: st };
}

function sendEmail_(b, s) {
  var bk = bookingAt_(b.row);
  var subject = String(b.subject || '').slice(0, 200).trim(), body = String(b.body || '').slice(0, 5000).trim();
  if (!subject || !body) return { ok: false, message: 'Please add a subject and a message.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(bk.email)) return { ok: false, message: 'This booking has no valid email address.' };
  var html = esc_(body).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#CB5521">$1</a>').replace(/\n/g, '<br>');
  MailApp.sendEmail({ to: bk.email, name: CFG.SENDER_NAME, replyTo: Session.getEffectiveUser().getEmail(), subject: subject, htmlBody: wrap_('<p>' + html + '</p>') });
  audit_(s.u, 'email-parent', 'row ' + bk.row + ': ' + subject);
  return { ok: true, message: 'Email sent to ' + bk.email + '.' };
}

/* ───────────────────────── Families, intake, notes ───────────────────────── */

function family_(b, s) {
  var bk = bookings_(), intakes = intakeRows_(), fam = families_(bk, intakes);
  var f = famGet_(fam, b.key);
  if (!f) return { ok: false, message: 'Family not found.' };
  var out = { ok: true, family: f, bookings: bk.filter(function (x) { return x.fam === f.key; }).map(function (x) { var y = Object.assign({}, x); delete y.shot; y.hasShot = !!x.shot; return y; }),
    notes: notesFor_(f.key, aliasesOf_(fam, f.key)) };
  var famTr = tIndex_(fam).filter(function (t) { return t.fam === f.key; });
  out.crm = clientView_(clientFor_(f), f, famTr.map(function (t) { return t.when; }).sort().pop() || '');
  if (s.role === 'admin') {
    out.intakes = intakes.filter(function (x) { return f.intakes.indexOf(x.row) >= 0; });
    out.transcripts = famTr;
    out.files = ownerFiles_(f.key, clientFor_(f));
    audit_(s.u, 'view-family', f.key);
  }
  return out;
}

function notesFor_(key, more) {
  var sh = tab_('Notes', NOTE_HEADERS), n = sh.getLastRow() - 1, keys = [key].concat(more || []);
  if (n < 1) return [];
  return sh.getRange(2, 1, n, NOTE_HEADERS.length).getValues().filter(function (r) { return keys.indexOf(String(r[1])) >= 0; }).map(function (r) {
    return { at: iso_(r[0]), row: r[2], by: String(r[3]), text: String(r[4]) };
  }).reverse();
}

function addNote_(b, s) {
  var text = String(b.text || '').trim().slice(0, 4000), key = String(b.key || '');
  if (!text || !key) return { ok: false, message: 'Please write a note.' };
  tab_('Notes', NOTE_HEADERS).appendRow([new Date(), key, b.row || '', s.u, text]);
  audit_(s.u, 'add-note', key);
  bustCrm_();
  return { ok: true, notes: notesFor_(key) };
}

/* ───────────────────────── Transcripts ("Notes by Gemini" docs) ───────────────────────── */

/** All Gemini meeting notes in Nidhi's Drive, each linked to a family where possible. Cached for 30 minutes. */
function tIndex_(fam) {
  var c = CacheService.getScriptCache(), raw = c.get('tidx_v1'), list;
  if (raw) list = JSON.parse(raw);
  else {
    list = [];
    var it = DriveApp.searchFiles("title contains 'Notes by Gemini' and mimeType = 'application/vnd.google-apps.document' and trashed = false");
    while (it.hasNext() && list.length < 800) {
      var f = it.next(), title = f.getName();
      var m = title.match(/^(.*?)\s*-?\s*(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})\b/);
      var when = m ? new Date(+m[2], +m[3] - 1, +m[4], +m[5], +m[6]).toISOString() : f.getDateCreated().toISOString();
      var meeting = m ? m[1].replace(/\s*-\s*$/, '').trim() : title.replace(/\s*-\s*Notes by Gemini$/, '');
      list.push({ id: f.getId(), title: title, meeting: meeting, when: when, url: f.getUrl() });
    }
    list.sort(function (a, b) { return a.when < b.when ? 1 : -1; });
    try { c.put('tidx_v1', JSON.stringify(list), 1800); } catch (x) {}
  }
  fam = fam || families_(bookings_(), intakeRows_());
  var links = manualLinks_(), bk = [];
  Object.keys(fam.map).forEach(function (k) { fam.map[k].bookings.forEach(function (r) { bk.push({ row: r, fam: k }); }); });
  var bookingsAll = bookings_();
  var norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
  return list.map(function (t) {
    var o = Object.assign({}, t), mt;
    if (links[t.id] !== undefined) { o.fam = links[t.id] === 'none' ? null : links[t.id]; o.manual = true; o.dismissed = links[t.id] === 'none'; return o; }
    if ((mt = t.meeting.match(/^Parent Consultation with Nidhi\s*[–-]\s*(.+)$/i))) {
      var child = norm(mt[1]), tt = new Date(t.when).getTime();
      var hit = bookingsAll.filter(function (x) { return norm(x.child) === child && Math.abs(new Date(x.start).getTime() - tt) < 4 * 3600000; })[0];
      if (hit) { o.fam = familyOfRow_(fam, hit.row); o.row = hit.row; return o; }
      o.fam = findFam_(fam, function (f) { return f.children.some(function (c) { return norm(c) === child; }); });
      return o;
    }
    if ((mt = t.meeting.match(/^Session with Nidhi\s*\((.+)\)$/i))) {
      var parent = norm(mt[1]);
      o.fam = findFam_(fam, function (f) { return f.parents.some(function (p) { p = norm(p); return p === parent || (parent.length > 5 && (p.indexOf(parent) === 0 || parent.indexOf(p) === 0)); }); });
      return o;
    }
    o.fam = null;
    return o;
  });
}
function familyOfRow_(fam, row) { return findFam_(fam, function (f) { return f.bookings.indexOf(row) >= 0; }); }
function findFam_(fam, test) {
  var k = Object.keys(fam.map).filter(function (k) { return test(fam.map[k]); })[0];
  return k || null;
}
function manualLinks_() {
  var sh = tab_('Transcript links', LINK_HEADERS), n = sh.getLastRow() - 1, out = {};
  if (n > 0) sh.getRange(2, 1, n, 2).getValues().forEach(function (r) { if (r[0]) out[String(r[0])] = String(r[1]); });
  return out;
}

function transcripts_(b, s) {
  var fam = families_(bookings_(), intakeRows_());
  var names = {};
  fam.list.forEach(function (f) { names[f.key] = (f.children.length ? f.children.join(', ') + ' · ' : '') + (f.parents[0] || f.emails[0] || f.key); });
  var list = tIndex_(fam), c = CacheService.getScriptCache(), n = 0;
  list.forEach(function (t) {                                // a peek at unfiled ones, so "Meeting started" isn't a mystery
    if (t.fam || t.dismissed || n >= 25) return;
    var k = 'tpv_' + t.id, hit = c.get(k);
    if (!hit) {
      n++;
      var txt = ''; try { var d = DocumentApp.openById(t.id), tabs = d.getTabs(); txt = tabs.length ? tabs[0].asDocumentTab().getBody().getText() : d.getBody().getText(); } catch (x) {}
      var empty = /summary wasn't produced|wasn't enough conversation/i.test(txt);
      var peek = empty ? '' : geminiText_(txt).replace(/\s+/g, ' ').trim().slice(0, 220);
      hit = JSON.stringify({ empty: empty, peek: peek }); try { c.put(k, hit, 21600); } catch (x) {}
    }
    var o = JSON.parse(hit); t.empty = o.empty; t.peek = o.peek;
    if (!o.empty) { var g = guessClient_(t.meeting + ' ' + o.peek, fam); if (g) t.suggest = g.f.key; }   // name in title or summary
  });
  return { ok: true, transcripts: list, familyNames: names };
}

function transcript_(b, s) {
  var id = String(b.id || '');
  var t = tIndex_().filter(function (x) { return x.id === id; })[0];
  if (!t) return { ok: false, message: 'Transcript not found.' };
  var doc = DocumentApp.openById(id), tabs = [];
  var walk = function (list) {
    (list || []).forEach(function (tab) {
      var text = '';
      try { text = tab.asDocumentTab().getBody().getText(); } catch (x) {}
      tabs.push({ title: tab.getTitle(), text: text });
      try { walk(tab.getChildTabs()); } catch (x) {}
    });
  };
  try { walk(doc.getTabs()); } catch (x) {}
  if (!tabs.length) tabs.push({ title: 'Notes', text: doc.getBody().getText() });
  audit_(s.u, 'view-transcript', t.title);
  return { ok: true, transcript: t, tabs: tabs };
}

function linkTranscript_(b, s) {
  var id = String(b.id || ''), key = String(b.key || '');
  if (!tIndex_().some(function (x) { return x.id === id; })) return { ok: false, message: 'Transcript not found.' };
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
  var sh = tab_('Transcript links', LINK_HEADERS), n = sh.getLastRow() - 1;
  if (n > 0) {
    var ids = sh.getRange(2, 1, n, 1).getValues().map(function (r) { return String(r[0]); });
    var i = ids.indexOf(id);
    if (i >= 0) sh.deleteRow(i + 2);
  }
  if (key) sh.appendRow([id, key, s.u, new Date()]);
  } finally { lock.releaseLock(); }
  bust_();
  audit_(s.u, 'link-transcript', id + ' → ' + (key || 'auto'));
  return { ok: true };
}

function searchTranscripts_(b, s) {
  var q = String(b.q || '').replace(/['\\]/g, ' ').trim().slice(0, 80);
  if (q.length < 2) return { ok: true, ids: [] };
  var it = DriveApp.searchFiles("fullText contains '" + q + "' and title contains 'Notes by Gemini' and trashed = false"), ids = [];
  while (it.hasNext() && ids.length < 200) ids.push(it.next().getId());
  audit_(s.u, 'search-transcripts', q);
  return { ok: true, ids: ids };
}


/* ───────────────────────── Availability, time off, settings (read by the booking page) ───────────────────────── */

function availability_(b, s) {
  var ss = ss_(), tz = tz_();
  var av = ss.getSheetByName('Availability'), to = ss.getSheetByName('Time off'), se = ss.getSheetByName('Settings');
  var weekly = [], off = [], settings = [];
  if (av && av.getLastRow() > 1) av.getRange(2, 1, av.getLastRow() - 1, 3).getDisplayValues().forEach(function (r) {
    if (DAY_NAMES.indexOf(String(r[0]).trim()) >= 0 && r[1] && r[2]) weekly.push([String(r[0]).trim(), to24_(r[1]), to24_(r[2])]);
  });
  if (to && to.getLastRow() > 1) to.getRange(2, 1, to.getLastRow() - 1, 3).getValues().forEach(function (r) {
    if (r[0] instanceof Date) off.push([Utilities.formatDate(r[0], tz, 'yyyy-MM-dd'), r[1] instanceof Date ? Utilities.formatDate(r[1], tz, 'yyyy-MM-dd') : '', String(r[2] || '')]);
  });
  if (se && se.getLastRow() > 1) se.getRange(2, 1, se.getLastRow() - 1, 3).getValues().forEach(function (r) {
    if (SETTING_LABELS.indexOf(String(r[0])) >= 0) settings.push({ label: String(r[0]), value: Number(r[1]), help: String(r[2] || '') });
  });
  return { ok: true, weekly: weekly, timeOff: off, settings: settings };
}

function saveAvailability_(b, s) {
  var ss = ss_(), tz = tz_(), lock = LockService.getScriptLock();
  var weekly = (b.weekly || []).map(function (r) {
    var day = String(r[0]), a = mins_(r[1]), z = mins_(r[2]);
    if (DAY_NAMES.indexOf(day) < 0 || a == null || z == null || z <= a) throw new Error('bad-row');
    return [day, ampm_(a), ampm_(z)];
  });
  var off = (b.timeOff || []).map(function (r) {
    var a = ymd_(r[0]), z = r[1] ? ymd_(r[1]) : '';
    if (!a || (r[1] && !z) || (z && z < a)) throw new Error('bad-date');
    return [a, z || '', String(r[2] || '').slice(0, 120)];
  });
  var sets = b.settings || {};
  lock.waitLock(15000);
  try {
    var av = ss.getSheetByName('Availability'), to = ss.getSheetByName('Time off'), se = ss.getSheetByName('Settings');
    av.getRange(2, 1, Math.max(av.getMaxRows() - 1, 1), 3).clearContent();
    if (weekly.length) av.getRange(2, 1, weekly.length, 3).setValues(weekly);
    to.getRange(2, 1, Math.max(to.getMaxRows() - 1, 1), 3).clearContent();
    if (off.length) to.getRange(2, 1, off.length, 3).setValues(off);
    if (se.getLastRow() > 1) {
      var labels = se.getRange(2, 1, se.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]); });
      var limits = { 'Session length (minutes)': [15, 240], 'Gap between sessions (minutes)': [0, 120], 'Minimum notice (hours)': [0, 336], 'Booking window (days ahead)': [1, 90] };
      Object.keys(sets).forEach(function (k) {
        var i = labels.indexOf(k), v = Number(sets[k]), lim = limits[k];
        if (i >= 0 && lim && isFinite(v) && v >= lim[0] && v <= lim[1]) se.getRange(i + 2, 2).setValue(Math.round(v));
      });
    }
  } finally { lock.releaseLock(); }
  audit_(s.u, 'save-availability', weekly.length + ' weekly blocks, ' + off.length + ' time-off rows');
  return availability_(b, s);
}

/* ───────────────────────── Reschedule / cancel ───────────────────────── */

function reschedule_(b, s) {
  var bk = bookingAt_(b.row);
  if (bk.state === 'Cancelled') return { ok: false, message: 'This booking is cancelled.' };
  var start = new Date(b.start);
  if (isNaN(start)) return { ok: false, message: 'Please choose a new time.' };
  if (start.getTime() < Date.now()) return { ok: false, message: 'Please choose a time in the future.' };
  var len = new Date(bk.end).getTime() - new Date(bk.start).getTime() || 3600000, end = new Date(start.getTime() + len);
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var clash = CalendarApp.getDefaultCalendar().getEvents(start, end).filter(function (ev) {
      if (ev.isAllDayEvent()) return false;
      try { if (ev.getMyStatus() === CalendarApp.GuestStatus.NO) return false; } catch (x) {}
      return ev.getId().split('@')[0] !== bk.eventId;
    });
    if (clash.length) return { ok: false, message: 'That time is no longer free on Nidhi\'s calendar. Please pick another.' };
    if (bk.eventId) Calendar.Events.patch({ start: { dateTime: start.toISOString(), timeZone: tz_() }, end: { dateTime: end.toISOString(), timeZone: tz_() } },
      'primary', bk.eventId, { sendUpdates: 'all' });
    setBooking_(bk.row, { 'Session Start': start, 'Session End': end, 'Booking Status': 'Rescheduled' });
  } finally { lock.releaseLock(); }
  bust_();
  var was = Utilities.formatDate(new Date(bk.start), tz_(), "EEE d MMM, h:mm a");
  tab_('Notes', NOTE_HEADERS).appendRow([new Date(), bk.fam || bk.email, bk.row, s.u, 'Rescheduled from ' + was + (b.reason ? ' – ' + b.reason : '')]);
  bk.start = start.toISOString(); bk.end = end.toISOString(); bk.state = 'Rescheduled';
  var mailed = b.notify !== false ? emailTemplate_(bk, 'rescheduled', {}) : false;
  audit_(s.u, 'reschedule', 'row ' + bk.row + ': ' + was + ' → ' + bk.start + (mailed ? ' (parent emailed)' : ''));
  return { ok: true, booking: publicBooking_(bk), emailed: mailed };
}

function cancel_(b, s) {
  var bk = bookingAt_(b.row);
  if (bk.state === 'Cancelled') return { ok: false, message: 'This booking is already cancelled.' };
  var reason = String(b.reason || '').trim().slice(0, 500);
  if (bk.eventId) { try { Calendar.Events.remove('primary', bk.eventId, { sendUpdates: 'all' }); } catch (x) { console.warn('event already gone: ' + x); } }
  bust_();
  setBooking_(bk.row, { 'Booking Status': 'Cancelled' });
  tab_('Notes', NOTE_HEADERS).appendRow([new Date(), bk.fam || bk.email, bk.row, s.u, 'Cancelled' + (reason ? ' – ' + reason : '')]);
  bk.state = 'Cancelled';
  var mailed = b.notify !== false ? emailTemplate_(bk, 'cancelled', { reason: reason }) : false;
  audit_(s.u, 'cancel', 'row ' + bk.row + (mailed ? ' (parent emailed)' : ''));
  return { ok: true, booking: publicBooking_(bk), emailed: mailed };
}

function setBooking_(row, fields) {
  var sh = ss_().getSheetByName('Bookings');
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  if (head.indexOf('Booking Status') < 0) {
    sh.getRange(1, head.length + 1).setValue('Booking Status').setFontWeight('bold').setBackground('#F7DFD2');
    head.push('Booking Status');
  }
  Object.keys(fields).forEach(function (k) { var c = head.indexOf(k); if (c >= 0) sh.getRange(row, c + 1).setValue(fields[k]); });
}

function publicBooking_(x) { var y = Object.assign({}, x); delete y.shot; y.hasShot = !!x.shot; return y; }

function emailTemplate_(bk, key, extra) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(bk.email)) return false;
  var t = templates_().filter(function (x) { return x.key === key; })[0];
  if (!t) return false;
  var body = fill_(t.body, bk, extra), subject = fill_(t.subject, bk, extra);
  var html = esc_(body).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#CB5521">$1</a>').replace(/\n/g, '<br>');
  MailApp.sendEmail({ to: bk.email, name: CFG.SENDER_NAME, replyTo: Session.getEffectiveUser().getEmail(), subject: subject, htmlBody: wrap_('<p>' + html + '</p>') });
  return true;
}

function fill_(t, bk, extra) {
  var st = new Date(bk.start), map = {
    parent: String(bk.parent || '').trim().split(/\s+/)[0], child: String(bk.child || '').trim().split(/\s+/)[0],
    date: Utilities.formatDate(st, tz_(), 'EEEE, d MMMM'), time: Utilities.formatDate(st, tz_(), 'h:mm a'),
    meet: bk.meet || '', fee: String(CFG.PRICE_INR), reason: (extra && extra.reason) || ''
  };
  return String(t || '').replace(/\{(\w+)\}/g, function (_, k) { return map[k] != null ? map[k] : ''; }).replace(/[ \t]+\n/g, '\n');
}

/* ───────────────────────── School enquiries, templates, users ───────────────────────── */

function setEnquiry_(b, s) {
  var st = String(b.status || '');
  if (ENQUIRY_STATUSES.indexOf(st) < 0) return { ok: false, message: 'Unknown status.' };
  var sh = ss_().getSheetByName('School enquiries'), row = Number(b.row);
  if (!sh || row < 2 || row > sh.getLastRow()) return { ok: false, message: 'Enquiry not found.' };
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  sh.getRange(row, head.indexOf('Status') + 1).setValue(st);
  bust_();
  audit_(s.u, 'enquiry-status', 'row ' + row + ' → ' + st);
  return { ok: true };
}

function saveTemplates_(b, s) {
  var sh = tab_('Message templates', TEMPLATE_HEADERS), cur = templates_(), keys = cur.map(function (t) { return t.key; });
  var list = (b.templates || []).filter(function (t) { return keys.indexOf(t.key) >= 0; });
  if (list.length !== keys.length) return { ok: false, message: 'Something is missing. Please reload and try again.' };
  var rows = list.map(function (t) { return [t.key, String(t.name || t.key).slice(0, 60), String(t.subject || '').slice(0, 200), String(t.body || '').slice(0, 3000)]; });
  if (rows.some(function (r) { return !r[2].trim() || !r[3].trim(); })) return { ok: false, message: 'Every template needs a subject and a message.' };
  sh.getRange(2, 1, rows.length, 4).setValues(rows);
  bust_();
  audit_(s.u, 'save-templates', rows.length + ' templates');
  return { ok: true, templates: templates_() };
}

function usersList_() {
  return { ok: true, users: users_().map(function (u) {
    return { username: u.username, name: u.name, email: u.email, role: u.role, active: u.active, hasPassword: !!u.hash, lastLogin: u.lastLogin };
  }) };
}

function saveUser_(b, s) {
  var username = String(b.username || '').trim().toLowerCase(), name = String(b.name || '').trim().slice(0, 60),
      email = String(b.email || '').trim().toLowerCase(), role = b.role === 'admin' ? 'admin' : 'assistant', active = b.active !== false;
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) return { ok: false, message: 'Username: 3–30 letters, numbers, dots, dashes or underscores.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { ok: false, message: 'Please enter a valid email address – password links are sent there.' };
  if (!name) return { ok: false, message: 'Please enter a name.' };
  var all = users_(), u = all.filter(function (x) { return x.username === username; })[0];
  if (b.isNew && u) return { ok: false, message: 'That username is already taken.' };
  if (!b.isNew && !u) return { ok: false, message: 'User not found.' };
  if (u && u.username === s.u && (!active || role !== 'admin')) return { ok: false, message: 'You cannot remove your own admin access.' };
  var admins = all.filter(function (x) { return x.role === 'admin' && x.active && x.username !== username; }).length;
  if ((!active || role !== 'admin') && admins === 0) return { ok: false, message: 'There must always be at least one active admin.' };
  if (u) setUser_(u, { 'Name': name, 'Email': email, 'Role': role, 'Active': active });
  if (u && !active) endUserSessions_(username);
  else tab_('Users', USER_HEADERS).appendRow([username, name, email, role, active, '', '', 0, '', '', new Date()]);
  audit_(s.u, b.isNew ? 'add-user' : 'update-user', username + ' (' + role + (active ? '' : ', inactive') + ')');
  return usersList_();
}

/* ───────────────────────── CRM: clients, schools, Drive documents ─────────────────────────
 *
 * Everything lives in Nidhi's Drive under one folder, "Samhithe CRM":
 *   Samhithe CRM / Clients / <Child – Parent (#abcd)> / 1 Intake & hypotheses · 2 Session notes · 3 Materials · 4 Reports & letters
 *   Samhithe CRM / Schools / <School (#abcd)> / Agreements · Workshops · Invoices · Other
 *   Samhithe CRM / Inbox – drop files here      (files are moved to the right client; unsure ones wait in "To file")
 *
 * NO DUPLICATES – the rules:
 *  • Folders are found before they are created (by saved ID, then by exact name), under a lock, so a folder is never made twice.
 *    Each client/school folder name carries a short code from its key, so two clients with the same name never share one.
 *  • Every uploaded file is fingerprinted (MD5). If the same file is already anywhere in Samhithe CRM, it is not saved again –
 *    the existing copy is returned instead.
 *  • Template docs (hypotheses, session notes, …) are made once per client + template + session; asking again opens the same doc.
 *  • The Claude prep pack is ONE doc per client that is overwritten, never a new copy each time.
 *  • Files are only ever MOVED (Inbox → client folder), never copied. Gemini transcripts are linked, not copied or moved.
 *  • Drive check (More → Drive check) finds any duplicates that got in from outside (e.g. dragged in via Drive) and moves the
 *    extra copies to Drive's Trash (recoverable for 30 days) – only when Nidhi clicks.
 *
 * Sheet tabs (created on first use): Clients, Files, Schools, Workshops.
 * No triggers or new Google permissions: the background sync runs when the admin is open (at most every 10 minutes).
 */

var CRM = {
  ROOT: 'Samhithe CRM', CLIENTS: 'Clients', SCHOOLS: 'Schools', INBOX: 'Inbox – drop files here',
  MAX_UPLOAD_MB: 25, SYNC_MINUTES: 10
};
var STAGES = ['Enquiry', 'Intake received', 'First session', 'Ongoing', 'Paused', 'Closed'];
var CLIENT_CATS = [['intake', '1 Intake & hypotheses'], ['notes', '2 Session notes'], ['materials', '3 Materials'], ['reports', '4 Reports & letters']];
var SCHOOL_CATS = [['agreements', 'Agreements'], ['workshops', 'Workshops'], ['invoices', 'Invoices'], ['other', 'Other']];
var SCHOOL_STATUSES = ['Lead', 'In talks', 'Partner', 'Past'];
var WORKSHOP_STATUSES = ['Planned', 'Held', 'Report sent', 'Cancelled'];
var CLIENT_HEADERS = ['Key', 'Child', 'Parents', 'Emails', 'Phones', 'Stage', 'Follow-up', 'Follow-up note', 'School', 'Tags', 'Folder ID', 'Folders', 'Created', 'Updated'];
var FILE_HEADERS = ['File ID', 'Owner Key', 'Category', 'Session Date', 'Title', 'Mime', 'MD5', 'Size', 'Source', 'Template', 'By', 'At', 'Note', 'Status'];
var SCHOOL_HEADERS = ['Key', 'Name', 'Type', 'City', 'Status', 'Since', 'Contacts', 'Follow-up', 'Follow-up note', 'Notes', 'Folder ID', 'Folders', 'Enquiry Row', 'Created'];
var WORKSHOP_HEADERS = ['ID', 'School Key', 'Date', 'Title', 'Teachers', 'Status', 'Fee', 'Paid', 'Notes'];
var DOC_TEMPLATES = {
  hypotheses: { name: 'Hypotheses', cat: 'intake' },
  session: { name: 'Session notes', cat: 'notes', needsSession: true },
  parent: { name: 'Parent summary', cat: 'reports' },
  school: { name: 'Letter to school', cat: 'reports' }
};

/* ── sheet rows ── */

function rowsOf_(name, headers) {
  var sh = tab_(name, headers), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  return sh.getRange(2, 1, n, head.length).getValues().map(function (r, i) {
    var o = { _row: i + 2 }; head.forEach(function (h, c) { o[h] = r[c]; }); return o;
  });
}
function writeRow_(name, headers, rowNum, obj) {      // rowNum = 0 → append. One write per call.
  var sh = tab_(name, headers);
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  headers.forEach(function (h) { if (head.indexOf(h) < 0) { sh.getRange(1, head.length + 1).setValue(h).setFontWeight('bold'); head.push(h); } });
  var cur = rowNum ? sh.getRange(rowNum, 1, 1, head.length).getValues()[0] : head.map(function () { return ''; });
  head.forEach(function (h, c) { if (obj.hasOwnProperty(h)) cur[c] = obj[h]; });
  if (rowNum) sh.getRange(rowNum, 1, 1, head.length).setValues([cur]);
  else sh.getRange(sh.getLastRow() + 1, 1, 1, head.length).setValues([cur]);
}
function list_(v) { return String(v || '').split(/\s*[,;\n]\s*/).map(function (x) { return x.trim(); }).filter(String); }
function json_(v, d) { try { return v ? JSON.parse(v) : d; } catch (x) { return d; } }
function ymdStr_(v) { if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd'); var m = String(v || '').match(/^\d{4}-\d{2}-\d{2}/); return m ? m[0] : ''; }
function dl_(v) { var d = /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? ymd_(v) : new Date(v); return isNaN(d) ? String(v || '') : Utilities.formatDate(d, tz_(), 'd MMM'); }
function norm_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function code_(key) { return sha_(String(key)).slice(0, 4); }
function bustCrm_() { try { CacheService.getScriptCache().removeAll(['crm_admin', 'crm_assistant']); } catch (x) {} }

function clientRows_() { return memo_('clients', function () {
  return rowsOf_('Clients', CLIENT_HEADERS).filter(function (r) { return r.Key; }).map(function (r) {
    return { row: r._row, key: String(r.Key), child: String(r.Child || ''), parents: list_(r.Parents), emails: list_(r.Emails).map(function (e) { return e.toLowerCase(); }),
      phones: list_(r.Phones), stage: String(r.Stage || ''), followUp: ymdStr_(r['Follow-up']), followNote: String(r['Follow-up note'] || ''),
      school: String(r.School || ''), tags: list_(r.Tags), folderId: String(r['Folder ID'] || ''), folders: json_(r.Folders, {}) };
  });
}); }

/** The CRM row for a family: by key, by an old key that now points at it, or by the same email/phone. */
function clientFor_(f) {
  var rows = clientRows_(), r = rows.filter(function (c) { return c.key === f.key; })[0];
  if (r) return r;
  var ph = f.phones.map(phoneKey_);
  return rows.filter(function (c) {
    return c.emails.some(function (e) { return f.emails.indexOf(e) >= 0; }) || c.phones.some(function (p) { p = phoneKey_(p); return p.length >= 10 && ph.indexOf(p) >= 0; });
  })[0] || null;
}
function aliasesOf_(fam, key) { return Object.keys(fam.alias || {}).filter(function (k) { return fam.alias[k] === key; }); }

/** Stage: the one Nidhi chose, otherwise worked out from bookings and intake. */
function stageOf_(f, c, lastTr) {
  if (c && c.stage) return c.stage;
  var past = f.last || lastTr, next = f.next;
  if (past) return 'Ongoing';
  if (next) return 'First session';
  if (f.intakes && f.intakes.length) return 'Intake received';
  return 'Enquiry';
}
function clientView_(c, f, lastTr) {
  return { stage: stageOf_(f, c, lastTr), stageSet: !!(c && c.stage), followUp: c ? c.followUp : '', followNote: c ? c.followNote : '', school: c ? c.school : '',
    tags: c ? c.tags : [], folderUrl: c && c.folderId ? 'https://drive.google.com/drive/folders/' + c.folderId : '' };
}

/** Writes CRM fields for a family (creates its row the first time). Keeps the row's key in step with the family's key. */
function saveClientRow_(f, fields) {
  var c = clientFor_(f), now = new Date();
  var obj = { 'Key': c ? c.key : f.key, 'Child': f.children.join(', '), 'Parents': f.parents.join(', '), 'Emails': f.emails.join(', '), 'Phones': f.phones.join(', '), 'Updated': now };
  Object.keys(fields).forEach(function (k) { obj[k] = fields[k]; });
  if (!c) obj['Created'] = now;
  writeRow_('Clients', CLIENT_HEADERS, c ? c.row : 0, obj);
  delete MEMO_.clients; bust_(); bustCrm_();
  return clientFor_(f);
}

/* ── Drive folders (never created twice) ── */

function folderById_(id) { if (!id) return null; try { var f = DriveApp.getFolderById(id); return f.isTrashed() ? null : f; } catch (x) { return null; } }
function childFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  while (it.hasNext()) { var f = it.next(); if (!f.isTrashed()) return f; }
  return parent.createFolder(name);
}
function crmFolder_(which) {                              // which: '' (root) | 'clients' | 'schools' | 'inbox'
  var p = PropertiesService.getScriptProperties(), key = 'CRM_F_' + (which || 'root'), f = folderById_(p.getProperty(key));
  if (f) return f;
  if (!which) {
    var it = DriveApp.getRootFolder().getFoldersByName(CRM.ROOT);
    while (it.hasNext() && !f) { var x = it.next(); if (!x.isTrashed()) f = x; }
    if (!f) f = DriveApp.getRootFolder().createFolder(CRM.ROOT);
  } else f = childFolder_(crmFolder_(''), which === 'clients' ? CRM.CLIENTS : which === 'schools' ? CRM.SCHOOLS : CRM.INBOX);
  p.setProperty(key, f.getId());
  return f;
}
function safeName_(s) { return String(s || '').replace(/[\\/:*?"<>|#]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80); }

/** Folder set for a client: { root, intake, notes, materials, reports } (Folder objects). Creates them only if asked. */
function clientFolders_(f, create) {
  var c = clientFor_(f);
  var root = folderById_(c && c.folderId);
  if (!root && !create) return null;
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    delete MEMO_.clients; c = clientFor_(f); root = folderById_(c && c.folderId);   // someone may have just made it
    var ids = (c && c.folders) || {}, out = {}, changed = false;
    if (!root) {
      var name = safeName_((f.children[0] || 'Child') + ' – ' + (f.parents[0] || f.emails[0] || 'Family')) + ' (#' + code_(f.key) + ')';
      root = childFolder_(crmFolder_('clients'), name); changed = true;
    }
    out.root = root;
    CLIENT_CATS.forEach(function (k) {
      var sub = folderById_(ids[k[0]]);
      if (!sub) { sub = childFolder_(root, k[1]); ids[k[0]] = sub.getId(); changed = true; }
      out[k[0]] = sub;
    });
    if (changed) c = saveClientRow_(f, { 'Folder ID': root.getId(), 'Folders': JSON.stringify(ids) });
    return out;
  } finally { lock.releaseLock(); }
}
function schoolFolders_(sc, create) {
  var root = folderById_(sc.folderId);
  if (!root && !create) return null;
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    sc = schoolGet_(sc.key); root = folderById_(sc.folderId);
    var ids = sc.folders || {}, out = {}, changed = false;
    if (!root) { root = childFolder_(crmFolder_('schools'), safeName_(sc.name) + ' (#' + code_(sc.key) + ')'); changed = true; }
    out.root = root;
    SCHOOL_CATS.forEach(function (k) {
      var sub = folderById_(ids[k[0]]);
      if (!sub) { sub = childFolder_(root, k[1]); ids[k[0]] = sub.getId(); changed = true; }
      out[k[0]] = sub;
    });
    if (changed) { writeRow_('Schools', SCHOOL_HEADERS, sc.row, { 'Folder ID': root.getId(), 'Folders': JSON.stringify(ids) }); delete MEMO_.schools; }
    return out;
  } finally { lock.releaseLock(); }
}
/** Folder ID → { owner, cat } for every client and school folder (used to recognise files added straight in Drive). */
function folderMap_() {
  var m = {};
  clientRows_().forEach(function (c) { Object.keys(c.folders || {}).forEach(function (k) { m[c.folders[k]] = { owner: c.key, cat: k }; }); if (c.folderId) m[c.folderId] = { owner: c.key, cat: 'materials' }; });
  schoolRows_().forEach(function (s) { Object.keys(s.folders || {}).forEach(function (k) { m[s.folders[k]] = { owner: 'school:' + s.key, cat: k }; }); if (s.folderId) m[s.folderId] = { owner: 'school:' + s.key, cat: 'other' }; });
  return m;
}

/* ── Files index ── */

function fileRows_() { return memo_('files', function () {
  return rowsOf_('Files', FILE_HEADERS).filter(function (r) { return r['File ID']; }).map(function (r) {
    return { row: r._row, id: String(r['File ID']), owner: String(r['Owner Key']), cat: String(r.Category), session: ymdStr_(r['Session Date']), title: String(r.Title),
      mime: String(r.Mime), md5: String(r.MD5), size: Number(r.Size) || 0, source: String(r.Source), template: String(r.Template), by: String(r.By), at: iso_(r.At),
      note: String(r.Note || ''), status: String(r.Status || '') };
  });
}); }
function indexFile_(file, o) {
  var have = fileRows_().filter(function (x) { return x.id === file.getId(); })[0];
  var obj = { 'File ID': file.getId(), 'Owner Key': o.owner, 'Category': o.cat, 'Title': file.getName(), 'Mime': file.getMimeType(), 'Size': file.getSize(), 'Status': '' };
  ['Session Date', 'MD5', 'Source', 'Template', 'By', 'Note'].forEach(function (k) { var v = o[{ 'Session Date': 'session', 'MD5': 'md5', 'Source': 'source', 'Template': 'template', 'By': 'by', 'Note': 'note' }[k]]; if (v != null) obj[k] = v; });
  if (!have) obj['At'] = new Date();
  writeRow_('Files', FILE_HEADERS, have ? have.row : 0, obj);
  delete MEMO_.files; bustCrm_();
}
function isGoogleType_(mime) { return /^application\/vnd\.google-apps\./.test(mime); }
function md5_(bytes) { return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes).map(function (x) { return ('0' + (x & 255).toString(16)).slice(-2); }).join(''); }
function fileMd5_(file) {                                  // fingerprint of a Drive file (cached 6 h per file version)
  if (isGoogleType_(file.getMimeType()) || file.getSize() > CRM.MAX_UPLOAD_MB * 1048576) return '';
  var c = CacheService.getScriptCache(), k = 'md5_' + file.getId() + '_' + file.getLastUpdated().getTime(), v = c.get(k);
  if (v) return v;
  try { v = md5_(file.getBlob().getBytes()); c.put(k, v, 21600); return v; } catch (x) { return ''; }
}
function liveFile_(id) { try { var f = DriveApp.getFileById(id); return f.isTrashed() ? null : f; } catch (x) { return null; } }
function fileOut_(file, meta, cat) {
  return { id: file.getId(), title: file.getName(), url: file.getUrl(), mime: file.getMimeType(), cat: (meta && meta.cat) || cat, session: meta ? meta.session : '',
    at: (meta && meta.at) || file.getDateCreated().toISOString(), updated: file.getLastUpdated().toISOString(), by: meta ? meta.by : '', note: meta ? meta.note : '',
    source: meta ? meta.source : 'drive', template: meta ? meta.template : '', size: file.getSize() };
}
/** Every file in a client's (or school's) folders, read live from Drive. New files found there get indexed. */
function ownerFiles_(ownerKey, rowOrNull, isSchool) {
  var c = rowOrNull, out = [];
  if (!c || !c.folders) return out;
  var meta = {}; fileRows_().forEach(function (x) { if (x.owner === ownerKey) meta[x.id] = x; });
  var cats = (isSchool ? SCHOOL_CATS : CLIENT_CATS).map(function (k) { return [k[0], c.folders[k[0]]]; });
  cats.push([isSchool ? 'other' : 'materials', c.folderId]);           // loose files dropped in the client's main folder
  cats.forEach(function (k) {
    var fo = folderById_(k[1]); if (!fo) return;
    var it = fo.getFiles();
    while (it.hasNext() && out.length < 300) {
      var file = it.next(); if (file.isTrashed()) continue;
      var m = meta[file.getId()];
      if (!m || m.cat !== k[0] || m.status) { indexFile_(file, { owner: ownerKey, cat: k[0], source: m ? m.source : 'drive', md5: m && m.md5 ? m.md5 : fileMd5_(file) }); m = Object.assign({}, m || {}, { cat: k[0] }); }
      out.push(fileOut_(file, m, k[0]));
    }
  });
  out.sort(function (a, b) { return a.at < b.at ? 1 : -1; });
  return out;
}

/** Is this exact file already anywhere in Samhithe CRM? Returns the existing file's index row, or null. */
function findDuplicate_(md5, size) {
  if (!md5) return null;
  var hits = fileRows_().filter(function (x) { return x.md5 === md5 && !x.status && (!size || !x.size || x.size === size); });
  for (var i = 0; i < hits.length; i++) {
    if (liveFile_(hits[i].id)) return hits[i];
    writeRow_('Files', FILE_HEADERS, hits[i].row, { 'Status': 'trashed' }); delete MEMO_.files;
  }
  return null;
}
function ownerName_(owner) {
  if (owner.indexOf('school:') === 0) { var sc = schoolGet_(owner.slice(7)); return sc ? sc.name : 'a school'; }
  var f = famGet_(families_(bookings_(), intakeRows_()), owner);
  return f ? (f.children[0] || f.parents[0] || 'a client') : 'another client';
}

/* ── Upload (one file per request) ── */

function upload_(b, s) {
  var owner = String(b.owner || ''), cat = String(b.cat || ''), name = safeName_(b.name || 'Upload').replace(/ (\.\w+)$/, '$1') || 'Upload';
  var data = String(b.data || '');
  if (!data) return { ok: false, message: 'No file received.' };
  var bytes = Utilities.base64Decode(data);
  if (bytes.length > CRM.MAX_UPLOAD_MB * 1048576) return { ok: false, message: 'That file is over ' + CRM.MAX_UPLOAD_MB + ' MB. Please add it in Google Drive instead.' };
  if (!ownerTarget_(owner, cat, false) && !ownerExists_(owner)) return { ok: false, message: 'Client or school not found.' };
  var md5 = md5_(bytes), lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    delete MEMO_.files;
    var dup = findDuplicate_(md5, bytes.length);                // checked BEFORE any folder is made
    if (dup) {
      var df = liveFile_(dup.id), same = dup.owner === owner || ownerName_(dup.owner) === ownerName_(owner);
      return { ok: true, duplicate: true, file: fileOut_(df, dup), message: '“' + dup.title + '” is already saved' + (same ? '' : ' (in ' + ownerName_(dup.owner) + '’s folder)') + ', so it was not added again.' };
    }
    var target = ownerTarget_(owner, cat, true);
    if (!target) return { ok: false, message: 'Client or school not found.' };
    var blob = Utilities.newBlob(bytes, String(b.mime || 'application/octet-stream'), name);
    var file = target.folder.createFile(blob);
    indexFile_(file, { owner: target.owner, cat: target.cat, session: ymdStr_(b.session), md5: md5, source: 'upload', by: s.u, note: String(b.note || '').slice(0, 300) });
    audit_(s.u, 'upload', target.owner + ' / ' + target.cat + ': ' + name);
    return { ok: true, file: fileOut_(file, { cat: target.cat, session: ymdStr_(b.session), by: s.u, source: 'upload', note: String(b.note || '') }) };
  } finally { lock.releaseLock(); }
}
/** Resolves an owner key + category to { owner, cat, folder, isSchool, row, fam }. */
function ownerTarget_(owner, cat, create) {
  if (owner.indexOf('school:') === 0) {
    var sc = schoolGet_(owner.slice(7)); if (!sc) return null;
    if (!SCHOOL_CATS.some(function (k) { return k[0] === cat; })) cat = 'other';
    var sf = schoolFolders_(sc, create); if (!sf) return null;
    return { owner: owner, cat: cat, folder: sf[cat], isSchool: true, row: schoolGet_(sc.key) };
  }
  var fam = families_(bookings_(), intakeRows_()), f = famGet_(fam, owner); if (!f) return null;
  if (!CLIENT_CATS.some(function (k) { return k[0] === cat; })) cat = 'materials';
  var cf = clientFolders_(f, create); if (!cf) return null;
  return { owner: f.key, cat: cat, folder: cf[cat], fam: f, famAll: fam, row: clientFor_(f) };
}

function ownerExists_(owner) {
  if (owner.indexOf('school:') === 0) return !!schoolGet_(owner.slice(7));
  return !!famGet_(families_(bookings_(), intakeRows_()), owner);
}

/* ── Template docs (one per client + template + session) ── */

function createDoc_(b, s) {
  var tpl = DOC_TEMPLATES[String(b.template || '')];
  if (!tpl) return { ok: false, message: 'Unknown template.' };
  var session = ymdStr_(b.session);
  if (tpl.needsSession && !session) return { ok: false, message: 'Please pick the session.' };
  var t = ownerTarget_(String(b.owner || ''), tpl.cat, true);
  if (!t || t.isSchool) return { ok: false, message: 'Client not found.' };
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    delete MEMO_.files;
    var have = fileRows_().filter(function (x) { return x.owner === t.owner && x.template === b.template && x.session === (tpl.needsSession ? session : x.session) && !x.status; });
    for (var i = 0; i < have.length; i++) { var lf = liveFile_(have[i].id); if (lf) return { ok: true, existing: true, file: fileOut_(lf, have[i]), message: 'This document already exists – opening it.' }; }
    var f = t.fam, child = f.children[0] || 'Child', title = tpl.name + ' – ' + child + (session ? ' – ' + Utilities.formatDate(ymd_(session), tz_(), 'd MMM yyyy') : '');
    var doc = DocumentApp.create(title), file = DriveApp.getFileById(doc.getId());
    try {
      file.moveTo(t.folder);                                    // straight into the client's folder, never left in My Drive
      fillTemplate_(String(b.template), doc.getBody(), t, session, s);
      doc.saveAndClose();
    } catch (e) { try { file.setTrashed(true); } catch (x) {} throw e; }
    indexFile_(file, { owner: t.owner, cat: tpl.cat, session: session, source: 'template', template: String(b.template), by: s.u });
    audit_(s.u, 'create-doc', t.owner + ': ' + title);
    return { ok: true, file: fileOut_(file, { cat: tpl.cat, session: session, by: s.u, source: 'template', template: String(b.template) }) };
  } finally { lock.releaseLock(); }
}
function fillTemplate_(key, body, t, session, s) {
  var f = t.fam, c = t.row || {}, child = f.children[0] || 'Child', parent = f.parents[0] || '';
  var H = DocumentApp.ParagraphHeading;
  var h = function (txt, lvl) { body.appendParagraph(txt).setHeading(lvl || H.HEADING2); };
  var p = function (txt) { body.appendParagraph(txt); };
  var bullet = function (txt) { body.appendListItem(txt); };
  body.clear();
  var meta = child + (parent ? ' · ' + f.parents.join(', ') : '') + (c.school ? ' · ' + c.school : '');
  var intake = intakeRows_().filter(function (x) { return f.intakes.indexOf(x.row) >= 0; });
  if (key === 'hypotheses') {
    docTitle_(body, 'Hypotheses – ' + child);
    p(meta + ' · prepared ' + Utilities.formatDate(new Date(), tz_(), 'd MMM yyyy'));
    h('Presenting concerns'); p('');
    h('Strengths and what is going well'); p('');
    h('Working hypotheses'); bullet('H1: '); bullet('H2: '); bullet('H3: ');
    h('What would confirm or rule these out'); p('');
    h('Plan for the first session'); p('');
    h('Questions for the parents'); p('');
    if (intake.length) {
      h('From the intake form');
      intake[0].answers.forEach(function (qa) { body.appendParagraph(qa[0]).editAsText().setBold(true); body.appendParagraph(String(qa[1])).editAsText().setBold(false); });
    }
  } else if (key === 'session') {
    var d = ymd_(session), label = Utilities.formatDate(d, tz_(), 'EEEE d MMMM yyyy');
    docTitle_(body, 'Session notes – ' + child);
    p(meta + ' · session on ' + label);
    h('Summary'); p('');
    h('Observations'); p('');
    h('What we tried'); p('');
    h('Hypotheses – update'); p('');
    h('Plan for home / school'); p('');
    h('Next session'); p('');
    var tr = tIndex_(t.famAll).filter(function (x) { return x.fam === f.key && ymdStr_(new Date(x.when)) === session; })[0];
    if (tr) {
      h('Gemini meeting notes (copied from the transcript)');
      var link = body.appendParagraph('Open the full transcript'); link.setLinkUrl(tr.url);
      var txt = '';
      try {
        var gd = DocumentApp.openById(tr.id), tabs = gd.getTabs();
        txt = tabs.length ? tabs[0].asDocumentTab().getBody().getText() : gd.getBody().getText();
      } catch (x) { try { txt = DocumentApp.openById(tr.id).getBody().getText(); } catch (y) {} }
      String(txt || '').slice(0, 20000).split(/\n+/).forEach(function (line) { if (line.trim()) p(line); });
    } else { h('Gemini meeting notes'); p('No transcript is linked to this session yet. Link it under Transcripts, or paste notes here.'); }
  } else if (key === 'parent') {
    docTitle_(body, 'Summary for ' + (parent ? first_(parent) : 'parents') + ' – ' + child);
    p(Utilities.formatDate(new Date(), tz_(), 'd MMMM yyyy'));
    p('Dear ' + (parent ? first_(parent) : 'parents') + ',');
    p('Thank you for the sessions so far. Here is a short summary of what we have seen and what you can try at home.');
    h('What we noticed'); p('');
    h('What is helping'); p('');
    h('Ideas to try at home'); bullet(''); bullet(''); bullet('');
    h('Next steps'); p('');
    p('Warm regards,'); p('Nidhi Rao'); p('Samhithe – Child and Family Wellness');
  } else if (key === 'school') {
    docTitle_(body, 'Letter to ' + (c.school || 'the school') + ' – ' + child);
    p(Utilities.formatDate(new Date(), tz_(), 'd MMMM yyyy'));
    p('To the class teacher' + (c.school ? ', ' + c.school : '') + ',');
    p('I am working with ' + child + ' and the family' + (parent ? ' (' + f.parents.join(', ') + ')' : '') + '. With the parents’ consent, I am sharing a few ideas that may help in class.');
    h('What helps ' + child); bullet(''); bullet('');
    h('What to watch for'); p('');
    h('How we can stay in touch'); p('');
    p('Warm regards,'); p('Nidhi Rao'); p('Samhithe – Child and Family Wellness · nidhi@samhithe.in');
  }
}
/** First paragraph as the doc's title. (Paragraph.setText returns nothing in Apps Script, so no chaining.) */
function docTitle_(body, text) { var p = body.getParagraphs()[0]; p.setText(text); p.setHeading(DocumentApp.ParagraphHeading.TITLE); }
/** The useful part of a Gemini notes doc: Google's own boilerplate lines removed. */
function geminiText_(txt) {
  var junk = /rate the new|survey|guest list is hidden|^invited$|^attachments$|^meeting records|you should review gemini|how is the quality|help center|get tips and learn|^notes$|^transcript$/i;
  var m = String(txt || '').match(/Summary\s*\n([\s\S]*?)(\n\s*(Details|Next steps|Suggested next steps)\b|$)/i);
  return (m ? m[1] : String(txt || '')).split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l && !junk.test(l); }).join('\n');
}
function first_(s) { return String(s || '').trim().split(/\s+/)[0]; }

/* ── Clients: save, follow-ups, new client ── */

function saveClient_(b, s) {
  var fam = families_(bookings_(), intakeRows_()), f = famGet_(fam, b.key);
  if (!f) return { ok: false, message: 'Client not found.' };
  var fields = {};
  if (b.stage != null) { if (b.stage && STAGES.indexOf(b.stage) < 0) return { ok: false, message: 'Unknown stage.' }; fields['Stage'] = b.stage; }
  if (b.followUp != null) { if (b.followUp && !ymd_(b.followUp)) return { ok: false, message: 'Please pick a date.' }; fields['Follow-up'] = b.followUp ? ymd_(b.followUp) : ''; }
  if (b.followNote != null) fields['Follow-up note'] = String(b.followNote).slice(0, 300);
  if (b.school != null) fields['School'] = String(b.school).slice(0, 120);
  if (b.tags != null) fields['Tags'] = list_(b.tags).slice(0, 12).join(', ');
  var c = saveClientRow_(f, fields);
  if (b.done) tab_('Notes', NOTE_HEADERS).appendRow([new Date(), f.key, '', s.u, 'Follow-up done' + (b.doneNote ? ': ' + String(b.doneNote).slice(0, 500) : '')]);
  audit_(s.u, 'save-client', f.key + ' ' + JSON.stringify(fields).slice(0, 200));
  return { ok: true, crm: clientView_(c, f), notes: notesFor_(f.key, aliasesOf_(fam, f.key)) };
}
function newClient_(b, s) {
  var child = String(b.child || '').trim().slice(0, 60), parent = String(b.parent || '').trim().slice(0, 80);
  var email = String(b.email || '').trim().toLowerCase(), phone = String(b.phone || '').trim();
  if (!child && !parent) return { ok: false, message: 'Please add the child’s or parent’s name.' };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { ok: false, message: 'That email address doesn’t look right.' };
  if (!email && phoneKey_(phone).length < 10) return { ok: false, message: 'Please add a phone number or email, so the client can be matched later.' };
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    delete MEMO_.clients;
    var fam = families_(bookings_(), intakeRows_()), p = phoneKey_(phone);
    var same = fam.list.filter(function (f) { return (email && f.emails.indexOf(email) >= 0) || (p.length >= 10 && f.phones.map(phoneKey_).indexOf(p) >= 0); })[0];
    if (same) return { ok: true, key: same.key, existing: true, message: 'This family is already in the CRM – opening it.' };
    var key = 'm:' + Utilities.getUuid().slice(0, 8);
    writeRow_('Clients', CLIENT_HEADERS, 0, { 'Key': key, 'Child': child, 'Parents': parent, 'Emails': email, 'Phones': phone, 'Stage': STAGES.indexOf(b.stage) >= 0 ? b.stage : 'Enquiry',
      'Follow-up': ymd_(b.followUp) || '', 'Follow-up note': String(b.followNote || '').slice(0, 300), 'School': String(b.school || '').slice(0, 120), 'Created': new Date(), 'Updated': new Date() });
    if (b.note) tab_('Notes', NOTE_HEADERS).appendRow([new Date(), key, '', s.u, String(b.note).slice(0, 4000)]);
    delete MEMO_.clients; bust_(); bustCrm_();
    audit_(s.u, 'new-client', key + ' ' + (child || parent));
    return { ok: true, key: key };
  } finally { lock.releaseLock(); }
}

/* ── Schools ── */

function schoolRows_() { return memo_('schools', function () {
  return rowsOf_('Schools', SCHOOL_HEADERS).filter(function (r) { return r.Key; }).map(function (r) {
    return { row: r._row, key: String(r.Key), name: String(r.Name), type: String(r.Type || ''), city: String(r.City || ''), status: String(r.Status || 'Lead'),
      since: ymdStr_(r.Since), contacts: json_(r.Contacts, []), followUp: ymdStr_(r['Follow-up']), followNote: String(r['Follow-up note'] || ''),
      notes: String(r.Notes || ''), folderId: String(r['Folder ID'] || ''), folders: json_(r.Folders, {}), enquiryRow: Number(r['Enquiry Row']) || 0 };
  });
}); }
function schoolGet_(key) { return schoolRows_().filter(function (x) { return x.key === String(key); })[0] || null; }
function workshopRows_() { return memo_('workshops', function () {
  return rowsOf_('Workshops', WORKSHOP_HEADERS).filter(function (r) { return r.ID; }).map(function (r) {
    return { row: r._row, id: String(r.ID), school: String(r['School Key']), date: ymdStr_(r.Date), title: String(r.Title || ''), teachers: Number(r.Teachers) || 0,
      status: String(r.Status || 'Planned'), fee: Number(r.Fee) || 0, paid: r.Paid === true || String(r.Paid).toUpperCase() === 'TRUE', notes: String(r.Notes || '') };
  });
}); }
function schoolOut_(sc) {
  var ws = workshopRows_().filter(function (w) { return w.school === sc.key; });
  return Object.assign({}, sc, { folders: undefined, folderUrl: sc.folderId ? 'https://drive.google.com/drive/folders/' + sc.folderId : '',
    workshops: ws.length, invoiced: ws.reduce(function (a, w) { return a + w.fee; }, 0), outstanding: ws.filter(function (w) { return !w.paid && w.status !== 'Cancelled'; }).reduce(function (a, w) { return a + w.fee; }, 0),
    lastWorkshop: ws.map(function (w) { return w.date; }).sort().pop() || '' });
}
function schools_(b, s) { return { ok: true, schools: schoolRows_().map(schoolOut_), statuses: SCHOOL_STATUSES }; }
function school_(b, s) {
  var sc = schoolGet_(b.key); if (!sc) return { ok: false, message: 'School not found.' };
  var fam = families_(bookings_(), intakeRows_()), n = norm_(sc.name);
  var kids = clientRows_().filter(function (c) { return c.school && norm_(c.school) === n; }).map(function (c) { var f = famGet_(fam, c.key); return f ? { key: f.key, name: (f.children[0] || '') + ' · ' + (f.parents[0] || '') } : null; }).filter(Boolean);
  return { ok: true, school: schoolOut_(sc), workshops: workshopRows_().filter(function (w) { return w.school === sc.key; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; }),
    files: s.role === 'admin' ? ownerFiles_('school:' + sc.key, sc, true) : [], children: kids, workshopStatuses: WORKSHOP_STATUSES };
}
function saveSchool_(b, s) {
  var name = String(b.name || '').trim().slice(0, 120);
  if (!name) return { ok: false, message: 'Please enter the school’s name.' };
  if (b.status && SCHOOL_STATUSES.indexOf(b.status) < 0) return { ok: false, message: 'Unknown status.' };
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    delete MEMO_.schools;
    var cur = b.key ? schoolGet_(b.key) : null;
    if (b.key && !cur) return { ok: false, message: 'School not found.' };
    var same = schoolRows_().filter(function (x) { return norm_(x.name) === norm_(name) && (!cur || x.key !== cur.key); })[0];
    if (same) return cur ? { ok: false, message: 'Another school already has that name.' } : { ok: true, key: same.key, existing: true, message: 'This school is already in the CRM – opening it.' };
    var contacts = (b.contacts || []).filter(function (c) { return c && (c.name || c.phone || c.email); }).slice(0, 10).map(function (c) {
      return { name: String(c.name || '').slice(0, 60), role: String(c.role || '').slice(0, 60), phone: String(c.phone || '').slice(0, 30), email: String(c.email || '').slice(0, 80) }; });
    var obj = { 'Name': name, 'Type': String(b.type || '').slice(0, 60), 'City': String(b.city || '').slice(0, 60), 'Status': b.status || (cur ? cur.status : 'Lead'),
      'Contacts': JSON.stringify(contacts), 'Notes': String(b.notes || '').slice(0, 2000) };
    if (b.since != null) obj['Since'] = ymd_(b.since) || '';
    if (b.followUp != null) obj['Follow-up'] = ymd_(b.followUp) || '';
    if (b.followNote != null) obj['Follow-up note'] = String(b.followNote).slice(0, 300);
    var key = cur ? cur.key : Utilities.getUuid().slice(0, 8);
    if (!cur) { obj['Key'] = key; obj['Created'] = new Date(); if (b.enquiryRow) obj['Enquiry Row'] = Number(b.enquiryRow); }
    writeRow_('Schools', SCHOOL_HEADERS, cur ? cur.row : 0, obj);
    if (cur && cur.folderId && norm_(cur.name) !== norm_(name)) { var fo = folderById_(cur.folderId); if (fo) fo.setName(safeName_(name) + ' (#' + code_(key) + ')'); }
    delete MEMO_.schools; bustCrm_();
    audit_(s.u, cur ? 'update-school' : 'add-school', name);
    return { ok: true, key: key };
  } finally { lock.releaseLock(); }
}
function schoolFromEnquiry_(b, s) {
  var q = enquiries_().filter(function (x) { return x.row === Number(b.row); })[0];
  if (!q) return { ok: false, message: 'Enquiry not found.' };
  var already = schoolRows_().filter(function (x) { return x.enquiryRow === q.row || norm_(x.name) === norm_(q.School); })[0];
  if (already) return { ok: true, key: already.key, existing: true };
  return saveSchool_({ name: q.School, city: q['Area / City'] || '', status: 'Lead', enquiryRow: q.row,
    contacts: [{ name: q['Contact Person'], role: q.Role, phone: q.Phone, email: q.Email }],
    notes: [q['Interested In'] ? 'Interested in: ' + q['Interested In'] : '', q['Children & Ages'] ? 'Children: ' + q['Children & Ages'] : '', q.Message || ''].filter(String).join('\n') }, s);
}
function schoolFollow_(b, s) {
  var sc = schoolGet_(b.key); if (!sc) return { ok: false, message: 'School not found.' };
  var obj = {};
  if (b.followUp != null) obj['Follow-up'] = ymd_(b.followUp) || '';
  if (b.followNote != null) obj['Follow-up note'] = String(b.followNote).slice(0, 300);
  if (b.status && SCHOOL_STATUSES.indexOf(b.status) >= 0) obj['Status'] = b.status;
  if (b.done) obj['Notes'] = (Utilities.formatDate(new Date(), tz_(), 'd MMM yyyy') + ' – follow-up done' + (sc.followNote ? ': ' + sc.followNote : '') + '\n' + sc.notes).slice(0, 2000);
  writeRow_('Schools', SCHOOL_HEADERS, sc.row, obj); delete MEMO_.schools; bustCrm_();
  audit_(s.u, 'school-follow-up', sc.name);
  return school_({ key: sc.key }, s);
}
function saveWorkshop_(b, s) {
  var sc = schoolGet_(b.school); if (!sc) return { ok: false, message: 'School not found.' };
  if (!ymd_(b.date)) return { ok: false, message: 'Please pick the date.' };
  if (!String(b.title || '').trim()) return { ok: false, message: 'Please add a title.' };
  var st = WORKSHOP_STATUSES.indexOf(b.status) >= 0 ? b.status : 'Planned';
  var cur = b.id ? workshopRows_().filter(function (w) { return w.id === b.id; })[0] : null;
  if (b.remove && cur) { tab_('Workshops', WORKSHOP_HEADERS).deleteRow(cur.row); delete MEMO_.workshops; bustCrm_(); return school_({ key: sc.key }, s); }
  writeRow_('Workshops', WORKSHOP_HEADERS, cur ? cur.row : 0, { 'ID': cur ? cur.id : Utilities.getUuid().slice(0, 8), 'School Key': sc.key, 'Date': ymd_(b.date), 'Title': String(b.title).slice(0, 120),
    'Teachers': Number(b.teachers) || 0, 'Status': st, 'Fee': Number(b.fee) || 0, 'Paid': !!b.paid, 'Notes': String(b.notes || '').slice(0, 1000) });
  delete MEMO_.workshops; bustCrm_();
  audit_(s.u, cur ? 'update-workshop' : 'add-workshop', sc.name + ': ' + b.title);
  return school_({ key: sc.key }, s);
}

/* ── CRM overview: pipeline + nudges (one request, cached 60s) ── */

function crm_(b, s) {
  var c = CacheService.getScriptCache(), key = 'crm_' + s.role;
  if (!b.fresh) { var hit = c.get(key); if (hit) return JSON.parse(hit); }
  var bk = bookings_(), fam = families_(bk, intakeRows_()), today = ymdStr_(new Date()), nowIso = new Date().toISOString();
  var files = fileRows_().filter(function (x) { return !x.status; });
  var trAll = tIndex_(fam), tr = s.role === 'admin' ? trAll : [], trBy = {};
  trAll.forEach(function (t) { if (t.fam) (trBy[t.fam] = trBy[t.fam] || []).push(t.when); });   // sessions held outside online booking
  var intakeAt = {}; intakeRows_().forEach(function (x) { intakeAt[x.row] = x.at; });
  var clients = fam.list.map(function (f) {
    var ts = (trBy[f.key] || []).sort(), lastTr = ts.length ? ts[ts.length - 1] : '';
    var cr = clientFor_(f), v = clientView_(cr, f, lastTr);
    return { key: f.key, child: f.children.join(', '), parent: f.parents.join(', '), stage: v.stage, followUp: v.followUp, followNote: v.followNote, school: v.school, tags: v.tags,
      last: (f.last > lastTr ? f.last : lastTr) || '', next: f.next, sessions: Math.max(f.bookings.length, ts.length), transcripts: ts.length, intake: f.intakes.length > 0,
      intakeAt: f.intakes.map(function (r) { return intakeAt[r] || ''; }).sort().pop() || '', files: files.filter(function (x) { return x.owner === f.key; }).length, manual: !!f.manual };
  });
  var nudges = [], add = function (o) { nudges.push(o); };
  clients.forEach(function (cl) {
    if (cl.stage === 'Closed') return;
    var who = (cl.child || cl.parent || 'Client') + (cl.child && cl.parent ? ' · ' + cl.parent : '');
    if (cl.followUp && cl.followUp <= today) add({ kind: cl.followUp < today ? 'bad' : 'wait', icon: 'clock', key: cl.key, title: 'Follow up: ' + who, sub: (cl.followNote || 'Follow-up') + ' · ' + (cl.followUp < today ? 'overdue since ' : 'due ') + dl_(cl.followUp), act: 'Open', href: '#family/' + encodeURIComponent(cl.key), sort: 0 });
    if (s.role !== 'admin') return;
    var mine = files.filter(function (x) { return x.owner === cl.key; });
    var recentIntake = cl.intakeAt && (Date.now() - new Date(cl.intakeAt).getTime()) < 21 * 86400000;   // old, never-booked intakes stay quiet
    if (cl.intake && (cl.next || recentIntake) && !mine.some(function (x) { return x.cat === 'intake' && x.template !== 'prep'; }) && ['Enquiry', 'Intake received', 'First session'].indexOf(cl.stage) >= 0)
      add({ kind: 'wait', icon: 'doc', key: cl.key, title: 'No hypotheses yet for ' + (cl.child || cl.parent), sub: 'Intake form received' + (cl.next ? ' · first session ' + dl_(cl.next) : ''), act: 'Start hypotheses', href: '#family/' + encodeURIComponent(cl.key) + '/new-hypotheses', sort: 2 });
    var quiet = cl.last ? (Date.now() - new Date(cl.last).getTime()) / 86400000 : 0;
    if (cl.stage === 'Ongoing' && !cl.next && cl.last && quiet > 30 && quiet < 120)
      add({ kind: 'blue', icon: 'alert', key: cl.key, title: (cl.child || cl.parent) + ' has had no session in ' + Math.round((Date.now() - new Date(cl.last).getTime()) / 86400000) + ' days', sub: 'Nothing booked yet. Check in, or mark Paused / Closed.', act: 'Check in', href: '#family/' + encodeURIComponent(cl.key), sort: 4 });
  });
  if (s.role === 'admin') {
    // A session held in the last 21 days (with a transcript) but no session notes for that date.
    var seen = {};
    bk.forEach(function (x) {
      if (x.state === 'Cancelled' || !x.fam || x.end > nowIso || (Date.now() - new Date(x.start).getTime()) > 21 * 86400000) return;
      var d = ymdStr_(new Date(x.start)), k = x.fam + d; if (seen[k]) return; seen[k] = 1;
      var hasNotes = files.some(function (y) { return y.owner === x.fam && y.cat === 'notes' && y.session === d; });
      var hasTr = tr.some(function (t) { return t.fam === x.fam && ymdStr_(new Date(t.when)) === d; });
      if (!hasNotes) add({ kind: 'wait', icon: 'note', key: x.fam, title: 'Session notes missing for ' + x.child, sub: 'Session on ' + dl_(d) + (hasTr ? ' has a transcript' : '') + ' but no session-notes doc', act: 'Create notes', href: '#family/' + encodeURIComponent(x.fam) + '/new-session/' + d, sort: 1 });
    });
  }
  bk.forEach(function (x) {
    if (x.state === 'Cancelled' || (x.status || 'To verify') !== 'To verify' || !x.bookedAt) return;
    if (Date.now() - new Date(x.bookedAt).getTime() > 48 * 3600000) add({ kind: 'bad', icon: 'rupee', title: 'Payment unverified · ' + x.child, sub: 'Booked ' + dl_(x.bookedAt) + ' – still “To verify”', act: 'Verify', href: '#booking/' + x.row, sort: 3 });
  });
  var schools = schoolRows_(), ws = workshopRows_();
  schools.forEach(function (sc) {
    if (sc.followUp && sc.followUp <= today) add({ kind: sc.followUp < today ? 'bad' : 'wait', icon: 'schools', title: 'Follow up: ' + sc.name, sub: (sc.followNote || 'Follow-up') + ' · ' + (sc.followUp < today ? 'overdue since ' : 'due ') + dl_(sc.followUp), act: 'Open school', href: '#school/' + sc.key, sort: 0 });
  });
  ws.forEach(function (w) {
    var sc = schools.filter(function (x) { return x.key === w.school; })[0]; if (!sc) return;
    if (w.status === 'Held' && w.date && (Date.now() - ymd_(w.date).getTime()) > 7 * 86400000) add({ kind: 'blue', icon: 'schools', title: sc.name + ': workshop report not sent', sub: w.title + ' · held ' + dl_(w.date), act: 'Open school', href: '#school/' + sc.key, sort: 5 });
    if (w.status !== 'Cancelled' && w.fee && !w.paid && w.date && w.date < today && (Date.now() - ymd_(w.date).getTime()) > 14 * 86400000) add({ kind: 'bad', icon: 'rupee', title: sc.name + ': ₹' + w.fee.toLocaleString() + ' unpaid', sub: w.title + ' · ' + dl_(w.date), act: 'Open school', href: '#school/' + sc.key, sort: 3 });
  });
  var gone = dismissed_();
  nudges.forEach(function (n) { n.id = sha_(n.title + '|' + n.sub).slice(0, 12); });
  nudges = nudges.filter(function (n) { return !gone[n.id]; });
  nudges.sort(function (a, b) { return a.sort - b.sort || (a.kind === 'bad' ? -1 : 1); });
  var out = { ok: true, stages: STAGES, clients: clients, nudges: nudges.slice(0, 40), schools: schools.map(function (x) { return { key: x.key, name: x.name, status: x.status, followUp: x.followUp, city: x.city }; }),
    toFile: s.role === 'admin' ? inboxState_().pending.length : 0, unlinkedTranscripts: tr.filter(function (x) { return !x.fam && !x.dismissed; }).length,
    lastSync: PropertiesService.getScriptProperties().getProperty('CRM_SYNC_AT') || '', crmUrl: s.role === 'admin' ? 'https://drive.google.com/drive/folders/' + crmFolder_('').getId() : '' };
  try { c.put(key, JSON.stringify(out), 60); } catch (x) {}
  return out;
}

/* ── Auto-filing: Inbox folder + files added straight into client folders ── */

function inboxState_() { return json_(PropertiesService.getScriptProperties().getProperty('CRM_INBOX'), { pending: [] }); }
function saveInbox_(st) {                               // a script property holds ~9 KB: keep the list short, never cut the JSON
  st.pending = (st.pending || []).map(function (x) { x.title = String(x.title).slice(0, 90); return x; });
  while (st.pending.length && JSON.stringify(st).length > 8000) st.pending.pop();
  PropertiesService.getScriptProperties().setProperty('CRM_INBOX', JSON.stringify(st));
}
function guessCat_(name) {
  var n = name.toLowerCase();
  if (/hypothes|intake|assessment|case ?history/.test(n)) return 'intake';
  if (/session|notes|transcript|gemini/.test(n)) return 'notes';
  if (/report|letter|summary|certificate/.test(n)) return 'reports';
  return 'materials';
}
/** Best client for a file name: full child name or parent name in the title wins; a unique first name is "probably". */
function guessClient_(name, fam) {
  var n = ' ' + norm_(name) + ' ', strong = [], weak = [];
  fam.list.forEach(function (f) {
    var full = f.children.concat(f.parents).map(norm_).filter(function (x) { return x.indexOf(' ') > 0; });
    if (full.some(function (x) { return n.indexOf(' ' + x + ' ') >= 0; })) { strong.push(f); return; }
    if (f.children.map(function (c) { return norm_(c).split(' ')[0]; }).some(function (x) { return x.length > 2 && n.indexOf(' ' + x + ' ') >= 0; })) weak.push(f);
  });
  if (strong.length === 1) return { f: strong[0], sure: true };
  if (!strong.length && weak.length === 1) return { f: weak[0], sure: false };
  return null;
}
function sync_(b, s) {
  var p = PropertiesService.getScriptProperties(), last = p.getProperty('CRM_SYNC_AT');
  if (!b.force && last && Date.now() - new Date(last).getTime() < CRM.SYNC_MINUTES * 60000) return { ok: true, skipped: true, lastSync: last };
  var lock = LockService.getScriptLock(); if (!lock.tryLock(3000)) return { ok: true, skipped: true, busy: true };
  var filed = 0, indexed = 0;
  try {
    var started = new Date(), fam = families_(bookings_(), intakeRows_()), st = inboxState_(), pending = [];
    // 1. Inbox: move each file to its client (only when sure), or keep it in "To file" with a best guess.
    var inbox = crmFolder_('inbox'), it = inbox.getFiles(), n = 0;
    while (it.hasNext() && n < 60) {
      var file = it.next(); n++; if (file.isTrashed()) continue;
      var md5 = fileMd5_(file), dup = findDuplicate_(md5, file.getSize());
      if (dup && dup.id !== file.getId()) { pending.push({ id: file.getId(), title: file.getName(), url: file.getUrl(), dup: { id: dup.id, title: dup.title, owner: dup.owner, ownerName: ownerName_(dup.owner) } }); continue; }
      var g = guessClient_(file.getName(), fam), cat = guessCat_(file.getName());
      if (g && g.sure) {
        var cf = clientFolders_(g.f, true);
        file.moveTo(cf[cat]);
        indexFile_(file, { owner: g.f.key, cat: cat, md5: md5, source: 'auto-filed', by: 'auto' }); filed++;
        audit_('auto', 'auto-file', file.getName() + ' → ' + g.f.key + ' / ' + cat);
      } else pending.push({ id: file.getId(), title: file.getName(), url: file.getUrl(), guess: g ? { key: g.f.key, name: (g.f.children[0] || '') + ' · ' + (g.f.parents[0] || '') } : null, cat: cat });
    }
    st.pending = pending; saveInbox_(st);
    // 2. Files Nidhi put straight into client/school folders in Drive since the last sync: index them (so reminders know).
    var fm = folderMap_(), since = last ? new Date(new Date(last).getTime() - 5 * 60000) : new Date(Date.now() - 30 * 86400000);
    var known = {}; fileRows_().forEach(function (x) { known[x.id] = x; });
    var q = "modifiedDate > '" + Utilities.formatDate(since, 'UTC', "yyyy-MM-dd'T'HH:mm:ss") + "' and trashed = false and mimeType != 'application/vnd.google-apps.folder'";
    var it2 = DriveApp.searchFiles(q), m = 0;
    while (it2.hasNext() && m < 200) {
      var f2 = it2.next(); m++;
      var parents = f2.getParents(), hit = null;
      while (parents.hasNext() && !hit) hit = fm[parents.next().getId()] || null;
      if (!hit) continue;
      var k = known[f2.getId()];
      if (k && k.owner === hit.owner && k.cat === hit.cat && !k.status) continue;
      indexFile_(f2, { owner: hit.owner, cat: hit.cat, md5: k && k.md5 ? k.md5 : fileMd5_(f2), source: k ? k.source : 'drive', by: k ? k.by : 'drive' }); indexed++;
    }
    p.setProperty('CRM_SYNC_AT', started.toISOString());
    bustCrm_();
    return { ok: true, filed: filed, indexed: indexed, pending: pending.length, lastSync: started.toISOString() };
  } finally { lock.releaseLock(); }
}
function inbox_(b, s) {
  var st = inboxState_(), fam = families_(bookings_(), intakeRows_());
  var names = fam.list.map(function (f) { return { key: f.key, name: (f.children.join(', ') || '—') + ' · ' + (f.parents[0] || f.emails[0] || '') }; })
    .sort(function (a, z) { return a.name < z.name ? -1 : 1; });
  return { ok: true, pending: st.pending || [], clients: names, schools: schoolRows_().map(function (x) { return { key: 'school:' + x.key, name: x.name }; }),
    inboxUrl: crmFolder_('inbox').getUrl(), lastSync: PropertiesService.getScriptProperties().getProperty('CRM_SYNC_AT') || '' };
}
/** File one Inbox item: move it (never copy) to the chosen client/school folder. Or trash it if it is a duplicate. */
function fileItem_(b, s) {
  var st = inboxState_(), item = (st.pending || []).filter(function (x) { return x.id === b.id; })[0];
  if (!item) return { ok: false, message: 'That file is no longer waiting. Refresh the list.' };
  var file = liveFile_(item.id);
  var drop = function () { st.pending = st.pending.filter(function (x) { return x.id !== item.id; }); saveInbox_(st); bustCrm_(); };
  if (!file) { drop(); return inbox_(b, s); }
  var inboxId = crmFolder_('inbox').getId(), parents = file.getParents(), inInbox = false;
  while (parents.hasNext()) if (parents.next().getId() === inboxId) inInbox = true;
  if (!inInbox) { drop(); return inbox_(b, s); }
  if (b.trash) {
    if (!item.dup || !liveFile_(item.dup.id)) return { ok: false, message: 'Only duplicates can be trashed from here.' };
    file.setTrashed(true); drop(); audit_(s.u, 'trash-duplicate', item.title); return inbox_(b, s);
  }
  if (b.ignore) { drop(); return inbox_(b, s); }
  var t = ownerTarget_(String(b.owner || ''), String(b.cat || item.cat || 'materials'), true);
  if (!t) return { ok: false, message: 'Please choose a client or school.' };
  file.moveTo(t.folder);
  indexFile_(file, { owner: t.owner, cat: t.cat, md5: fileMd5_(file), source: 'filed', by: s.u });
  drop(); audit_(s.u, 'file-item', item.title + ' → ' + t.owner + ' / ' + t.cat);
  return inbox_(b, s);
}

/* ── Smart search: clients, schools, notes, documents (titles + text inside), transcripts ── */

function search_(b, s) {
  var q = String(b.q || '').trim().slice(0, 80), nq = norm_(q);
  if (nq.length < 2) return { ok: true, results: [] };
  var words = nq.split(' '), has = function (txt) { var t = norm_(txt); return words.every(function (w) { return t.indexOf(w) >= 0; }); };
  var fam = families_(bookings_(), intakeRows_()), res = [], famName = {};
  fam.list.forEach(function (f) {
    var cr = clientFor_(f), name = (f.children.join(', ') || '—') + ' · ' + (f.parents.join(', ') || f.emails[0] || '');
    famName[f.key] = name;
    var hay = [f.children.join(' '), f.parents.join(' '), f.emails.join(' '), f.phones.join(' '), cr ? cr.school + ' ' + cr.tags.join(' ') : ''].join(' ');
    if (has(hay) || (phoneKey_(q).length >= 6 && f.phones.some(function (p) { return phoneKey_(p).indexOf(phoneKey_(q)) >= 0; })))
      res.push({ type: 'Client', title: name, sub: stageOf_(f, cr), href: '#family/' + encodeURIComponent(f.key) });
  });
  schoolRows_().forEach(function (sc) {
    if (has(sc.name + ' ' + sc.city + ' ' + sc.contacts.map(function (c) { return c.name + ' ' + c.phone + ' ' + c.email; }).join(' ') + ' ' + sc.notes))
      res.push({ type: 'School', title: sc.name, sub: sc.status + (sc.city ? ' · ' + sc.city : ''), href: '#school/' + sc.key });
  });
  if (s.role === 'admin') {
    var sh = tab_('Notes', NOTE_HEADERS), n = sh.getLastRow() - 1;
    if (n > 0) sh.getRange(2, 1, n, NOTE_HEADERS.length).getValues().forEach(function (r) {
      var txt = String(r[4]); if (!has(txt)) return;
      var key = String(r[1]), f = famGet_(fam, key); if (!f) return;
      var i = txt.toLowerCase().indexOf(words[0]);
      res.push({ type: 'Note', title: 'Note · ' + (r[0] instanceof Date ? Utilities.formatDate(r[0], tz_(), 'd MMM yyyy') : '') + ' · ' + (f.children[0] || f.parents[0] || ''), sub: (i > 40 ? '…' : '') + txt.slice(Math.max(0, i - 40), i + 120), href: '#family/' + encodeURIComponent(f.key), at: iso_(r[0]) });
    });
    intakeRows_().forEach(function (x) {                       // intake form answers
      var hit = x.answers.filter(function (qa) { return has(qa[1]) || has(qa[0] + ' ' + qa[1]); })[0];
      if (!hit) return;
      var f = fam.list.filter(function (ff) { return ff.intakes.indexOf(x.row) >= 0; })[0]; if (!f) return;
      res.push({ type: 'Intake', title: 'Intake · ' + (x.child || x.parent || ''), sub: hit[0] + ': ' + String(hit[1]).slice(0, 140), href: '#family/' + encodeURIComponent(f.key) });
    });
    var files = fileRows_().filter(function (x) { return !x.status; }), byId = {};
    files.forEach(function (x) { byId[x.id] = x; });
    var hitIds = {};
    files.forEach(function (x) { if (has(x.title + ' ' + x.note)) hitIds[x.id] = 'title'; });
    var qq = q.replace(/['\\]/g, ' ');
    try { var it = DriveApp.searchFiles("fullText contains '" + qq + "' and trashed = false"), k = 0; while (it.hasNext() && k < 300) { var id = it.next().getId(); k++; if (byId[id] && !hitIds[id]) hitIds[id] = 'text'; } } catch (x) {}
    var catName = {}; CLIENT_CATS.concat(SCHOOL_CATS).forEach(function (c) { catName[c[0]] = c[1].replace(/^\d /, ''); });
    Object.keys(hitIds).forEach(function (id) {
      var x = byId[id], isS = x.owner.indexOf('school:') === 0, sc = isS ? schoolGet_(x.owner.slice(7)) : null;
      res.push({ type: 'Document', title: x.title, sub: (isS ? (sc ? sc.name : 'School') : (famName[x.owner] || famName[(fam.alias || {})[x.owner]] || 'Client')) + ' · ' + (catName[x.cat] || x.cat) + (hitIds[id] === 'text' ? ' · match inside' : ''),
        href: 'https://drive.google.com/open?id=' + id, external: true, owner: isS ? '#school/' + x.owner.slice(7) : '#family/' + encodeURIComponent(x.owner) });
    });
    var tr = tIndex_(fam), tHits = {};
    try { var it3 = DriveApp.searchFiles("fullText contains '" + qq + "' and title contains 'Notes by Gemini' and trashed = false"), j = 0; while (it3.hasNext() && j < 100) { tHits[it3.next().getId()] = 1; j++; } } catch (x) {}
    var later = [];
    tr.forEach(function (t) {
      if (!(tHits[t.id] || has(t.meeting))) return;
      var o = { type: 'Transcript', title: t.meeting, sub: Utilities.formatDate(new Date(t.when), tz_(), 'd MMM yyyy') + (t.fam ? ' · ' + (famName[t.fam] || '') : t.dismissed ? ' · not a client session' : ' · not filed'), href: '#transcript/' + encodeURIComponent(t.id) };
      (t.dismissed ? later : res).push(o);
    });
    res = res.concat(later);
  }
  audit_(s.u, 'search', q);
  return { ok: true, q: q, results: res.slice(0, 120) };
}

/* ── Prep pack for Claude ── */

function prep_(b, s) {
  var fam = families_(bookings_(), intakeRows_()), f = famGet_(fam, b.key);
  if (!f) return { ok: false, message: 'Client not found.' };
  var inc = b.include || {}, on = function (k, d) { return inc[k] == null ? d : !!inc[k]; };
  var cr = clientFor_(f), v = clientView_(cr, f), bk = bookings_().filter(function (x) { return x.fam === f.key && x.state !== 'Cancelled'; }).sort(function (a, z) { return a.start < z.start ? -1 : 1; });
  var files = ownerFiles_(f.key, cr), tr = tIndex_(fam).filter(function (t) { return t.fam === f.key; });
  var fmt = function (iso) { return Utilities.formatDate(new Date(iso), tz_(), 'EEE d MMM yyyy, h:mm a'); };
  var past = bk.filter(function (x) { return x.end < new Date().toISOString(); }), next = bk.filter(function (x) { return x.start >= new Date().toISOString(); })[0];
  var childLabel = on('names', true) ? (f.children.join(', ') || 'the child') : 'the child (name withheld)';
  var L = [];
  L.push('I am Nidhi Rao, a child and family wellness practitioner (Samhithe). Please help me prepare for my next session with a client.');
  L.push('');
  L.push('CLIENT');
  L.push('Child: ' + childLabel + (bk[0] && bk[0].age ? ', age ' + bk[0].age : ''));
  if (on('names', true)) L.push('Parents: ' + f.parents.join(', '));
  if (v.school) L.push('School: ' + v.school);
  var held = Math.max(past.length, tr.length);
  L.push('Stage: ' + v.stage + ' · sessions so far: ' + held + (next ? ' · next session: ' + fmt(next.start) + ' (session ' + (held + 1) + ')' : ''));
  if (v.tags.length) L.push('Tags: ' + v.tags.join(', '));
  if (on('contact', false)) L.push('Contact: ' + f.phones.concat(f.emails).join(', '));
  var intake = intakeRows_().filter(function (x) { return f.intakes.indexOf(x.row) >= 0; })[0];
  if (intake && on('intake', true)) {
    L.push(''); L.push('INTAKE FORM ANSWERS');
    intake.answers.forEach(function (qa) { L.push('- ' + qa[0] + ': ' + String(qa[1]).replace(/\s+/g, ' ').slice(0, 600)); });
  }
  var catLabel = {}; CLIENT_CATS.forEach(function (c) { catLabel[c[0]] = c[1].replace(/^\d /, ''); });
  if (on('docs', true) && files.some(function (x) { return x.template !== 'prep'; })) {
    L.push(''); L.push('DOCUMENTS (Google Drive – open these links)');
    CLIENT_CATS.forEach(function (c) {
      var fs = files.filter(function (x) { return x.cat === c[0] && x.template !== 'prep'; });
      if (!fs.length) return;
      L.push(catLabel[c[0]] + ':');
      fs.forEach(function (x) { L.push('  • ' + x.title + ' (' + Utilities.formatDate(new Date(x.at), tz_(), 'd MMM yyyy') + '): ' + x.url); });
    });
  }
  if (on('transcripts', true) && tr.length) {
    L.push(''); L.push('SESSION TRANSCRIPTS (Gemini meeting notes)');
    tr.slice(0, 6).forEach(function (t) { L.push('  • ' + Utilities.formatDate(new Date(t.when), tz_(), 'd MMM yyyy') + ': ' + t.url); });
  }
  if (on('summaries', true) && tr.length) {                   // Gemini summaries of the last 2 sessions, so Claude has the content even without Drive access
    L.push(''); L.push('WHAT HAPPENED IN RECENT SESSIONS (Gemini summaries)');
    tr.slice(0, 2).forEach(function (t) {
      var txt = ''; try { var d = DocumentApp.openById(t.id), tabs = d.getTabs(); txt = tabs.length ? tabs[0].asDocumentTab().getBody().getText() : d.getBody().getText(); } catch (x) {}
      var body = geminiText_(txt);
      if (/summary wasn't produced/i.test(body) || !body) return;
      L.push(''); L.push('— ' + Utilities.formatDate(new Date(t.when), tz_(), 'd MMM yyyy') + ' —'); L.push(body.slice(0, 1800));
    });
  }
  var notes = notesFor_(f.key, aliasesOf_(fam, f.key)).slice(0, 8);
  if (on('notes', true) && notes.length) {
    L.push(''); L.push('MY RECENT NOTES');
    notes.forEach(function (n) { L.push('- ' + Utilities.formatDate(new Date(n.at), tz_(), 'd MMM') + ': ' + n.text.replace(/\s+/g, ' ').slice(0, 500)); });
  }
  if (on('fulltext', false)) {
    var docs = files.filter(function (x) { return x.mime === 'application/vnd.google-apps.document' && (x.cat === 'intake' || x.cat === 'notes') && x.template !== 'prep'; }).slice(0, 4);
    if (docs.length) { L.push(''); L.push('FULL TEXT OF KEY DOCUMENTS'); }
    docs.forEach(function (d) { var t = ''; try { t = DocumentApp.openById(d.id).getBody().getText(); } catch (x) {} L.push(''); L.push('=== ' + d.title + ' ==='); L.push(t.slice(0, 12000)); });
  }
  L.push(''); L.push('PLEASE');
  L.push('1. Summarise where we are, in a few lines.');
  L.push('2. Update my working hypotheses (what supports or weakens each).');
  L.push('3. Suggest a plan for the next session: aims, 2–3 activities, and what to observe.');
  L.push('4. List questions to ask the parents, and anything to share with them or the school.');
  L.push('If you cannot open a link, tell me which one and I will paste it in.');
  var text = L.join('\n');
  if (!on('names', true)) {                                   // names off: also mask them inside document titles and notes
    f.children.concat(f.parents).filter(function (n) { return n && n.length > 1; }).forEach(function (n) {
      var firstName = n.trim().split(/\s+/)[0];
      [n.trim()].concat(firstName.length > 2 && firstName !== n.trim() ? [firstName] : []).forEach(function (w) {   // full name, then first name
        text = text.replace(new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'), f.children.indexOf(n) >= 0 ? '[child]' : '[parent]');
      });
    });
  }
  audit_(s.u, 'prep-pack', f.key + (b.save ? ' (saved to Drive)' : ''));
  if (!b.save) return { ok: true, text: text };
  // Save: ONE prep doc per client, rewritten each time (never a new copy).
  var t = ownerTarget_(f.key, 'intake', true), lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    delete MEMO_.files;
    var row = fileRows_().filter(function (x) { return x.owner === t.owner && x.template === 'prep' && !x.status; })[0], doc, file = row && liveFile_(row.id);
    if (file) doc = DocumentApp.openById(file.getId());
    else { doc = DocumentApp.create('Claude prep pack – ' + (f.children[0] || 'Child')); file = DriveApp.getFileById(doc.getId()); file.moveTo(t.folder); var made = true; }
    try {
    var body = doc.getBody(); body.clear();
    docTitle_(body, 'Claude prep pack – ' + (f.children[0] || 'Child') + ' – ' + Utilities.formatDate(new Date(), tz_(), 'd MMM yyyy'));
    text.split('\n').forEach(function (line) { body.appendParagraph(line); });
    doc.saveAndClose();
    } catch (e) { if (made) { try { file.setTrashed(true); } catch (x) {} } throw e; }
    indexFile_(file, { owner: t.owner, cat: 'intake', source: 'template', template: 'prep', by: s.u });
    return { ok: true, text: text, file: fileOut_(file, { cat: 'intake', template: 'prep' }) };
  } finally { lock.releaseLock(); }
}

/* ── Drive check: find and remove duplicate copies inside Samhithe CRM ── */

function driveCheck_(b, s) {
  var root = crmFolder_(''), files = [], walk = function (fo, path, depth) {
    var it = fo.getFiles();
    while (it.hasNext() && files.length < 3000) { var f = it.next(); if (!f.isTrashed()) files.push({ f: f, path: path }); }
    if (depth > 4) return;
    var sub = fo.getFolders();
    while (sub.hasNext()) { var x = sub.next(); if (!x.isTrashed()) walk(x, path + ' / ' + x.getName(), depth + 1); }
  };
  walk(root, CRM.ROOT, 0);
  var known = {}; fileRows_().forEach(function (x) { known[x.id] = x; });
  var groups = {};
  files.forEach(function (o) {
    var f = o.f, id = f.getId(), mime = f.getMimeType(), k = known[id], key;
    if (isGoogleType_(mime)) key = 'g|' + mime + '|' + norm_(f.getName()) + '|' + o.path;      // Google Docs: same name in the same folder
    else { var md5 = (k && k.md5 && k.size === f.getSize()) ? k.md5 : fileMd5_(f); if (!md5) return; key = 'm|' + md5; }
    (groups[key] = groups[key] || []).push({ id: id, title: f.getName(), path: o.path, url: f.getUrl(), size: f.getSize(), created: f.getDateCreated().toISOString(), indexed: !!(k && !k.status) });
  });
  var dups = Object.keys(groups).filter(function (k) { return groups[k].length > 1; }).map(function (k) {
    var g = groups[k].sort(function (a, z) { return (z.indexed - a.indexed) || (a.created < z.created ? -1 : 1); });   // keep: indexed first, then the oldest
    return { kind: k[0] === 'g' ? 'same name' : 'identical', keep: g[0], extra: g.slice(1) };
  });
  audit_(s.u, 'drive-check', files.length + ' files, ' + dups.length + ' duplicate groups');
  return { ok: true, scanned: files.length, groups: dups, rootUrl: root.getUrl() };
}
function trashDupes_(b, s) {
  var ids = (b.ids || []).slice(0, 200).map(String), chk = driveCheck_({}, s), allowed = {};
  chk.groups.forEach(function (g) { g.extra.forEach(function (x) { allowed[x.id] = true; }); });
  var n = 0;
  ids.forEach(function (id) {
    if (!allowed[id]) return;
    var f = liveFile_(id); if (!f) return;
    f.setTrashed(true); n++;
    var row = fileRows_().filter(function (x) { return x.id === id; })[0];
    if (row) { writeRow_('Files', FILE_HEADERS, row.row, { 'Status': 'trashed' }); delete MEMO_.files; }
  });
  bustCrm_();
  audit_(s.u, 'trash-duplicates', n + ' file(s)');
  var out = driveCheck_({}, s); out.trashed = n; return out;
}

/* ── Reminders Nidhi has hidden ("Not needed") ── */
function dismissed_() { return json_(PropertiesService.getScriptProperties().getProperty('CRM_DISMISSED'), {}); }
function dismiss_(b, s) {
  var d = dismissed_(), id = String(b.id || '').slice(0, 12);
  if (!/^[a-f0-9]{12}$/.test(id)) return { ok: false, message: 'Unknown reminder.' };
  d[id] = Date.now();
  var keys = Object.keys(d).sort(function (a, z) { return d[z] - d[a]; }).slice(0, 250), keep = {};
  keys.forEach(function (k) { keep[k] = d[k]; });
  PropertiesService.getScriptProperties().setProperty('CRM_DISMISSED', JSON.stringify(keep));
  bustCrm_(); audit_(s.u, 'dismiss-reminder', id);
  return { ok: true };
}

/* ───────────────────────── Setup (run once from the editor) ───────────────────────── */

function setup() {
  [['Users', USER_HEADERS], ['Notes', NOTE_HEADERS], ['Message templates', TEMPLATE_HEADERS],
   ['Transcript links', LINK_HEADERS], ['Audit log', AUDIT_HEADERS], ['Clients', CLIENT_HEADERS], ['Files', FILE_HEADERS],
   ['Schools', SCHOOL_HEADERS], ['Workshops', WORKSHOP_HEADERS]].forEach(function (t) { tab_(t[0], t[1]); });
  console.log('CRM folder: ' + crmFolder_('').getUrl() + ' · Inbox: ' + crmFolder_('inbox').getUrl());
  templates_();
  var sh = tab_('Users', USER_HEADERS);
  if (sh.getLastRow() < 2) sh.appendRow(['nidhi', 'Nidhi Rao', 'nidhi@samhithe.in', 'admin', true, '', '', 0, '', '', new Date()]);
  sh.getRange('E2:E200').insertCheckboxes();
  sh.getRange(2, 4, 199, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['admin', 'assistant'], true).build());
  sh.hideColumns(6, 2);                                     // Salt / Hash
  pepper_();
  Calendar.Calendars.get('primary');
  console.log('Users: ' + users_().map(function (u) { return u.username + ' (' + u.role + ')'; }).join(', '));
  console.log('Transcripts found: ' + tIndex_().length);
}

/* ───────────────────────── Helpers ───────────────────────── */

var SS_ = null;
function ss_() { return SS_ || (SS_ = SpreadsheetApp.openById(CFG.SHEET_ID)); }
function tz_() { return Session.getScriptTimeZone(); }

function tab_(name, headers) {
  var ss = ss_(), sh = ss.getSheetByName(name);
  if (sh) return sh;
  sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#EDE6F5');
  sh.setFrozenRows(1);
  return sh;
}

function audit_(user, action, detail) {
  try { tab_('Audit log', AUDIT_HEADERS).appendRow([new Date(), user || '', action, String(detail || '').slice(0, 300)]); } catch (x) {}
}

var MEMO_ = {};
function memo_(k, fn) { if (!MEMO_.hasOwnProperty(k)) MEMO_[k] = fn(); return MEMO_[k]; }
function bust_() { try { CacheService.getScriptCache().removeAll(['data_admin', 'data_assistant', 'crm_admin', 'crm_assistant']); } catch (x) {} }
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function iso_(v) { if (v instanceof Date && !isNaN(v)) return v.toISOString(); return ''; }
function mins_(t) { var m = String(t || '').match(/^(\d{1,2}):(\d{2})$/); if (!m || +m[1] > 24 || +m[2] > 59) return null; return Math.min(+m[1] * 60 + +m[2], 1440); }
function ampm_(m) { var h = Math.floor(m / 60), mm = ('0' + (m % 60)).slice(-2); return ((h % 12) || 12) + ':' + mm + ' ' + (h < 12 || h === 24 ? 'AM' : 'PM'); }
function to24_(s) {
  var m = String(s || '').trim().toLowerCase().replace(/\./g, ':').match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?$/);
  if (!m) return ''; var h = +m[1], mm = +(m[2] || 0); if (m[3]) h = h % 12 + (m[3] === 'pm' ? 12 : 0);
  return ('0' + h).slice(-2) + ':' + ('0' + mm).slice(-2);
}
function ymd_(s) { var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
function phoneKey_(p) { return String(p || '').replace(/\D/g, '').slice(-10); }
function esc_(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function wrap_(inner) {
  return '<div style="background:#FDF8F5;padding:28px 16px;font-family:Helvetica,Arial,sans-serif;color:#2B2622;line-height:1.6">' +
    '<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #EADFD4;border-radius:18px;padding:30px">' +
    '<div style="color:#CB5521;font-family:Georgia,serif;font-size:20px;margin-bottom:18px">Samhithe <span style="color:#4D7A2E;font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:.18em">CHILD AND FAMILY WELLNESS</span></div>' +
    inner + '</div></div>';
}
