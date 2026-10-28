// Push-Server für die Bestellliste.
// Beobachtet die Firebase-Datenbank und schickt Web-Push-Nachrichten, wenn eine
// Bestellung gestartet oder beendet wird (auch automatisch beim Bestellschluss).
// Keine Abhängigkeiten: nur Node 20+ Bordmittel.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DB_URL = (process.env.DB_URL || 'https://essen-bestelliste-default-rtdb.firebaseio.com').replace(/\/$/, '');
const DB_AUTH = process.env.DB_AUTH || '';            // optional: Datenbank-Secret, falls die Regeln Lesen verbieten
const SITE_URL = (process.env.SITE_URL || 'https://kalorienkonferenz-bestellliste.site').replace(/\/$/, '');
const CONTACT = process.env.CONTACT || 'mailto:push@kalorienkonferenz-bestellliste.site';
const DATA_DIR = process.env.DATA_DIR || '/data';
const TZ = process.env.TZ || 'Europe/Vienna';
const DRY_RUN = process.env.DRY_RUN === '1';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');

// ---------- VAPID-Schlüssel (werden beim ersten Start erzeugt und gespeichert) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const vapidFile = path.join(DATA_DIR, 'vapid.json');
let vapid;
if (fs.existsSync(vapidFile)) {
  vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8'));
} else {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  vapid = { jwk: privateKey.export({ format: 'jwk' }) };
  fs.writeFileSync(vapidFile, JSON.stringify(vapid), { mode: 0o600 });
  log('Neue VAPID-Schlüssel erzeugt');
}
const vapidPrivate = crypto.createPrivateKey({ key: vapid.jwk, format: 'jwk' });
const vapidPublicRaw = Buffer.concat([Buffer.from([4]), fromB64u(vapid.jwk.x), fromB64u(vapid.jwk.y)]);
export const VAPID_PUBLIC = b64u(vapidPublicRaw);

const jwtCache = new Map();
const vapidAuth = (endpoint) => {
  const aud = new URL(endpoint).origin;
  const cached = jwtCache.get(aud);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - now > 3600) return cached.header;
  const exp = now + 12 * 3600;
  const unsigned = `${b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${b64u(JSON.stringify({ aud, exp, sub: CONTACT }))}`;
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: vapidPrivate, dsaEncoding: 'ieee-p1363' });
  const header = `vapid t=${unsigned}.${b64u(sig)}, k=${VAPID_PUBLIC}`;
  jwtCache.set(aud, { exp, header });
  return header;
};

// ---------- Web-Push-Verschlüsselung (RFC 8291, aes128gcm) ----------
export const encryptPayload = (sub, payload) => {
  const uaPublic = fromB64u(sub.keys.p256dh);
  const authSecret = fromB64u(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
};

const sendPush = async (sub, message) => {
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: '3600',
      Urgency: 'high',
      Authorization: vapidAuth(sub.endpoint),
    },
    body: encryptPayload(sub, JSON.stringify(message)),
  });
  return res.status;
};

// ---------- Firebase Realtime Database (REST) ----------
const dbUrl = (p) => `${DB_URL}/${p}.json${DB_AUTH ? `?auth=${encodeURIComponent(DB_AUTH)}` : ''}`;
const dbGet = async (p) => (await fetch(dbUrl(p))).json();
const dbPut = (p, v) => fetch(dbUrl(p), { method: 'PUT', body: JSON.stringify(v) });
const dbDelete = (p) => fetch(dbUrl(p), { method: 'DELETE' });

// ---------- Zustand: welche Runden schon gemeldet wurden ----------
const stateFile = path.join(DATA_DIR, 'state.json');
let state = {};
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
const saveState = () => fs.writeFileSync(stateFile, JSON.stringify(state));

const hhmm = (ms) => new Intl.DateTimeFormat('de-AT', { hour: '2-digit', minute: '2-digit', timeZone: TZ }).format(new Date(ms));

// onlyUserId: nur an die Geräte dieser Person (Testmodus)
const notify = async (message, excludeUserId, onlyUserId) => {
  const subs = (await dbGet('pushSubs')) || {};
  let sent = 0, removed = 0;
  await Promise.all(Object.entries(subs).map(async ([id, s]) => {
    if (!s || !s.sub || !s.sub.endpoint || s.key !== VAPID_PUBLIC) return;
    if (onlyUserId && s.userId !== onlyUserId) return;
    if (!onlyUserId && excludeUserId && s.userId === excludeUserId) return;
    if (DRY_RUN) { sent++; return; }
    try {
      const status = await sendPush(s.sub, message);
      if (status === 404 || status === 410) { await dbDelete(`pushSubs/${id}`); removed++; }
      else if (status >= 200 && status < 300) sent++;
      else log(`Push an ${id} fehlgeschlagen: HTTP ${status}`);
    } catch (err) { log(`Push an ${id} fehlgeschlagen:`, err.message); }
  }));
  log(`"${message.title}" an ${sent} Geräte gesendet${onlyUserId ? ' (Testmodus, nur Starter)' : ''}${removed ? `, ${removed} abgelaufene entfernt` : ''}`);
};

let rounds = {};
const startedAt = Date.now();

