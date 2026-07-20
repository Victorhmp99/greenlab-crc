/* Service worker mínimo — só o necessário pra instalabilidade do PWA.
 * NÃO cacheia /api/*, /socket.io/* nem POST — tudo isso precisa sempre
 * bater no servidor (dados em tempo real). Cacheia só o "shell" estático
 * (HTML/CSS/JS/ícones), pra abrir mais rápido e sobreviver a uma queda
 * momentânea de rede.
 */

const CACHE_NAME = 'crc-shell-v1'
const SHELL_FILES = [
  '/', '/index.html', '/style.css', '/app.js', '/manifest.json',
  '/icons/icon-192.png', '/icons/icon-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {}),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return

  // Network-first: sempre tenta a rede (pra pegar deploys novos), cai pro cache só se offline
  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone()
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {})
        return res
      })
      .catch(() => caches.match(request)),
  )
})
