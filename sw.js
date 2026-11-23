const root = "/smarttv-remote/";
const version = 'smarttv-phone-bf467b2440030d25';
const assets = new Set(["/smarttv-remote/remote/assets/f9c4a0f6eb221131/remote.js", "/smarttv-remote/remote/assets/16a0f88554396a8f/touchpad.js", "/smarttv-remote/remote/assets/fbc0c5c5efb4207f/handset.css", "/smarttv-remote/hosted-55b809de5e47e24d.js", "/smarttv-remote/static/art/smarttv-192.png", "/smarttv-remote/static/art/smarttv-512.png", "/smarttv-remote/static/art/smarttv-maskable.png", "/smarttv-remote/static/art/smarttv.svg", "/smarttv-remote/manifest.webmanifest", "/smarttv-remote/"]);
self.addEventListener('install', event => event.waitUntil((async () => {
  await (await caches.open(version)).addAll([...assets]);
  await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('smarttv-phone-') && key !== version) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !assets.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(version);
    if (url.pathname !== root) return (await cache.match(url.pathname)) || fetch(event.request);
    try { return await fetch(event.request); }
    catch { return (await cache.match(root)) || Response.error(); }
  })());
});
