/* Samhithe Admin – service worker.
   Caches only the app shell (this page, icons, logo, fonts) so the portal opens instantly and installs to the home screen.
   It never caches or touches the data requests to Google (script.google.com) – families' data is not stored here. */
var CACHE = "sam-admin-v3";
var SHELL = ["./", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/apple-touch-icon.png", "../blog/assets/mark.webp"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf("sam-admin-") === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  if (/(^|\.)google\.com$|googleusercontent\.com$/.test(url.hostname) && !/^fonts\./.test(url.hostname)) return;   // data: always live, never cached

  // The page itself: show the cached copy instantly, refresh it in the background for next time.
  if (req.mode === "navigate" && url.origin === location.origin) {
    e.respondWith(caches.open(CACHE).then(function (c) {
      return c.match("./").then(function (hit) {
        var net = fetch(req).then(function (r) { if (r.ok) c.put("./", r.clone()); return r; });
        return hit ? (e.waitUntil(net.catch(function () {})), hit) : net;
      });
    }));
    return;
  }

  // Icons, logo and Google Fonts: cache first.
  if (url.origin === location.origin || /^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(caches.open(CACHE).then(function (c) {
      return c.match(req).then(function (hit) {
        return hit || fetch(req).then(function (r) { if (r.ok || r.type === "opaque") c.put(req, r.clone()); return r; });
      });
    }));
  }
});
