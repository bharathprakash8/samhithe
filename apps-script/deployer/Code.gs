/**
 * Samhithe Deployer – keeps Nidhi's Apps Script backends in sync with GitHub, so no laptop is needed.
 *
 * Every 5 minutes it downloads each backend's Code.gs + appsscript.json from the main branch. When the content has
 * changed it checks the code parses, updates the Apps Script project,
 * creates a new version (named after the latest commit title) and points the existing web-app deployment at it.
 * Web-app URLs never change. Runs as nidhi@samhithe.in; no passwords, keys or tokens are stored anywhere.
 *
 * doGet() is a public status page (no personal data) read by the GitHub health check.
 * Setup: run setup() once from the editor (it installs the 5-minute trigger). Needs "Google Apps Script API"
 * switched on at https://script.google.com/home/usersettings.
 */

var REPO = 'bharathprakash8/samhithe', BRANCH = 'main';
var TARGETS = [
  { name: 'admin', path: 'apps-script/admin', scriptId: '1E04ByI_ODgtkHqUoqnwyAmn_PxUs_Bh0_4M6YEwpw4sabakhwJJWzIx8',
    deploymentId: 'AKfycbzHIlWBg_k_9V4DE3zYat7ltuOKWCysWc083ZGYLuuhh0L6g94lFztofkKt-GYrJiIM' },
  { name: 'booking', path: 'apps-script/booking', scriptId: '1Zh3s4h18SBgAuk03JRTwdbw1nDxu37KoEM7H_q7HK1J0MgRQPeGfwPF8',
    deploymentId: 'AKfycbzw67eOs-JR0uudjn1Yu_Z9pp0Zy5-k7r59Glr8W9PoYSTGnGGId2N3mtlUqFlnoMc2' }
];

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'check') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('check').timeBased().everyMinutes(5).create();
  check();
  console.log(JSON.stringify(status_(), null, 2));
}

/** Runs every 5 minutes. */
function check() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return;
  try { TARGETS.forEach(function (t) { try { sync_(t); } catch (e) { record_(t.name, { error: String(e.message || e).slice(0, 300) }); } }); }
  finally { lock.releaseLock(); }
}

function sync_(t) {
  // Read the files straight from the branch (GitHub's API rate-limits Google's shared servers).
  var code = raw_(BRANCH, t.path + '/Code.gs'), manifest = raw_(BRANCH, t.path + '/appsscript.json');
  var hash = sha_(code + '\u0000' + manifest);
  var st = state_()[t.name] || {};
  if (st.hash === hash && !st.error) return;                       // already deployed
  if (st.failedHash === hash) return;                              // this content failed before – wait for a fix

  try { new Function(code); } catch (e) { record_(t.name, { failedHash: hash, error: 'Code.gs does not parse: ' + e.message }); return; }
  try { JSON.parse(manifest); } catch (e) { record_(t.name, { failedHash: hash, error: 'appsscript.json is not valid JSON' }); return; }

  var desc = (title_(t.path) || 'Auto-deploy ' + hash.slice(0, 8)).slice(0, 95);
  var content = api_('get', 'projects/' + t.scriptId + '/content');
  var files = (content.files || []).filter(function (f) { return f.name !== 'Code' && f.name !== 'appsscript'; });
  var cur = (content.files || []).reduce(function (m, f) { m[f.name] = f.source; return m; }, {});
  if (cur.Code === code && JSON.stringify(JSON.parse(cur.appsscript || '{}')) === JSON.stringify(JSON.parse(manifest))) {
    record_(t.name, { hash: hash, note: 'already live', error: '', failedHash: '' }); return;   // nothing new to ship
  }
  files.unshift({ name: 'appsscript', type: 'JSON', source: manifest }, { name: 'Code', type: 'SERVER_JS', source: code });
  api_('put', 'projects/' + t.scriptId + '/content', { scriptId: t.scriptId, files: files });
  var v = api_('post', 'projects/' + t.scriptId + '/versions', { description: desc });
  api_('put', 'projects/' + t.scriptId + '/deployments/' + t.deploymentId,
    { deploymentConfig: { scriptId: t.scriptId, versionNumber: v.versionNumber, manifestFileName: 'appsscript', description: desc } });
  record_(t.name, { hash: hash, version: v.versionNumber, description: desc, deployedAt: new Date().toISOString(), note: '', error: '', failedHash: '' });
}

/** Title of the latest commit touching the folder, from GitHub's public Atom feed (best effort). */
function title_(path) {
  try {
    var r = UrlFetchApp.fetch('https://github.com/' + REPO + '/commits/' + BRANCH + '/' + path + '.atom', { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) return '';
    var m = r.getContentText().match(/<entry>[\s\S]*?<title>\s*([\s\S]*?)\s*<\/title>/);
    return m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").split('\n')[0] : '';
  } catch (e) { return ''; }
}
function sha_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

/* ── helpers ── */
function raw_(ref, path) {
  var r = UrlFetchApp.fetch('https://raw.githubusercontent.com/' + REPO + '/' + ref + '/' + path + '?t=' + Date.now(), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('Could not download ' + path + ' (' + r.getResponseCode() + ')');
  return r.getContentText();
}
function api_(method, path, body) {
  var o = { method: method, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true };
  if (body) { o.contentType = 'application/json'; o.payload = JSON.stringify(body); }
  var r = UrlFetchApp.fetch('https://script.googleapis.com/v1/' + path, o), c = r.getResponseCode(), j = {};
  try { j = JSON.parse(r.getContentText() || '{}'); } catch (x) {}
  if (c >= 300) throw new Error(method.toUpperCase() + ' ' + path.split('/').slice(0, 3).join('/') + ' → ' + c + ': ' + ((j.error && j.error.message) || '').slice(0, 200));
  return j;
}
function state_() { return JSON.parse(PropertiesService.getScriptProperties().getProperty('STATE') || '{}'); }
function record_(name, fields) {
  var p = PropertiesService.getScriptProperties(), s = state_();
  s[name] = Object.assign(s[name] || {}, fields, { checkedAt: new Date().toISOString() });
  p.setProperty('STATE', JSON.stringify(s));
}
function status_() { return { ok: true, service: 'Samhithe deployer', repo: REPO + '@' + BRANCH, targets: state_() }; }

/** Public status page for the health check (versions and errors only, no personal data). */
function doGet() { return ContentService.createTextOutput(JSON.stringify(status_())).setMimeType(ContentService.MimeType.JSON); }
