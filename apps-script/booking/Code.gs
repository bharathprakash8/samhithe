/**
 * Samhithe – Session booking backend (Google Apps Script)
 *
 * Powers www.samhithe.in/booking:
 *   GET  ?action=slots  → open slots, date-wise, built from the "Availability" tab of the
 *                          Samhithe bookings sheet, minus "Time off" days and anything already
 *                          on Nidhi's Google Calendar.
 *   POST {action:"book"} → saves the payment screenshot to Drive, books the calendar event
 *                          with a Google Meet link, logs it in the sheet and emails both sides.
 *
 * NIDHI MANAGES EVERYTHING IN ONE GOOGLE SHEET ("Samhithe – Bookings & Availability"):
 *   • Availability – weekly hours (Day / From / To). Add, edit or delete rows.
 *   • Time off     – dates when no sessions can be booked (holidays, leave).
 *   • Settings     – session length, gap between sessions, notice, how far ahead.
 *   • Bookings     – every booking, with the payment screenshot and Payment Status.
 *   • Intake       – the child & family intake answered by first-time parents before booking.
 *   • School enquiries – call-back requests from preschools / schools.
 * Changes show on the website within a minute – no code changes or redeploys needed.
 *
 * After any CODE change: Deploy → Manage deployments → ✏️ → Version: New version → Deploy.
 */

var CONFIG = {
  SESSION_TITLE: 'Parent Consultation with Nidhi',
  PRICE_INR: 1000,

  // Payment details shown on the booking page and used by the PhonePe / Google Pay buttons
  UPI_ID: 'nidhirao.1997-2@okaxis',
  UPI_NAME: 'Nidhi Rao',

  // Defaults – the "Settings" tab in the sheet overrides these
  SESSION_MINUTES: 60,
  GAP_MINUTES: 15,
  MIN_NOTICE_HOURS: 12,
  DAYS_AHEAD: 30,

  BUFFER_MINUTES: 0,                   // extra gap kept free around other calendar events
  CALENDAR_ID: 'primary',
  NOTIFY_EMAIL: '',                    // where new-booking alerts go; empty = the script owner
  MAX_SCREENSHOT_MB: 8,
  INTAKE_FORM_ID: '1CmylFbrq-nIFeFZp6-QUI4D6c40eGe-JtYFbNlRyg9o',   // Nidhi's original Google intake form
  SHEET_NAME: 'Samhithe – Bookings & Availability',
  FOLDER_NAME: 'Samhithe – Payment Screenshots'
};

var DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Nidhi's starting weekly pattern (copied from her Google Calendar booking page)
var DEFAULT_AVAILABILITY = [
  ['Monday', '6:00 PM', '9:30 PM'],
  ['Tuesday', '11:00 AM', '1:15 PM'],
  ['Tuesday', '4:30 PM', '5:30 PM'],
  ['Tuesday', '6:00 PM', '9:30 PM'],
  ['Wednesday', '6:00 PM', '9:30 PM'],
  ['Thursday', '11:00 AM', '1:15 PM'],
  ['Thursday', '6:00 PM', '9:30 PM'],
  ['Friday', '6:00 PM', '9:30 PM'],
  ['Saturday', '11:00 AM', '1:15 PM']
];

var SETTINGS_ROWS = [
  ['Session length (minutes)', 'SESSION_MINUTES', 'How long each session is.'],
  ['Gap between sessions (minutes)', 'GAP_MINUTES', 'Break kept free after each session.'],
  ['Minimum notice (hours)', 'MIN_NOTICE_HOURS', 'Parents cannot book a slot sooner than this.'],
  ['Booking window (days ahead)', 'DAYS_AHEAD', 'How far ahead parents can book.']
];

var INTAKE_FIXED = ['Submitted At', 'Parent Name', 'Email', 'Phone', 'Child Name', 'Child Age', 'Session'];
var SCHOOL_HEADERS = ['Received At', 'School', 'Contact Person', 'Role', 'Phone', 'Email', 'Area / City',
  'Children & Ages', 'Interested In', 'Best Time to Call', 'Message', 'Status'];

var BOOKING_HEADERS = ['Booked At', 'Session Start', 'Session End', 'Child Name', 'Child Age',
  'Parent Name', 'Email', 'Phone', 'Paid From UPI', 'Notes', 'Screenshot', 'Meet Link',
  'Calendar Event ID', 'Payment Status'];

/* ───────────────────────── Web endpoints ───────────────────────── */

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  try {
    if (action === 'slots') return json_(cachedSlots_());
    return json_({ ok: true, service: 'Samhithe booking' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, message: 'Could not load available times. Please try again shortly.' });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action === 'book') { applySettings_(); return json_(book_(body)); }
    if (body.action === 'lookup') return json_(lookup_(body));
    if (body.action === 'callback') return json_(callback_(body));
    return json_({ ok: false, message: 'Unknown request.' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, message: 'Something went wrong while booking. Please try again, or WhatsApp Nidhi.' });
  }
}

