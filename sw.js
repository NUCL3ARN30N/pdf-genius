const CACHE = 'pdf-genius-v2';
const ASSETS = ['/', '/index.html', '/style.css', '/app.js', '/favicon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/manifest.json'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    e.respondWith(
        caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
            if (resp.ok && !e.request.url.includes('cdn')) {
                const c = resp.clone();
                caches.open(CACHE).then(cache => cache.put(e.request, c));
            }
            return resp;
        }))
    );
});
