/* Service worker mínimo — só o necessário pra instalabilidade do PWA.
 * NÃO cacheia /api/*, /socket.io/* nem POST — tudo isso precisa sempre
 * bater no servidor (dados em tempo real). Cacheia só o "shell" estático
 * (HTML/CSS/JS/ícones), pra abrir mais rápido e sobreviver a uma queda
 * momentânea de rede.
 */

const CACHE_NAME = 'crc-shell-v2'
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

/* ── Web Push ──
   O sistema operacional entrega o push aqui e acorda o service worker, mesmo
   com o app FECHADO. Mostramos a notificação na tela. Isso é o que faz a
   notificação chegar de verdade (diferente do aviso ao vivo, que só rodava
   com a aba aberta e o SO suspendia depois de ~1 min). */
self.addEventListener('push', (event) => {
  let payload = {}
  try { payload = event.data ? event.data.json() : {} } catch (_) { payload = {} }

  const title = payload.title || 'Nova mensagem'
  const options = {
    body:  payload.body || '',
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag:   payload.tag || 'crc-msg',
    renotify: true,
    data:  payload.data || {},
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

/* Clique na notificação: foca uma aba já aberta do CRC (ou abre uma nova) e
   manda a rota da conversa pra ela abrir direto na mensagem. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data || {}

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.postMessage({ type: 'open-conversation', ...data })
          return client.focus()
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow('/')
    }),
  )
})