/* ───────────────────────── Slots ───────────────────────── */

/** Open slots, cached for a minute so the booking page loads fast. Cleared whenever a session is booked. */
function cachedSlots_() {
  var cache = CacheService.getScriptCache(), hit = cache.get('slots_v1');
  if (hit) return JSON.parse(hit);
  applySettings_();
  var r = getSlots_();
  try { cache.put('slots_v1', JSON.stringify(r), 60); } catch (x) {}
  return r;
}

/** Time-driven, every minute: keeps the slot list fresh in the cache so the booking page gets an instant answer. */
function warmSlots() {
  applySettings_();
  var r = getSlots_();
  try { CacheService.getScriptCache().put('slots_v1', JSON.stringify(r), 90); } catch (x) {}
}

/** Run once from the editor to start the warm-up job (safe to run again – it replaces the old one). */
function installWarmup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'warmSlots') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('warmSlots').timeBased().everyMinutes(1).create();
  warmSlots();
  console.log('Warm-up job installed: available times refresh every minute.');
}

function getSlots_() {
  var tz = Session.getScriptTimeZone();
  var now = new Date();
  var earliest = new Date(now.getTime() + CONFIG.MIN_NOTICE_HOURS * 3600 * 1000);
  var rangeStart = startOfDay_(now);
  var rangeEnd = new Date(rangeStart.getTime() + (CONFIG.DAYS_AHEAD + 1) * 86400 * 1000);
  var busy = readBusy_(rangeStart, rangeEnd);
  var weekly = readAvailability_();
  var off = readTimeOff_();
  var len = CONFIG.SESSION_MINUTES * 60000;
  var step = (CONFIG.SESSION_MINUTES + CONFIG.GAP_MINUTES) * 60000;
  var days = [];

  for (var i = 0; i <= CONFIG.DAYS_AHEAD; i++) {
    var day = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate() + i);
    var key = Utilities.formatDate(day, tz, 'yyyy-MM-dd');
    var slots = [], seen = {};
    if (!off[key]) {
      (weekly[day.getDay()] || []).forEach(function (w) {
        var ws = atMinutes_(day, w[0]).getTime(), we = atMinutes_(day, w[1]).getTime();
        for (var t = ws; t + len <= we; t += step) {
          var s = new Date(t), e = new Date(t + len);
          if (seen[t] || s < earliest || overlaps_(s, e, busy)) continue;
          seen[t] = true;
          slots.push({ start: s.toISOString(), label: Utilities.formatDate(s, tz, 'h:mm a'), t: t });
        }
      });
    }
    slots.sort(function (a, b) { return a.t - b.t; }).forEach(function (x) { delete x.t; });
    days.push({
      date: key,
      weekday: Utilities.formatDate(day, tz, 'EEE'),
      day: Utilities.formatDate(day, tz, 'd'),
      month: Utilities.formatDate(day, tz, 'MMM'),
      long: Utilities.formatDate(day, tz, 'EEEE, d MMMM'),
      slots: slots
    });
  }
  return {
    ok: true,
    title: CONFIG.SESSION_TITLE,
    minutes: CONFIG.SESSION_MINUTES,
    price: CONFIG.PRICE_INR,
    upi: { id: CONFIG.UPI_ID, name: CONFIG.UPI_NAME },
    maxScreenshotMb: CONFIG.MAX_SCREENSHOT_MB,
    source: 'sheet',
    days: days
  };
}

/** Everything already on Nidhi's calendar (bookings, meetings, old booking-page appointments) is busy. */
function readBusy_(from, to) {
  var pad = CONFIG.BUFFER_MINUTES * 60000;
  var cal = CONFIG.CALENDAR_ID === 'primary'
    ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  var busy = [];
  cal.getEvents(from, to).forEach(function (ev) {
    if (ev.isAllDayEvent()) return;                             // holidays / reminders don't block
    try { if (ev.getMyStatus() === CalendarApp.GuestStatus.NO) return; } catch (x) {}
    busy.push({ s: ev.getStartTime().getTime() - pad, e: ev.getEndTime().getTime() + pad });
  });
  return busy;
}

function overlaps_(s, e, busy) {
  var a = s.getTime(), b = e.getTime();
  for (var i = 0; i < busy.length; i++) if (a < busy[i].e && b > busy[i].s) return true;
  return false;
}

/* ───────────────────────── Nidhi's sheet: Availability / Time off / Settings ───────────────────────── */

