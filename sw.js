const C='ma-cave-configurable-v1-0';
const A=['./','./index.html','./app.js?v=1.0','./manifest.webmanifest?v=1.0'];
self.addEventListener('install',e=>{
  self.skipWaiting();
  e.waitUntil(caches.open(C).then(c=>c.addAll(A)));
});
self.addEventListener('activate',e=>e.waitUntil(Promise.all([
  self.clients.claim(),
  caches.keys().then(keys=>Promise.all(
    keys
      .filter(k=>k.startsWith('ma-cave-configurable-') && k!==C)
      .map(k=>caches.delete(k))
  ))
])));
self.addEventListener('fetch',e=>e.respondWith(
  fetch(e.request).then(r=>{
    const copy=r.clone();
    caches.open(C).then(c=>c.put(e.request,copy));
    return r;
  }).catch(()=>caches.match(e.request))
));
