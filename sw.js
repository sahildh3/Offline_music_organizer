const CACHE_NAME = 'music-organizer-cache-v8';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './app.js',
  './exportWorker.js',
  './styles.css',
  './tailwind.css',
  './manifest.json',
  './logo.svg'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch(err => {
        console.warn("Service Worker cache.addAll failed:", err);
      });
    })
  );
});

self.addEventListener('fetch', (event) => {
  // Skip caching for audio blobs, object URLs, and uploaded files
  if (event.request.url.startsWith('blob:') || event.request.url.startsWith('data:')) {
    return;
  }
  if (event.request.destination === 'audio' || event.request.destination === 'video') {
    return fetch(event.request);
  }

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.match(event.request).then((cachedResponse) => {
        const fetchPromise = fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            cache.put(event.request, networkResponse.clone());
          }
          return networkResponse;
        }).catch((err) => {
          console.warn("Network fetch failed in stale-while-revalidate:", err);
          return new Response("Offline", { status: 503, statusText: "Service Unavailable" });
        });
        
        if (cachedResponse) {
          event.waitUntil(fetchPromise);
          return cachedResponse;
        }
        return fetchPromise;
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) => {
        return Promise.all(
          keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
        );
      }),
      self.clients.claim()
    ])
  );
});