/** Returns { 0: [[fromMin, toMin], ...], 1: ..., ... } keyed by weekday (0 = Sunday). */
function readAvailability_() {
  var sh = getTab_('Availability'), out = {};
  var n = sh.getLastRow() - 1;
  if (n < 1) return out;
  sh.getRange(2, 1, n, 3).getDisplayValues().forEach(function (r) {
    var d = dayIndex_(r[0]), a = parseTime_(r[1]), b = parseTime_(r[2]);
    if (d < 0 || a == null || b == null || b <= a) return;
    (out[d] = out[d] || []).push([a, b]);
  });
  return out;
}

/** Returns { 'yyyy-MM-dd': true } for every day covered by a Time off row. */
function readTimeOff_() {
  var sh = getTab_('Time off'), out = {}, tz = Session.getScriptTimeZone();
  var n = sh.getLastRow() - 1;
  if (n < 1) return out;
  sh.getRange(2, 1, n, 2).getValues().forEach(function (r) {
    var a = toDate_(r[0]); if (!a) return;
    var b = toDate_(r[1]) || a;
    for (var d = startOfDay_(a); d <= b && d - a < 400 * 86400000; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      out[Utilities.formatDate(d, tz, 'yyyy-MM-dd')] = true;
    }
  });
  return out;
}

/** Copies the Settings tab values into CONFIG for this request. */
function applySettings_() {
  var sh = getTab_('Settings');
  var n = sh.getLastRow() - 1;
  if (n < 1) return;
  sh.getRange(2, 1, n, 2).getValues().forEach(function (r) {
    var row = SETTINGS_ROWS.filter(function (x) { return x[0] === r[0]; })[0];
    var v = Number(r[1]);
    if (row && isFinite(v) && v >= 0 && String(r[1]) !== '') CONFIG[row[1]] = v;
  });
  CONFIG.SESSION_MINUTES = Math.max(15, CONFIG.SESSION_MINUTES);
  CONFIG.DAYS_AHEAD = Math.min(Math.max(1, CONFIG.DAYS_AHEAD), 90);
}

function getTab_(name) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (sh) return sh;
  sh = ss.insertSheet(name);
  var head = function (cols, color) {
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground(color);
    sh.setFrozenRows(1);
  };
  if (name === 'Availability') {
    head(['Day', 'From', 'To'], '#E3EDD5');
    sh.getRange(2, 1, DEFAULT_AVAILABILITY.length, 3).setValues(DEFAULT_AVAILABILITY);
    sh.getRange('A2:A200').setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(DAY_NAMES.slice(1).concat(['Sunday']), true).build());
    sh.getRange('B2:C200').setNumberFormat('h:mm AM/PM');
    sh.setColumnWidths(1, 3, 130);
    sh.getRange('E1').setValue('How this works').setFontWeight('bold');
    sh.getRange('E2:E7').setValues([
      ['• One row = one block of time when Nidhi is available. A day can have several rows.'],
      ['• Sessions are offered back-to-back inside each block (session length + gap, see Settings).'],
      ['   e.g. 6:00 PM – 9:30 PM gives 6:00, 7:15 and 8:30 PM.'],
      ['• To stop offering a time, delete its row. To add hours, add a row.'],
      ['• Anything already on Nidhi\'s Google Calendar automatically blocks that time.'],
      ['• Changes appear on www.samhithe.in/booking within a minute.']
    ]);
    sh.setColumnWidth(5, 560);
  } else if (name === 'Time off') {
    head(['From date', 'To date', 'Reason (optional)'], '#F7DFD2');
    sh.getRange('A2:B200').setNumberFormat('ddd, d mmm yyyy')
      .setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build());
    sh.setColumnWidths(1, 2, 150);
    sh.setColumnWidth(3, 260);
    sh.getRange('E1').setValue('No sessions are offered on these dates. Leave "To date" empty for a single day. Double-click a cell to pick a date.');
  } else if (name === 'Intake') {
    head(INTAKE_FIXED, '#E3EDD5');
  } else if (name === 'School enquiries') {
    head(SCHOOL_HEADERS, '#EDE6F5');
    sh.getRange(2, SCHOOL_HEADERS.length, 999, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(['New', 'Called', 'Follow up', 'Closed'], true).build());
  } else if (name === 'Settings') {
    head(['Setting', 'Value', 'What it does'], '#EDE6F5');
    sh.getRange(2, 1, SETTINGS_ROWS.length, 3).setValues(SETTINGS_ROWS.map(function (r) {
      return [r[0], CONFIG[r[1]], r[2]];
    }));
    sh.setColumnWidth(1, 240);
    sh.setColumnWidth(3, 340);
  }
  return sh;
}

/* ───────────────────────── Booking ───────────────────────── */

