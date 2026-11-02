const CACHE_NAME = 'pista-voz-shell-v1';
const APP_ROOT = new URL('./', self.location);
const APP_SHELL = [
    APP_ROOT.href,
    new URL('index.html', APP_ROOT).href,
    new URL('manifest.webmanifest', APP_ROOT).href,
    new URL('app-icon.svg', APP_ROOT).href,
    new URL('logo.jpg', APP_ROOT).href
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => key.startsWith('pista-voz-shell-') && key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.origin !== self.location.origin) return;
    if (!APP_SHELL.includes(url.href) && request.mode !== 'navigate') return;

    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request).catch(async () =>
                (await caches.match(APP_ROOT.href)) || caches.match(new URL('index.html', APP_ROOT).href)
            )
        );
        return;
    }

    event.respondWith(
        caches.match(request).then((cached) =>
            cached || fetch(request).then(async (response) => {
                if (response.ok) {
                    const cache = await caches.open(CACHE_NAME);
                    await cache.put(request, response.clone());
                }
                return response;
            })
        )
    );
});
