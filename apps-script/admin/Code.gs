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
 * Extra sheet tabs created by setup(): Users, Notes, Message templates, Transcript links, Audit log.
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
  logout:        { run: function (b, s) { CacheService.getScriptCache().remove('s_' + b.token); audit_(s.u, 'logout', ''); return { ok: true }; } },
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
  sendLink:      { run: function (b, s) { var r = forgot_({ username: b.username }, true); audit_(s.u, 'send-password-link', b.username); return r; }, admin: true }
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
  CacheService.getScriptCache().put('s_' + token, JSON.stringify(s), CFG.SESSION_HOURS * 3600);
  audit_(u.username, 'login', '');
  return { ok: true, token: token, user: s };
}

/** Returns the session for a token (and keeps it alive), or null. */
function session_(token) {
  if (!token || !/^[a-f0-9]{64}$/.test(String(token))) return null;
  var c = CacheService.getScriptCache(), raw = c.get('s_' + token);
  if (!raw) return null;
  c.put('s_' + token, raw, CFG.SESSION_HOURS * 3600);
  return JSON.parse(raw);
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
  audit_(u.username, 'password-set', 'via email link');
  return login_({ username: u.username, password: pw });
}

function changePassword_(b, s) {
  var u = findUser_(s.u);
  if (!u || hash_(String(b.current || ''), u.salt) !== u.hash) return { ok: false, message: 'Your current password is not correct.' };
  var bad = passwordProblem_(String(b.password || ''));
  if (bad) return { ok: false, message: bad };
  var salt = rand_().slice(0, 32);
  setUser_(u, { 'Salt': salt, 'Hash': hash_(String(b.password), salt) });
  audit_(s.u, 'password-changed', '');
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
function setUser_(u, fields) {
  var sh = tab_('Users', USER_HEADERS);
  Object.keys(fields).forEach(function (k) {
    var c = USER_HEADERS.indexOf(k);
    if (c >= 0) sh.getRange(u.row, c + 1).setValue(fields[k]);
  });
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
  var addU = function (arr, v) { if (v && arr.indexOf(v) < 0) arr.push(v); };
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
  return { map: fams, list: order.map(function (k) { return fams[k]; }) };
}

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
  var f = fam.map[String(b.key || '')];
  if (!f) return { ok: false, message: 'Family not found.' };
  var out = { ok: true, family: f, bookings: bk.filter(function (x) { return x.fam === f.key; }).map(function (x) { var y = Object.assign({}, x); delete y.shot; y.hasShot = !!x.shot; return y; }),
    notes: notesFor_(f.key) };
  if (s.role === 'admin') {
    out.intakes = intakes.filter(function (x) { return f.intakes.indexOf(x.row) >= 0; });
    out.transcripts = tIndex_(fam).filter(function (t) { return t.fam === f.key; });
    audit_(s.u, 'view-family', f.key);
  }
  return out;
}

function notesFor_(key) {
  var sh = tab_('Notes', NOTE_HEADERS), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, NOTE_HEADERS.length).getValues().filter(function (r) { return String(r[1]) === key; }).map(function (r) {
    return { at: iso_(r[0]), row: r[2], by: String(r[3]), text: String(r[4]) };
  }).reverse();
}

function addNote_(b, s) {
  var text = String(b.text || '').trim().slice(0, 4000), key = String(b.key || '');
  if (!text || !key) return { ok: false, message: 'Please write a note.' };
  tab_('Notes', NOTE_HEADERS).appendRow([new Date(), key, b.row || '', s.u, text]);
  audit_(s.u, 'add-note', key);
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
  fam.list.forEach(function (f) { names[f.key] = (f.parents[0] || f.emails[0] || f.key) + (f.children.length ? ' · ' + f.children.join(', ') : ''); });
  return { ok: true, transcripts: tIndex_(fam), familyNames: names };
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
  var sh = tab_('Transcript links', LINK_HEADERS), n = sh.getLastRow() - 1;
  if (n > 0) {
    var ids = sh.getRange(2, 1, n, 1).getValues().map(function (r) { return String(r[0]); });
    var i = ids.indexOf(id);
    if (i >= 0) sh.deleteRow(i + 2);
  }
  if (key) sh.appendRow([id, key, s.u, new Date()]);
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
  else tab_('Users', USER_HEADERS).appendRow([username, name, email, role, active, '', '', 0, '', '', new Date()]);
  audit_(s.u, b.isNew ? 'add-user' : 'update-user', username + ' (' + role + (active ? '' : ', inactive') + ')');
  return usersList_();
}

/* ───────────────────────── Setup (run once from the editor) ───────────────────────── */

function setup() {
  [['Users', USER_HEADERS], ['Notes', NOTE_HEADERS], ['Message templates', TEMPLATE_HEADERS],
   ['Transcript links', LINK_HEADERS], ['Audit log', AUDIT_HEADERS]].forEach(function (t) { tab_(t[0], t[1]); });
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
function bust_() { try { CacheService.getScriptCache().removeAll(['data_admin', 'data_assistant']); } catch (x) {} }
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