function book_(b) {
  if (b.website) return { ok: true, message: 'Thank you.' };      // honeypot: silently ignore bots

  var f = {
    start: String(b.start || ''),
    childName: clean_(b.childName, 80),
    childAge: clean_(b.childAge, 20),
    parentName: clean_(b.parentName, 80),
    email: clean_(b.email, 120).toLowerCase(),
    phone: String(b.phone || '').replace(/[^\d+]/g, '').slice(0, 15),
    payerUpi: clean_(b.payerUpi, 80),
    notes: clean_(b.notes, 1000)
  };
  var err = validate_(f, b.screenshot);
  if (err) return { ok: false, message: err };

  // First-time parents must send the intake; returning parents must already have one on file.
  var who = b.who === 'returning' ? 'returning' : 'new';
  var intake = (Array.isArray(b.intake) ? b.intake : []).filter(function (x) { return Array.isArray(x) && x[0]; })
    .slice(0, 60).map(function (x) {
      return [clean_(x[0], 300), clean_(x[1], 3000), clean_(x[2], 40),
        Array.isArray(x[3]) ? x[3].slice(0, 30).map(function (v) { return clean_(v, 300); }) : null];
    });
  if (who === 'returning' && !hasIntake_(f.email, f.phone)) {
    return { ok: false, code: 'NEED_INTAKE', message: "We couldn't find your earlier intake form with this email and phone number. Please fill in the short form about your child below." };
  }
  if (who === 'new' && intake.length < 10) {
    return { ok: false, code: 'NEED_INTAKE', message: 'Please fill in the details about your child before booking.' };
  }

  var key = 'rl_' + f.email + '_' + f.phone, cache = CacheService.getScriptCache();
  var count = Number(cache.get(key) || 0);
  if (count >= 3) return { ok: false, message: 'Too many booking attempts. Please WhatsApp Nidhi and she will help you.' };
  cache.put(key, String(count + 1), 3600);

  var start = new Date(f.start), end = new Date(start.getTime() + CONFIG.SESSION_MINUTES * 60000);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var open = getSlots_().days.some(function (d) {
      return d.slots.some(function (s) { return s.start === start.toISOString(); });
    });
    if (!open) return { ok: false, code: 'SLOT_TAKEN', message: 'Sorry, that time was just booked. Please choose another slot.' };

    var tz = Session.getScriptTimeZone();
    var when = Utilities.formatDate(start, tz, "EEEE, d MMMM yyyy 'at' h:mm a");
    var file = saveScreenshot_(b.screenshot, f, start);

    var description = [
      'Parent consultation booked via samhithe.in',
      '',
      'Child: ' + f.childName + ' (age ' + f.childAge + ')',
      'Parent: ' + f.parentName,
      'Phone: ' + f.phone,
      'Email: ' + f.email,
      f.notes ? 'Notes: ' + f.notes : '',
      '',
      'Fee: ₹' + CONFIG.PRICE_INR + ' by UPI' + (f.payerUpi ? ' (paid from ' + f.payerUpi + ')' : ''),
      'To reschedule, reply to the confirmation email or WhatsApp Nidhi.'
    ].filter(function (l, i, a) { return l !== '' || a[i - 1] !== ''; }).join('\n');

    var event = Calendar.Events.insert({
      summary: CONFIG.SESSION_TITLE + ' – ' + f.childName,
      description: description,
      start: { dateTime: start.toISOString(), timeZone: tz },
      end: { dateTime: end.toISOString(), timeZone: tz },
      attendees: [{ email: f.email, displayName: f.parentName }],
      guestsCanSeeOtherGuests: false,
      reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 24 * 60 }, { method: 'popup', minutes: 30 }] },
      conferenceData: { createRequest: { requestId: Utilities.getUuid(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      extendedProperties: { private: { source: 'samhithe-booking', screenshot: file.getUrl() } }
    }, CONFIG.CALENDAR_ID, { conferenceDataVersion: 1, sendUpdates: 'all' });

    var meet = event.hangoutLink || '';
    getSheet_().appendRow([new Date(), start, end, f.childName, f.childAge, f.parentName, f.email,
      "'" + f.phone, f.payerUpi, f.notes, file.getUrl(), meet, event.id, 'To verify']);

    if (intake.length) { saveIntake_(f, start, intake); submitToForm_(f, intake); }

    try { CacheService.getScriptCache().remove('slots_v1'); } catch (x) {}

    sendParentEmail_(f, when, meet);
    sendNidhiEmail_(f, when, meet, file, intake, who);

    return { ok: true, when: when, meetLink: meet, email: f.email,
      message: 'Your session is booked for ' + when + '.' };
  } finally {
    lock.releaseLock();
  }
}

