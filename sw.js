// Installiert den Service Worker und aktiviert ihn sofort
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('Service Worker ist bereit!');
});

// Der "Leere" Fetch-Event ist notwendig für die PWA-Erkennung
self.addEventListener('fetch', (event) => {
    // Hier könnte man später Bilder oder Scripte zwischenspeichern (Caching)
});