const check = async () => {
  const now = Date.now();
  let changed = false;
  for (const [id, r] of Object.entries(rounds)) {
    const s = (r && r.settings) || {};
    if (!s.endTime) continue;
    const open = !!s.orderActive && now < s.endTime;
    let st = state[id];
    if (!st) {
      // Runden, die schon länger laufen als der Server weiß, nicht nachträglich melden
      const old = !s.createdAt || now - s.createdAt > 10 * 60 * 1000;
      st = state[id] = { start: old, stop: old && !open };
      changed = true;
    }
    const res = s.restaurant || 'Essen';
    // Test-Bestellungen (Testmodus in der App): nur der Starter selbst bekommt die Nachricht
    const test = !!s.test;
    const pre = test ? '🧪 TEST · ' : '';
    const only = test ? s.adminId || '__niemand__' : null;
    if (open && !st.start) {
      st.start = true; changed = true;
      const who = s.adminName ? `${s.adminName} hat eine Bestellung gestartet. ` : '';
      await notify({
        title: `${pre}🍔 Neue Bestellung: ${res}`,
        body: `${who}Bestellen bis ${hhmm(s.endTime)} Uhr · Lieferung ${s.time || '--:--'} Uhr · ${s.chamber || ''}`.trim(),
        url: `${SITE_URL}/?b=${id}`, tag: `round-${id}`,
      }, s.adminId, only);
    }
    if (!open && st.start && !st.stop) {
      st.stop = true; changed = true;
      const count = r.orders ? Object.keys(r.orders).length : 0;
      const manual = s.orderActive === false;
      if (now - s.endTime < 60 * 60 * 1000 || manual) {
        await notify({
          title: `${pre}${manual ? `✅ Bestellung beendet: ${res}` : `⏰ Bestellschluss: ${res}`}`,
          body: `${count} ${count === 1 ? 'Bestellung' : 'Bestellungen'} · Lieferung ${s.time || '--:--'} Uhr · ${s.chamber || ''}`.trim(),
          url: `${SITE_URL}/?b=${id}`, tag: `round-${id}`,
        }, manual ? s.stoppedBy : null, only);
      }
    }
    if (open && st.stop) { st.stop = false; changed = true; } // Bestellschluss wurde verlängert
  }
  for (const id of Object.keys(state)) {
    if (!rounds[id] && Date.now() - startedAt > 30000) { delete state[id]; changed = true; }
  }
  if (changed) saveState();
};

// Nie zwei Prüfungen gleichzeitig (sonst doppelte Nachrichten)
let checking = null, again = false;
const runCheck = async () => {
  if (checking) { again = true; return checking; }
  checking = (async () => {
    do { again = false; await check().catch((e) => log('Fehler:', e.message)); } while (again);
  })();
  await checking; checking = null;
};

// Pfad-genaues Einarbeiten der Stream-Events in den lokalen Baum
export const applyAt = (tree, p, data) => {
  const parts = p.split('/').filter(Boolean);
  if (!parts.length) return data || {};
  const root = tree && typeof tree === 'object' ? tree : {};
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
    node = node[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (data === null) delete node[last];
  else node[last] = data;
  return root;
};

const stream = async () => {
  while (true) {
    try {
      log('Verbinde mit der Datenbank …');
      const res = await fetch(dbUrl('rounds'), { headers: { Accept: 'text/event-stream' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev === 'put' || ev === 'patch') {
            const d = JSON.parse(data);
            if (ev === 'patch') {
              for (const [k, v] of Object.entries(d.data || {})) rounds = applyAt(rounds, `${d.path}/${k}`, v);
            } else rounds = applyAt(rounds, d.path, d.data);
            await runCheck();
          } else if (ev === 'cancel' || ev === 'auth_revoked') {
            throw new Error(`Stream beendet: ${ev}`);
          }
        }
      }
      throw new Error('Verbindung geschlossen');
    } catch (err) {
      log('Stream-Fehler:', err.message, '- neuer Versuch in 10 s');
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
};

// Test-Nachrichten: die App schreibt push/tests/<Geräte-ID>, der Server schickt eine Nachricht an genau dieses Gerät
const handleTests = async () => {
  try {
    const tests = (await dbGet('push/tests')) || {};
    for (const id of Object.keys(tests)) {
      await dbDelete(`push/tests/${id}`);
      const s = await dbGet(`pushSubs/${id}`);
      if (!s || !s.sub || s.key !== VAPID_PUBLIC) { log(`Test für ${id}: Gerät nicht angemeldet`); continue; }
      const status = DRY_RUN ? 201 : await sendPush(s.sub, {
        title: '🔔 Test-Nachricht', body: 'Benachrichtigungen funktionieren. Du bekommst Bescheid, wenn eine Bestellung startet oder endet.',
        url: `${SITE_URL}/`, tag: 'test',
      });
      if (status === 404 || status === 410) await dbDelete(`pushSubs/${id}`);
      log(`Test-Nachricht an ${s.user || id}: HTTP ${status}`);
    }
  } catch (err) { log('Test-Nachrichten fehlgeschlagen:', err.message); }
};

// Öffentlichen Schlüssel für die App bereitstellen (und wiederherstellen, falls überschrieben)
const publishKey = async () => {
  try {
    const current = await dbGet('push/vapidPublicKey');
    if (current !== VAPID_PUBLIC) { await dbPut('push/vapidPublicKey', VAPID_PUBLIC); log('Öffentlicher Schlüssel in der Datenbank hinterlegt'); }
  } catch (err) { log('Schlüssel konnte nicht hinterlegt werden:', err.message); }
};

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  log(`Push-Server startet${DRY_RUN ? ' (Testmodus, sendet nichts)' : ''}`);
  await publishKey();
  setInterval(publishKey, 5 * 60 * 1000);
  setInterval(runCheck, 10000);
  setInterval(handleTests, 4000);
  stream();
}
