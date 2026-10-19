/**
 * Samhithe – Session booking backend (Google Apps Script)
 *
 * Powers www.samhithe.in/booking:
 *   GET  ?action=slots  → open 60-minute slots, date-wise, read from Nidhi's Google Calendar
 *   POST {action:"book"} → saves the payment screenshot to Drive, books the calendar event
 *                          with a Google Meet link, logs it in a Sheet and emails both sides.
 * A slot is booked ONLY when the form arrives with a payment screenshot.
 *
 * SETUP (once, signed in as nidhi@samhithe.in) — full steps in apps-script/booking/SETUP.md
 * 1. script.google.com → New project → name it "Samhithe Booking".
 * 2. Paste this file into Code.gs. Project Settings → tick "Show appsscript.json" → paste appsscript.json.
 * 3. Edit CONFIG below (UPI ID, hours). Select `setup` in the toolbar → Run → allow access.
 * 4. Deploy → New deployment → Web app → Execute as: Me → Who has access: Anyone → Deploy.
 * 5. Copy the /exec URL into BOOKING_API in booking/index.html on the website.
 * After any later code change: Deploy → Manage deployments → ✏️ → Version: New version → Deploy
 * (keeps the same URL).
 */

var CONFIG = {
  SESSION_TITLE: 'Parent Consultation with Nidhi',
  SESSION_MINUTES: 60,
  PRICE_INR: 1000,

  // Payment details shown on the booking page and used by the PhonePe / Google Pay buttons
  UPI_ID: 'nidhirao.1997-2@okaxis',
  UPI_NAME: 'Nidhi Rao',               // name shown in the UPI app

  // WHERE SLOTS COME FROM
  // Nidhi's calendar is checked for time blocks titled AVAILABILITY_TITLE (the "Session with Nidhi"
  // booking-page hours, or blocks she adds herself, recurring is fine). Slots are offered only inside
  // those blocks. If none exist in the booking window, the weekly HOURS below are used instead.
  AVAILABILITY_TITLE: 'Session with Nidhi',

  // Fallback bookable hours per weekday (0 = Sunday … 6 = Saturday). Times in India time, 24-hour.
  // A day can have several windows, e.g. [['10:00','13:00'], ['15:00','18:00']].
  HOURS: {
    0: [],
    1: [['10:00', '18:00']],
    2: [['10:00', '18:00']],
    3: [['10:00', '18:00']],
    4: [['10:00', '18:00']],
    5: [['10:00', '18:00']],
    6: [['10:00', '18:00']]
  },
  MIN_NOTICE_HOURS: 12,                // earliest bookable slot from now
  DAYS_AHEAD: 21,                      // how far ahead parents can book
  BUFFER_MINUTES: 0,                   // gap kept free around other calendar events

  CALENDAR_ID: 'primary',              // Nidhi's main calendar
  NOTIFY_EMAIL: '',                    // where new-booking alerts go; empty = the script owner
  MAX_SCREENSHOT_MB: 8,
  SHEET_NAME: 'Samhithe – Session Bookings',
  FOLDER_NAME: 'Samhithe – Payment Screenshots'
};

var BOOKING_HEADERS = ['Booked At', 'Session Start', 'Session End', 'Child Name', 'Child Age',
  'Parent Name', 'Email', 'Phone', 'Paid From UPI', 'Notes', 'Screenshot', 'Meet Link',
  'Calendar Event ID', 'Payment Status'];

/* ───────────────────────── Web endpoints ───────────────────────── */

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  try {
    if (action === 'slots') return json_(getSlots_());
    return json_({ ok: true, service: 'Samhithe booking' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, message: 'Could not load available times. Please try again shortly.' });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action === 'book') return json_(book_(body));
    return json_({ ok: false, message: 'Unknown request.' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, message: 'Something went wrong while booking. Please try again, or WhatsApp Nidhi.' });
  }
}

/* ───────────────────────── Slots ───────────────────────── */

