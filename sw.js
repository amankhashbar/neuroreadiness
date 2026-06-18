/* =============================================================
   NeuroReadiness — service worker
   Makes the app installable + offline. Strategy:
   - App shell (same-origin core files) is precached on install so a
     cold, offline launch works.
   - HTML navigations: network-first so the public landing page is never
     pinned behind an old cached app shell.
   - Other same-origin requests: cache-first, fall back to network, and cache
     anything new we fetch (covers files added later).
   - Cross-origin (Google Fonts): stale-while-revalidate so type
     still renders offline after the first online visit.
   Bump CACHE on any shell change to retire the old cache.
   ============================================================= */
const CACHE = "cortex-shell-v19";

// Paths are relative to the SW scope, so this works under a Pages subpath.
const SHELL = [
  "./",
  "./index.html",      // marketing landing
  "./account.html",    // sign up / sign in interstitial
  "./dashboard.html",  // post-sign-in hub
  "./sensor-setup.html",
  "./app.html",        // the instrument app
  "./manifest.webmanifest",
  "./css/cortex.css",
  "./css/landing.css",
  "./css/landing.v6.css",
  "./js/landing.js",
  "./js/dashboard.js",
  "./css/styles.css",
  "./js/util.js",
  "./js/sensor.js",
  "./js/ppg.js",
  "./js/motion.js",
  "./js/gsr.js",
  "./js/tasks.js",
  "./js/scores.js",
  "./js/csv.js",
  "./js/store.js",
  "./js/config.js",
  "./js/auth.js",
  "./js/store-remote.js",
  "./js/history.js",
  "./js/app.js",
  "./icons/icon.svg",
  "./icons/icon-maskable.svg",
  "./assets/bg/ambient-page.svg",
  "./assets/bg/ambient-hero.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isNavigation = req.mode === "navigate" ||
    (req.headers.get("accept") || "").includes("text/html");

  if (sameOrigin) {
    if (isNavigation) {
      event.respondWith(
        fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("./index.html")))
      );
      return;
    }

    // Cache-first for static shell assets; populate the cache with anything new.
    event.respondWith(
      caches.match(req, { ignoreSearch: true }).then((hit) =>
        hit ||
        fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => caches.match("./index.html")) // SPA-ish offline fallback
      )
    );
  } else {
    // Cross-origin (fonts): stale-while-revalidate.
    event.respondWith(
      caches.match(req).then((hit) => {
        const fetched = fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => hit);
        return hit || fetched;
      })
    );
  }
});
