/* Offline app shell. Schematic data is cached separately in IndexedDB by the app. */
const CACHE = 'loomline-v2.6.1';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/kicad-core.js', 'js/render.js', 'js/storage.js', 'js/zip.js', 'js/edit.js', 'js/loom.js', 'js/cables.js', 'js/harness.js', 'js/github.js', 'js/app.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'fonts/ibm-plex-sans-latin-400-normal.woff2', 'fonts/ibm-plex-sans-latin-500-normal.woff2', 'fonts/ibm-plex-sans-latin-600-normal.woff2',
  'fonts/ibm-plex-sans-condensed-latin-400-normal.woff2', 'fonts/ibm-plex-sans-condensed-latin-500-normal.woff2', 'fonts/ibm-plex-sans-condensed-latin-600-normal.woff2',
  'fonts/ibm-plex-mono-latin-400-normal.woff2', 'fonts/ibm-plex-mono-latin-500-normal.woff2', 'fonts/ibm-plex-mono-latin-600-normal.woff2'
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // never touch GitHub API calls
  // Network first so a new deployment shows up straight away; fall back to the cache offline.
  e.respondWith(
    // Revalidate with the server so a new deployment is never mixed with stale cached files.
    fetch(e.request, { cache: 'no-cache' }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