function getSlots_() {
  var now = new Date();
  var earliest = new Date(now.getTime() + CONFIG.MIN_NOTICE_HOURS * 3600 * 1000);
  var rangeStart = startOfDay_(now);
  var rangeEnd = new Date(rangeStart.getTime() + (CONFIG.DAYS_AHEAD + 1) * 86400 * 1000);
  var cal = readCalendar_(rangeStart, rangeEnd);
  var useBlocks = cal.windows.length > 0;
  var tz = Session.getScriptTimeZone();
  var step = CONFIG.SESSION_MINUTES * 60000;
  var days = [];

  for (var i = 0; i <= CONFIG.DAYS_AHEAD; i++) {
    var day = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate() + i);
    var dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    var windows = useBlocks
      ? cal.windows.filter(function (w) { return w.s < dayEnd.getTime() && w.e > day.getTime(); })
          .map(function (w) { return { s: Math.max(w.s, day.getTime()), e: Math.min(w.e, dayEnd.getTime()) }; })
      : (CONFIG.HOURS[day.getDay()] || []).map(function (w) {
          return { s: atTime_(day, w[0]).getTime(), e: atTime_(day, w[1]).getTime() };
        });
    var seen = {}, slots = [];
    windows.forEach(function (w) {
      for (var t = w.s; t + step <= w.e; t += step) {
        var s = new Date(t), e = new Date(t + step);
        if (seen[t] || s < earliest || overlaps_(s, e, cal.busy)) continue;
        seen[t] = true;
        slots.push({ start: s.toISOString(), label: Utilities.formatDate(s, tz, 'h:mm a'), t: t });
      }
    });
    slots.sort(function (a, b) { return a.t - b.t; }).forEach(function (x) { delete x.t; });
    days.push({
      date: Utilities.formatDate(day, tz, 'yyyy-MM-dd'),
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
    source: useBlocks ? 'calendar' : 'hours',
    days: days
  };
}

/** Splits Nidhi's calendar into availability blocks ("Session with Nidhi") and busy time (everything else). */
function readCalendar_(from, to) {
  var pad = CONFIG.BUFFER_MINUTES * 60000;
  var title = String(CONFIG.AVAILABILITY_TITLE || '').trim().toLowerCase();
  var cal = CONFIG.CALENDAR_ID === 'primary'
    ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  var windows = [], busy = [];
  cal.getEvents(from, to).forEach(function (ev) {
    var s = ev.getStartTime().getTime(), e = ev.getEndTime().getTime();
    if (title && String(ev.getTitle()).trim().toLowerCase() === title) { windows.push({ s: s, e: e }); return; }
    if (ev.isAllDayEvent()) return;                             // holidays / reminders don't block
    try { if (ev.getMyStatus() === CalendarApp.GuestStatus.NO) return; } catch (x) {}
    busy.push({ s: s - pad, e: e + pad });
  });
  return { windows: windows, busy: busy };
}

function overlaps_(s, e, busy) {
  var a = s.getTime(), b = e.getTime();
  for (var i = 0; i < busy.length; i++) if (a < busy[i].e && b > busy[i].s) return true;
  return false;
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

    sendParentEmail_(f, when, meet);
    sendNidhiEmail_(f, when, meet, file);

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

function sendNidhiEmail_(f, when, meet, file) {
  MailApp.sendEmail({
    to: notifyEmail_(),
    replyTo: f.email,
    subject: 'New booking: ' + f.childName + ' (' + f.parentName + ') – ' + when,
    htmlBody: wrap_(
      '<h3 style="margin:0 0 12px">New session booked</h3><table style="border-collapse:collapse;font-size:15px">' +
      row_('When', when) + row_('Child', f.childName + ', age ' + f.childAge) + row_('Parent', f.parentName) +
      row_('Phone', f.phone) + row_('Email', f.email) + row_('Paid from', f.payerUpi || '—') +
      row_('Notes', f.notes || '—') + row_('Meet', meet || '—') + '</table>' +
      '<p><a href="' + file.getUrl() + '" style="color:#CB5521;font-weight:600">View payment screenshot</a> (attached too). ' +
      'Please check the ₹' + CONFIG.PRICE_INR + ' credit and mark "Payment Status" as Verified in the bookings sheet.</p>'),
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

/* ───────────────────────── Storage ───────────────────────── */

function getSheet_() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('SHEET_ID'), ss;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (x) { ss = null; } }
  if (!ss) { ss = SpreadsheetApp.create(CONFIG.SHEET_NAME); props.setProperty('SHEET_ID', ss.getId()); }
  var sh = ss.getSheets()[0];
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

/** Run once from the editor: grants permissions, creates the Sheet and Drive folder, checks the calendar. */
function setup() {
  var sh = getSheet_(), folder = getFolder_();
  Calendar.Calendars.get(CONFIG.CALENDAR_ID);              // confirms the Calendar advanced service is on
  var open = getSlots_().days.reduce(function (n, d) { return n + d.slots.length; }, 0);
  console.log('Bookings sheet: ' + sh.getParent().getUrl());
  console.log('Screenshots folder: ' + folder.getUrl());
  var r = getSlots_();
  console.log('Open slots in the next ' + CONFIG.DAYS_AHEAD + ' days: ' + open + (r.source === 'calendar'
    ? ' (from "' + CONFIG.AVAILABILITY_TITLE + '" blocks on the calendar)' : ' (from the weekly HOURS – no "' + CONFIG.AVAILABILITY_TITLE + '" blocks found)'));
  if (!CONFIG.UPI_ID) console.warn('Fill in CONFIG.UPI_ID so the PhonePe / Google Pay buttons work.');
}

/* ───────────────────────── Helpers ───────────────────────── */

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function clean_(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function esc_(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function notifyEmail_() { return CONFIG.NOTIFY_EMAIL || Session.getEffectiveUser().getEmail(); }
function startOfDay_(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function atTime_(day, hhmm) { var p = hhmm.split(':'); return new Date(day.getFullYear(), day.getMonth(), day.getDate(), +p[0], +p[1]); }
