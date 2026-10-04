// Minimal service worker: makes the app installable and lets the shell open instantly.
// It never touches /api/* (chat, tasks and notes always go to the network, so nothing
// private is cached) and uses network-first for the page so a new deploy shows up at once.
const CACHE = "jarvis-shell-v4";
const SHELL = ["/", "/wake.js", "/jarvis-orb.png", "/icon-192.png", "/icon-512.png", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put("/", copy)); return res; })
      .catch(() => caches.match("/")));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => {
    const net = fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; }).catch(() => hit);
    return hit || net;
  }));
});

// Push: the server sends an empty "wake up" (no payload). Fetch what to say from the
// cookie-authenticated /api/notice, then show it. If that fails, still show something,
// because browsers require every push to produce a visible notification.
self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    let n = { title: "JARVIS", body: "I have an update for you, Sir." };
    try {
      const r = await fetch("/api/notice", { cache: "no-store" });
      if (r.ok) { const j = await r.json(); if (j.title) n = j; }
    } catch {}
    await self.registration.showNotification(n.title, {
      body: n.body, icon: "/icon-192.png", tag: "jarvis", renotify: true, data: { url: "/" },
    });
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if ("focus" in c) { await c.focus(); c.postMessage({ type: "refresh" }); return; } }
    await clients.openWindow("/");
  })());
});