function validate_(f, shot) {
  if (!f.start || isNaN(new Date(f.start).getTime())) return 'Please choose a date and time.';
  if (!f.childName) return "Please enter your child's name.";
  if (!f.childAge) return "Please enter your child's age.";
  if (!f.parentName) return 'Please enter your name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email)) return 'Please enter a valid email address — your Meet link is sent there.';
  if (f.phone.replace(/\D/g, '').length < 10) return 'Please enter a valid phone number.';
  if (!shot || !shot.data) return 'Please upload the screenshot of your payment.';
  if (!/^(image\/(png|jpe?g|webp|heic|heif)|application\/pdf)$/i.test(shot.type || '')) return 'The payment screenshot must be an image (JPG, PNG) or PDF.';
  if (shot.data.length * 0.75 > CONFIG.MAX_SCREENSHOT_MB * 1024 * 1024) return 'The screenshot is too large. Please upload one under ' + CONFIG.MAX_SCREENSHOT_MB + ' MB.';
  return '';
}

function saveScreenshot_(shot, f, start) {
  var ext = (shot.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  var name = Utilities.formatDate(start, Session.getScriptTimeZone(), 'yyyy-MM-dd HHmm') +
    ' – ' + f.parentName + ' – ' + f.childName + '.' + ext;
  var blob = Utilities.newBlob(Utilities.base64Decode(shot.data), shot.type, name);
  return getFolder_().createFile(blob);       // private to Nidhi's Drive
}

/* ───────────────────────── Emails ───────────────────────── */

function sendParentEmail_(f, when, meet) {
  var btn = meet
    ? '<p style="margin:24px 0"><a href="' + meet + '" style="background:#CB5521;color:#fff;padding:13px 24px;border-radius:999px;text-decoration:none;font-weight:600">Join on Google Meet</a></p><p style="color:#6A5F57;font-size:14px">Meet link: <a href="' + meet + '" style="color:#CB5521">' + meet + '</a></p>'
    : '<p>Your Google Meet link is in the calendar invite sent to this email.</p>';
  MailApp.sendEmail({
    to: f.email,
    replyTo: notifyEmail_(),
    name: 'Samhithe – Nidhi Rao',
    subject: 'Your session with Nidhi is booked – ' + when,
    htmlBody: wrap_(
      '<h2 style="font-family:Georgia,serif;font-weight:400;font-size:26px;margin:0 0 14px">You\'re booked, ' + esc_(f.parentName.split(' ')[0]) + '.</h2>' +
      '<p>Thank you for booking a parent consultation for <b>' + esc_(f.childName) + '</b>.</p>' +
      '<table style="margin:18px 0;border-collapse:collapse;font-size:15px">' +
      row_('When', when + ' (India time)') + row_('Length', CONFIG.SESSION_MINUTES + ' minutes, online') +
      row_('Fee', '₹' + CONFIG.PRICE_INR + ' – payment received, Nidhi will verify it') + '</table>' + btn +
      '<p>A calendar invite has also been sent to this email. To reschedule, simply reply to this email.</p>' +
      '<p style="margin-top:22px">See you soon,<br>Nidhi</p>')
  });
}

function sendNidhiEmail_(f, when, meet, file, intake, who) {
  var intakeHtml = intake && intake.length
    ? '<h3 style="margin:26px 0 8px">Intake (first session)</h3><table style="border-collapse:collapse;font-size:14px">' +
      intake.map(function (qa) { return row_(qa[0], qa[1] || '—'); }).join('') + '</table>'
    : '<p style="color:#6A5F57">Returning parent – intake already on file (see the Intake tab or the Google Form responses).</p>';
  MailApp.sendEmail({
    to: notifyEmail_(),
    replyTo: f.email,
    subject: 'New booking' + (who === 'returning' ? ' (returning)' : '') + ': ' + f.childName + ' (' + f.parentName + ') – ' + when,
    htmlBody: wrap_(
      '<h3 style="margin:0 0 12px">New session booked</h3><table style="border-collapse:collapse;font-size:15px">' +
      row_('When', when) + row_('Child', f.childName + ', age ' + f.childAge) + row_('Parent', f.parentName) +
      row_('Phone', f.phone) + row_('Email', f.email) + row_('Paid from', f.payerUpi || '—') +
      row_('Notes', f.notes || '—') + row_('Meet', meet || '—') + '</table>' +
      '<p><a href="' + file.getUrl() + '" style="color:#CB5521;font-weight:600">View payment screenshot</a> (attached too). ' +
      'Please check the ₹' + CONFIG.PRICE_INR + ' credit and mark "Payment Status" as Verified in the bookings sheet.</p>' + intakeHtml),
    attachments: [file.getBlob()]
  });
}

function wrap_(inner) {
  return '<div style="background:#FDF8F5;padding:28px 16px;font-family:Helvetica,Arial,sans-serif;color:#2B2622;line-height:1.6">' +
    '<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #EADFD4;border-radius:18px;padding:30px">' +
    '<div style="color:#CB5521;font-family:Georgia,serif;font-size:20px;margin-bottom:18px">Samhithe <span style="color:#4D7A2E;font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:.18em">CHILD AND FAMILY WELLNESS</span></div>' +
    inner + '</div></div>';
}
function row_(k, v) {
  return '<tr><td style="padding:5px 18px 5px 0;color:#6A5F57;vertical-align:top">' + k + '</td><td style="padding:5px 0">' + esc_(v) + '</td></tr>';
}

/* ───────────────────────── Intake: returning parents & storage ───────────────────────── */

function phoneKey_(p) { return String(p || '').replace(/\D/g, '').slice(-10); }

/** Returning-parent check. Both the email AND the phone must match the same earlier intake. */
function lookup_(b) {
  var email = clean_(b.email, 120).toLowerCase(), phone = phoneKey_(b.phone);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || phone.length < 10) {
    return { ok: false, message: 'Please enter the email and phone number you used before.' };
  }
  var cache = CacheService.getScriptCache(), key = 'lk_' + email, count = Number(cache.get(key) || 0);
  if (count >= 6) return { ok: false, message: 'Too many attempts. Please WhatsApp Nidhi and she will help you.' };
  cache.put(key, String(count + 1), 3600);
  var m = intakeMatch_(email, phone);
  return { ok: true, found: m.both, any: m.any };
}

