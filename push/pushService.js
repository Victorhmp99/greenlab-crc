/* ═══════════════════════════════════════════════════════════
   Web Push — notificação com o app fechado
   ═══════════════════════════════════════════════════════════
   O navegador registra uma "subscription" (endpoint do serviço de push do
   próprio fabricante — Google/Apple/Mozilla). Guardamos essa subscription
   marcada com o tenant_id. Quando chega mensagem nova de WhatsApp, o servidor
   dispara um push pra todas as subscriptions daquela empresa — o SISTEMA
   OPERACIONAL acorda o service worker e mostra a notificação na tela, mesmo
   com o app fechado. Nada disso toca no WhatsApp/Baileys: é só leitura do que
   já chegou. Zero risco de banimento.

   Se as chaves VAPID não estiverem configuradas, o serviço fica desligado
   (enabled=false) e todo o resto do sistema continua funcionando normalmente. */

import webpush from 'web-push'
import { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } from '../config.js'

export function createPushService(db) {
  const enabled = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY)

  if (enabled) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
    console.log('[push] Web Push ATIVO (VAPID configurado)')
  } else {
    console.warn('[push] VAPID não configurado — push desligado (app usa aviso ao vivo)')
  }

  // Prepared statements reutilizados
  const stmtInsert = db.prepare(`
    INSERT INTO push_subscriptions (endpoint, tenant_id, user_id, p256dh, auth)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint, tenant_id) DO UPDATE SET
      user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth
  `)
  const stmtByTenant = db.prepare('SELECT * FROM push_subscriptions WHERE tenant_id = ?')
  const stmtDelEndpoint = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')

  /* Registra/atualiza a subscription de um aparelho para uma lista de tenants.
     Só grava tenants que o usuário realmente pertence (validado na rota). */
  function subscribe(subscription, userId, tenantIds) {
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      throw new Error('subscription inválida')
    }
    for (const tid of tenantIds) {
      stmtInsert.run(subscription.endpoint, tid, userId, subscription.keys.p256dh, subscription.keys.auth)
    }
  }

  /* Remove uma subscription (aparelho revogou permissão ou deslogou). */
  function unsubscribe(endpoint) {
    if (endpoint) stmtDelEndpoint.run(endpoint)
  }

  /* Dispara push pra todas as subscriptions de um tenant. Fire-and-forget:
     nunca lança pra fora (não pode derrubar o fluxo de mensagens). Limpa
     subscriptions mortas (410 Gone / 404) automaticamente. */
  async function sendToTenant(tenantId, payload) {
    if (!enabled || !tenantId) return
    let subs
    try { subs = stmtByTenant.all(tenantId) } catch (e) { console.error('[push] query falhou:', e.message); return }
    if (!subs.length) return

    const body = JSON.stringify(payload)
    await Promise.all(subs.map(async (s) => {
      const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }
      try {
        await webpush.sendNotification(sub, body, { TTL: 120, urgency: 'high' })
      } catch (err) {
        // 404/410 = endpoint morto (app desinstalado / permissão revogada) → remove
        if (err.statusCode === 404 || err.statusCode === 410) {
          try { stmtDelEndpoint.run(s.endpoint) } catch (_) {}
        } else {
          console.error(`[push] envio falhou (${err.statusCode || '?'}):`, err.message)
        }
      }
    }))
  }

  return { enabled, publicKey: VAPID_PUBLIC_KEY, subscribe, unsubscribe, sendToTenant }
}
