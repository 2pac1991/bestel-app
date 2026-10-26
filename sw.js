// Service Worker: macht die Seite installierbar und zeigt Push-Benachrichtigungen an
self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// Der "leere" Fetch-Event ist für die PWA-Erkennung nötig
self.addEventListener('fetch', () => {});

// Push vom Bestellliste-Server: { title, body, url, tag }
self.addEventListener('push', (event) => {
    let msg = {};
    try { msg = event.data ? event.data.json() : {}; } catch { msg = { body: event.data && event.data.text() }; }
    event.waitUntil(self.registration.showNotification(msg.title || 'Bestell-Liste 🍔', {
        body: msg.body || '',
        icon: 'icon.png',
        badge: 'app/notification-icon.png',
        tag: msg.tag || undefined,
        renotify: !!msg.tag,
        data: { url: msg.url || './' }
    }));
});

// Tippen auf die Benachrichtigung öffnet die passende Bestellung
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = new URL((event.notification.data && event.notification.data.url) || './', self.location.origin).href;
    event.waitUntil((async () => {
        const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const w of wins) {
            if (new URL(w.url).origin === self.location.origin && 'navigate' in w) {
                await w.focus();
                return w.navigate(url);
            }
        }
        return self.clients.openWindow(url);
    })());
});