function hasIntake_(email, phone) { return intakeMatch_(email, phone).both; }

/** Earlier intake on file (website Intake tab + Nidhi's Google Form)? both = email AND phone match one entry; any = either matches. */
function intakeMatch_(email, phone) {
  var e = String(email || '').trim().toLowerCase(), p = phoneKey_(phone), out = { both: false, any: false };
  if (!e && p.length < 10) return out;
  intakeKeys_().some(function (k) {
    var me = !!e && k[0] === e, mp = p.length >= 10 && k[1] === p;
    if (me || mp) out.any = true;
    if (me && mp) out.both = true;
    return out.both;
  });
  return out;
}

/** [[email, last-10-digit phone], ...] from the Intake tab and the Google Form responses. */
function intakeKeys_() {
  var list = [];
  var sh = getTab_('Intake'), n = sh.getLastRow() - 1;
  if (n > 0) sh.getRange(2, 3, n, 2).getDisplayValues().forEach(function (r) { list.push([String(r[0]).trim().toLowerCase(), phoneKey_(r[1])]); });
  try {
    var cache = CacheService.getScriptCache(), keys = cache.get('form_intake_keys');
    if (keys == null) {
      var form = getIntakeForm_(), fl = [];
      if (form) form.getResponses().forEach(function (r) {
        var em = '', ph = '';
        try { em = String(r.getRespondentEmail() || ''); } catch (x) {}
        r.getItemResponses().forEach(function (ir) {
          var t = ir.getItem().getTitle().toLowerCase(), v = String(ir.getResponse() || '');
          if (t.indexOf('email') >= 0) em = v;
          else if (t.indexOf('contact') >= 0 || t.indexOf('phone') >= 0) ph = v;
        });
        fl.push(em.trim().toLowerCase() + '|' + phoneKey_(ph));
      });
      keys = fl.join('\n');
      cache.put('form_intake_keys', keys.slice(0, 90000), 300);
    }
    keys.split('\n').forEach(function (k) { if (k) { var a = k.split('|'); list.push([a[0], a[1] || '']); } });
  } catch (x) { console.warn('Intake form check skipped: ' + x); }
  return list;
}

function getIntakeForm_() {
  var props = PropertiesService.getScriptProperties(), id = CONFIG.INTAKE_FORM_ID || props.getProperty('INTAKE_FORM_ID');
  if (id) { try { return FormApp.openById(id); } catch (x) { console.warn('Could not open intake form ' + id + ': ' + x); } }
  var it = DriveApp.searchFiles("mimeType = 'application/vnd.google-apps.form' and title contains 'Intake' and trashed = false");
  while (it.hasNext()) {
    var fid = it.next().getId();
    try { var form = FormApp.openById(fid); props.setProperty('INTAKE_FORM_ID', fid); return form; } catch (x) {}
  }
  return null;
}

function saveIntake_(f, start, intake) {
  var sh = getTab_('Intake');
  var head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), INTAKE_FIXED.length)).getValues()[0].map(String);
  var row = [new Date(), f.parentName, f.email, "'" + f.phone, f.childName, f.childAge, start];
  intake.forEach(function (qa) {
    var c = head.indexOf(qa[0]);
    if (c < 0) {
      head.push(qa[0]); c = head.length - 1;
      sh.getRange(1, c + 1).setValue(qa[0]).setFontWeight('bold').setBackground('#E3EDD5').setWrap(true);
    }
    row[c] = qa[1];
  });
  for (var i = 0; i < head.length; i++) if (row[i] === undefined) row[i] = '';
  sh.appendRow(row);
  try { CacheService.getScriptCache().remove('form_intake_keys'); } catch (x) {}
}

/** Also records the website intake as a response in Nidhi's Google Form, so every intake is in one place. */
var FORM_KEYS = {
  parentName: 'parent/guardian name', relationship: 'relationship to child', phone: 'contact number', email: 'email address',
  childName: "child's name", dob: "child's date of birth", gender: "child's gender", livesWith: 'who does the child currently live',
  languages: 'please mention the languages', siblings: 'are there other children', goingWell: 'how would you describe your child when',
  strengths: "what are your child's strengths", school: 'what school does your child', schoolOverall: 'how is your child doing at school',
  schoolConcerns: "has your child's school raised", mainReason: 'in your own words', howLong: 'how long have you been noticing',
  behaviours: 'which of the following behavio', where: 'where does the behavio', tried: 'what strategies or approaches',
  worked: 'what has worked', worse: 'what has made things worse', diagnosis: 'has your child ever been assessed',
  medication: 'is your child currently on any medication', events: 'has there been any significant event',
  sleep: "how would you describe your child's sleep", eating: "how would you describe your child's eating", anythingElse: 'is there anything else'
};
function submitToForm_(f, intake) {
  try {
    var form = getIntakeForm_(); if (!form) return;
    var vals = { parentName: f.parentName, phone: f.phone, email: f.email, childName: f.childName };
    intake.forEach(function (x) { if (x[2]) vals[x[2]] = x[3] && x[3].length ? x[3] : x[1]; });
    var norm = function (t) { return String(t || '').toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim(); };
    var resp = form.createResponse(), added = 0;
    form.getItems().forEach(function (item) {
      var title = norm(item.getTitle()), key = null;
      for (var k in FORM_KEYS) if (title.indexOf(FORM_KEYS[k]) === 0) { key = k; break; }
      var v = key && vals[key];
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
      try {
        var T = FormApp.ItemType, t = item.getType();
        if (t === T.TEXT) resp.withItemResponse(item.asTextItem().createResponse(String(v)));
        else if (t === T.PARAGRAPH_TEXT) resp.withItemResponse(item.asParagraphTextItem().createResponse(String(v)));
        else if (t === T.MULTIPLE_CHOICE) resp.withItemResponse(item.asMultipleChoiceItem().createResponse(Array.isArray(v) ? v[0] : String(v)));
        else if (t === T.CHECKBOX) resp.withItemResponse(item.asCheckboxItem().createResponse(Array.isArray(v) ? v : [String(v)]));
        else if (t === T.LIST) resp.withItemResponse(item.asListItem().createResponse(Array.isArray(v) ? v[0] : String(v)));
        else if (t === T.DATE) {
          var d = String(v).split('-');
          if (d.length !== 3) return;
          resp.withItemResponse(item.asDateItem().createResponse(new Date(+d[0], +d[1] - 1, +d[2])));
        } else return;
        added++;
      } catch (x) { console.warn('Form item skipped (' + item.getTitle() + '): ' + x); }
    });
    if (added) resp.submit();
    try { CacheService.getScriptCache().remove('form_intake_keys'); } catch (x) {}
  } catch (x) { console.warn('Could not add the intake to the Google Form: ' + x); }
}

/* ───────────────────────── Preschools / schools: call-back requests ───────────────────────── */

function callback_(b) {
  if (b.website) return { ok: true };
  var c = {
    school: clean_(b.school, 120), name: clean_(b.name, 80), role: clean_(b.role, 80),
    phone: String(b.phone || '').replace(/[^\d+]/g, '').slice(0, 15), email: clean_(b.email, 120).toLowerCase(),
    city: clean_(b.city, 80), kids: clean_(b.kids, 120),
    interests: clean_([].concat(b.interests || []).join(', '), 300), time: clean_(b.time, 40), message: clean_(b.message, 1500)
  };
  if (!c.school) return { ok: false, message: 'Please enter the name of your school.' };
  if (!c.name) return { ok: false, message: 'Please enter your name.' };
  if (c.phone.replace(/\D/g, '').length < 10) return { ok: false, message: 'Please enter a valid phone number so Nidhi can call you.' };
  if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.email)) return { ok: false, message: 'Please check the email address.' };
  var cache = CacheService.getScriptCache(), key = 'cb_' + phoneKey_(c.phone), count = Number(cache.get(key) || 0);
  if (count >= 3) return { ok: false, message: 'We already have your request. Nidhi will call you soon.' };
  cache.put(key, String(count + 1), 3600);

  getTab_('School enquiries').appendRow([new Date(), c.school, c.name, c.role, "'" + c.phone, c.email, c.city,
    c.kids, c.interests, c.time, c.message, 'New']);
  var mail = {
    to: notifyEmail_(),
    subject: 'Call back request: ' + c.school + ' (' + c.name + ')',
    htmlBody: wrap_('<h3 style="margin:0 0 12px">School / preschool call back request</h3><table style="border-collapse:collapse;font-size:15px">' +
      row_('School', c.school) + row_('Contact', c.name + (c.role ? ', ' + c.role : '')) + row_('Phone', c.phone) +
      row_('Email', c.email || '—') + row_('Area / city', c.city || '—') + row_('Children & ages', c.kids || '—') +
      row_('Interested in', c.interests || '—') + row_('Best time to call', c.time || '—') + row_('Message', c.message || '—') +
      '</table><p>Saved in the "School enquiries" tab of the bookings sheet.</p>')
  };
  if (c.email) mail.replyTo = c.email;
  MailApp.sendEmail(mail);
  return { ok: true };
}

/* ───────────────────────── Storage ───────────────────────── */

/** Nidhi's bookings & availability spreadsheet, opened once per request. */
var SS_ = null;
function ss_() {
  if (SS_) return SS_;
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('SHEET_ID');
  if (id) { try { SS_ = SpreadsheetApp.openById(id); } catch (x) { SS_ = null; } }
  if (!SS_) { SS_ = SpreadsheetApp.create(CONFIG.SHEET_NAME); props.setProperty('SHEET_ID', SS_.getId()); }
  return SS_;
}

/** The "Bookings" tab. */
function getSheet_() {
  var ss = ss_();
  var sh = ss.getSheetByName('Bookings') || ss.getSheets()[0];
  if (sh.getLastRow() === 0) {
    sh.setName('Bookings');
    sh.appendRow(BOOKING_HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, BOOKING_HEADERS.length).setFontWeight('bold').setBackground('#F7DFD2');
    var rule = SpreadsheetApp.newDataValidation().requireValueInList(['To verify', 'Verified', 'Problem'], true).build();
    sh.getRange(2, BOOKING_HEADERS.length, 999, 1).setDataValidation(rule);
  }
  return sh;
}

function getFolder_() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (x) {} }
  var folder = DriveApp.createFolder(CONFIG.FOLDER_NAME);
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

/** Run from the editor: creates/updates the sheet tabs and Drive folder, checks the calendar. */
function setup() {
  ScriptApp.requireScopes(ScriptApp.AuthMode.FULL, ['https://www.googleapis.com/auth/forms']);
  var sh = getSheet_(), ss = sh.getParent(), folder = getFolder_();
  ss.rename(CONFIG.SHEET_NAME);
  ['Availability', 'Time off', 'Settings', 'Intake', 'School enquiries'].forEach(getTab_);
  var note = getTab_('Availability').getRange('E7');
  if (/straight away/.test(note.getValue())) note.setValue('• Changes appear on www.samhithe.in/booking within a minute.');
  var form = getIntakeForm_();
  console.log('Original intake Google Form: ' + (form ? form.getTitle() + ' (' + form.getResponses().length + ' responses, used for returning parents)' : 'not found in this account'));
  Calendar.Calendars.get(CONFIG.CALENDAR_ID);              // confirms the Calendar advanced service is on
  applySettings_();
  var r = getSlots_();
  var open = r.days.reduce(function (n, d) { return n + d.slots.length; }, 0);
  console.log('Bookings & availability sheet: ' + ss.getUrl());
  console.log('Screenshots folder: ' + folder.getUrl());
  console.log('Open slots in the next ' + CONFIG.DAYS_AHEAD + ' days: ' + open);
}

/* ───────────────────────── Helpers ───────────────────────── */

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function clean_(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function esc_(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function notifyEmail_() { return CONFIG.NOTIFY_EMAIL || Session.getEffectiveUser().getEmail(); }
function startOfDay_(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function atMinutes_(day, mins) { return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(mins / 60), mins % 60); }
function dayIndex_(s) {
  var k = String(s || '').trim().slice(0, 3).toLowerCase();
  for (var i = 0; i < 7; i++) if (DAY_NAMES[i].slice(0, 3).toLowerCase() === k) return i;
  return -1;
}
/** "6:00 PM", "6 pm", "18:00", "18.30" → minutes after midnight (null if unreadable). */
function parseTime_(s) {
  var m = String(s || '').trim().toLowerCase().replace(/\./g, ':').match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?$/);
  if (!m) return null;
  var h = +m[1], min = +(m[2] || 0);
  if (m[3]) { h = h % 12 + (m[3] === 'pm' ? 12 : 0); }
  if (h > 24 || min > 59) return null;
  return Math.min(h * 60 + min, 24 * 60);
}
function toDate_(v) {
  if (v instanceof Date && !isNaN(v)) return v;
  if (!v) return null;
  var d = new Date(v);
  return isNaN(d) ? null : d;
}
