/* ═══════════════════════════════════════════════════════════
   CRC Green Lab — Frontend
   ═══════════════════════════════════════════════════════════ */

/* ── Autenticação (Supabase — mesma conta do CRM) ────────────
   Cada pessoa loga com o email/senha do CRM. O acesso a cada empresa vem
   de user_memberships (a mesma fonte de verdade que o CRM usa) — não
   depende mais de nada que venha pela URL. */
const SUPABASE_URL      = document.querySelector('meta[name="supabase-url"]')?.content || ''
const SUPABASE_ANON_KEY = document.querySelector('meta[name="supabase-anon-key"]')?.content || ''
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'crc-auth' },
})

let CURRENT_USER      = ''
let AVAILABLE_TENANTS = []   // [{id, name}] — só as empresas que esse usuário realmente pertence
const TENANT_NAMES    = {}   // tenant_id -> nome, preenchido após login
// Cargo POR EMPRESA ('admin' | 'manager' | 'seller') — mesma fonte do CRM.
// Só admin e gestor (manager) adicionam números; vendedor só atende.
const TENANT_ROLES    = {}   // tenant_id -> role
let IS_SUPER_ADMIN    = false

// Pode adicionar número NESTA empresa? (cargo é por empresa)
function canManageTenant(tenantId) {
  if (IS_SUPER_ADMIN) return true
  const r = TENANT_ROLES[tenantId]
  return r === 'admin' || r === 'manager'
}

// Pode adicionar número em ALGUMA das empresas do usuário?
// (o servidor valida de novo por empresa — aqui é só pra mostrar/esconder o botão)
function canAddNumber() {
  return AVAILABLE_TENANTS.some(t => canManageTenant(t.id))
}

// Cabeçalho enviado em todas as requisições — mutado (não recriado) após
// login, pra todo `{ ...TENANT_HEADERS }' espalhado pelo arquivo pegar o token atual
const TENANT_HEADERS = {}
function setAuthToken(token) {
  if (token) TENANT_HEADERS['Authorization'] = `Bearer ${token}`
  else       delete TENANT_HEADERS['Authorization']
}

// Usuário é dono de uma sessão se foi ele quem criou
// (created_by vazio = sessão sem dono ainda, tratado no auto-claim)
function isOwner(session) {
  if (!CURRENT_USER) return false
  return session.created_by === CURRENT_USER
}

const state = {
  sessions:           [],
  conversations:      [],
  activeSession:      null,
  activeConversation: null,
  pendingFile:        null,
  editingMessage:     null,   // {id, body} — mensagem sendo editada, ou null
  replyingTo:         null,   // {id, body, fromMe} — mensagem sendo respondida/citada, ou null
  pendingQrSession:   null,   // sessão cujo QR estamos aguardando (modal aberto)
  quickReplies:       [],     // atalhos "/nome" compartilhados por empresa
  connectMethod:      'qr',   // 'qr' ou 'code' — método escolhido no modal de adicionar
  mobileView:         'sessions', // 'sessions' | 'conversations' | 'chat' — só importa em tela estreita
}

/* ── Navegação mobile (estilo WhatsApp: uma tela por vez) ────
   Em desktop (CSS sem o @media de 768px) isso não tem efeito visual —
   as 3 colunas continuam aparecendo juntas como sempre apareceram. */
function setMobileView(view) {
  state.mobileView = view
  document.getElementById('app').dataset.mobileView = view
}
function backToSessions()      { setMobileView('sessions') }
function backToConversations() { setMobileView('conversations') }
setMobileView(state.mobileView)

/* ── Socket.io ────────────────────────────────────────────── */

const socket = io()

// Entra nas salas das empresas deste usuário — o servidor valida o token
// e decide sozinho quais empresas essa pessoa realmente pode ver
function joinTenantRooms() {
  const auth = TENANT_HEADERS['Authorization']
  if (!auth) return   // ainda não logou
  socket.emit('join', { token: auth.replace('Bearer ', '') })
}
socket.on('connect', joinTenantRooms)
if (socket.connected) joinTenantRooms()

socket.on('qr', ({ sessionId, qr }) => {
  // Só mostra o QR da sessão que o usuário está conectando agora — evita popups aleatórios
  if (state.pendingQrSession && sessionId !== state.pendingQrSession) return
  const sess = state.sessions.find(s => s.id === sessionId)
  document.getElementById('qr-session-label').textContent = sess ? `Número: ${sess.name}` : sessionId
  document.getElementById('qr-wrapper').innerHTML = `<img src="${qr}" width="240" height="240" alt="QR Code" />`
  document.getElementById('qr-method-block').style.display = 'flex'
  document.getElementById('pairing-method-block').style.display = 'none'
  document.getElementById('modal-qr').classList.remove('hidden')
})

// Código de pareamento à distância (sem câmera) — vincula digitando o código no celular
socket.on('pairing-code', ({ sessionId, code }) => {
  if (state.pendingQrSession && sessionId !== state.pendingQrSession) return
  const sess = state.sessions.find(s => s.id === sessionId)
  document.getElementById('qr-session-label').textContent = sess ? `Número: ${sess.name}` : sessionId
  document.getElementById('pairing-code-wrapper').outerHTML =
    `<div id="pairing-code-wrapper" class="pairing-code-display">${esc(code)}</div>`
  document.getElementById('qr-method-block').style.display = 'none'
  document.getElementById('pairing-method-block').style.display = 'flex'
  document.getElementById('modal-qr').classList.remove('hidden')
})

socket.on('session:update', ({ sessionId, status, phone, reason }) => {
  const s = state.sessions.find(s => s.id === sessionId)
  if (!s) return
  s.status = status
  if (phone) s.phone = phone
  renderSessions()
  if (status === 'connected') {
    state.pendingQrSession = null
    document.getElementById('modal-qr').classList.add('hidden')
    resetQrModal()
  }
  // QR expirou / desistiu de conectar → fecha o modal e avisa
  if (status === 'disconnected' && (reason === 'qr_timeout' || reason === 'max_retries')) {
    if (state.pendingQrSession === sessionId) {
      state.pendingQrSession = null
      document.getElementById('modal-qr').classList.add('hidden')
      resetQrModal()
      showToast(reason === 'qr_timeout'
        ? 'QR Code expirou. Clique no número para tentar conectar de novo.'
        : 'Não foi possível conectar. Tente novamente.', 'error')
    }
  }
})

// Mídia chegou em background — atualiza o balão existente sem recriar
socket.on('message:media', ({ msgId, sessionId, convId, mediaType, mediaUrl }) => {
  const active = state.activeConversation
  if (!active || active.id !== convId || active.session_id !== sessionId) return
  const el = document.getElementById(`msg-${msgId}`)
  if (!el) return
  const bubble = el.querySelector('.msg-bubble')
  if (!bubble) return
  bubble.innerHTML = renderMediaContent({ media_type: mediaType, media_url: mediaUrl, body: bubble.textContent.trim() })
})

/* Foto de perfil encontrada em segundo plano — atualiza a lista na hora,
   sem precisar dar F5 nem reabrir a conversa. */
socket.on('conversation:pic', ({ sessionId, convId, url }) => {
  const conv = state.conversations.find(c => c.id === convId && c.session_id === sessionId)
  if (!conv || !url) return
  conv.profile_pic = url
  renderConversations()
  // se a conversa aberta é essa, atualiza o avatar do cabeçalho também
  const ativa = state.activeConversation
  if (ativa && ativa.id === convId && ativa.session_id === sessionId) loadProfilePic(ativa)
})

// Status das mensagens enviadas (✓ enviado, ✓✓ entregue, ✓✓ azul lido)
socket.on('message:edited', ({ sessionId, convId, msgId, body }) => {
  const active = state.activeConversation
  if (!active || active.id !== convId || active.session_id !== sessionId) return
  const bubble = document.querySelector(`#msg-${CSS.escape(msgId)} .msg-bubble`)
  if (bubble) bubble.textContent = body
  const timeEl = document.querySelector(`#msg-${CSS.escape(msgId)} .msg-time`)
  if (timeEl && !timeEl.querySelector('.msg-edited-tag')) {
    timeEl.insertAdjacentHTML('afterbegin', '<span class="msg-edited-tag">editada</span>')
  }
})

socket.on('message:status', ({ sessionId, convId, msgId, status }) => {
  const active = state.activeConversation
  if (!active || active.id !== convId || active.session_id !== sessionId) return
  const el = document.querySelector(`#msg-${CSS.escape(msgId)} .msg-status`)
  if (el) el.innerHTML = statusIcon(status)
})

// Presença: digitando / gravando
socket.on('presence:update', ({ sessionId, convId, presence }) => {
  const active = state.activeConversation
  if (!active || active.id !== convId || active.session_id !== sessionId) return
  const meta = document.getElementById('chat-presence')
  if (!meta) return
  if (presence === 'composing')      meta.textContent = 'digitando…'
  else if (presence === 'recording') meta.textContent = 'gravando áudio…'
  else                               meta.textContent = ''
})

socket.on('message:new', ({ conversation, message }) => {
  if (!conversation) return   // guard contra null em erros internos
  const idx = state.conversations.findIndex(
    c => c.id === conversation.id && c.session_id === conversation.session_id
  )
  if (idx >= 0) state.conversations[idx] = conversation
  else          state.conversations.unshift(conversation)

  state.conversations.sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at))
  renderConversations()

  const active = state.activeConversation
  const isThisConvOpen = active && active.id === message.conversation_id && active.session_id === message.session_id

  if (isThisConvOpen) {
    const list = document.getElementById('messages-list')
    const wasNearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 150
    appendMessage(message)
    if (wasNearBottom || message.from_me) scrollToBottom()
    else document.getElementById('scroll-bottom-btn').classList.remove('hidden')
  }

  // Notificação estilo WhatsApp — só avisos passivos (lê o que já chegou),
  // nunca interage com o WhatsApp, então não tem risco nenhum de ban.
  if (!message.from_me && !isThisConvOpen) {
    notifyIncomingMessage(conversation, message)
  }
})

/* ── Notificação de mensagem nova ────────────────────────────
   Dois níveis, complementares:
   1) Aviso AO VIVO (Web Notification): aparece na hora enquanto a aba está
      aberta. Instantâneo, mas o SO suspende quando o app fica fechado.
   2) Web PUSH (via service worker): o próprio sistema operacional acorda e
      mostra a notificação mesmo com o app FECHADO — é isso que resolve o
      "parou de notificar depois de 1 min". Configurado em subscribeToPush().
   Tudo é leitura passiva do que já chegou: nunca toca no WhatsApp, sem risco
   de ban. */

const VAPID_PUBLIC_KEY = document.querySelector('meta[name="vapid-public-key"]')?.content || ''
// true quando o push está de fato registrado no servidor. Enquanto for false,
// o aviso da própria página entra como reserva (ver notifyIncomingMessage).
let pushActive = false

function requestNotificationPermission() {
  if (!('Notification' in window)) return
  if (Notification.permission === 'granted') {
    subscribeToPush()
  } else if (Notification.permission === 'default') {
    Notification.requestPermission()
      .then((perm) => { if (perm === 'granted') subscribeToPush() })
      .catch(() => {})
  }
}

// Converte a chave pública VAPID (base64url) para o formato que o pushManager exige
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw     = atob(base64)
  const out     = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

// Registra este aparelho no servidor pra receber push das empresas do usuário.
// Idempotente: pode chamar sempre que logar/abrir — reaproveita a subscription.
async function subscribeToPush() {
  try {
    if (!VAPID_PUBLIC_KEY || !('serviceWorker' in navigator) || !('PushManager' in window)) return
    const reg = await navigator.serviceWorker.ready
    let sub = await reg.pushManager.getSubscription()
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      })
    }
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...TENANT_HEADERS },
      body: JSON.stringify({ subscription: sub }),
    })
    // Só marca como ativo se o servidor CONFIRMOU o registro — daí em diante
    // quem avisa é o push (service worker), e o aviso da página se cala pra
    // não duplicar. Se qualquer etapa falhar, segue false e a página avisa.
    pushActive = res.ok
  } catch (e) {
    pushActive = false
    console.warn('[push] não foi possível assinar:', e.message)
  }
}

// Remove o registro de push deste aparelho (ao deslogar) — para de receber
// notificações da conta antiga neste dispositivo.
async function unsubscribeFromPush() {
  pushActive = false   // sem push registrado, o aviso da página volta a valer
  try {
    if (!('serviceWorker' in navigator)) return
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (!sub) return
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...TENANT_HEADERS },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {})
    await sub.unsubscribe().catch(() => {})
  } catch (_) {}
}

/* Aviso da PÁGINA — hoje serve só de RESERVA.
   Antes chegavam 2 notificações pela mesma mensagem: o service worker recebe o
   push MESMO com a aba aberta (a suposição antiga de que o SO não o acordaria
   nesse caso estava errada), então página e push avisavam ao mesmo tempo.
   Agora, com push ativo, quem avisa é só o push. Se o push não estiver ativo
   (permissão negada, assinatura falhou, navegador sem suporte), esta função
   volta a agir — assim nunca ficamos sem aviso nenhum. */
function notifyIncomingMessage(conversation, message) {
  if (pushActive) return                                // push ativo = ele avisa, não duplicamos
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  if (document.visibilityState !== 'visible') return   // fechado/2º plano → o push cuida

  const title = conversation.name || conversation.phone || 'Nova mensagem'
  const body  = previewIcon(message.body) + (message.body || 'Nova mensagem')

  const n = new Notification(title, {
    body,
    icon: '/icons/icon-192.png',
    tag: `conv-${conversation.session_id}-${conversation.id}`,  // agrupa por conversa, não empilha
    renotify: true,
  })
  n.onclick = () => {
    window.focus()
    n.close()
    selectSession(conversation.session_id)
    openConversation(conversation.id, conversation.session_id)
  }
}

// Clique na notificação de push (com app fechado) chega aqui via service worker:
// abre a conversa certa quando a aba ganha foco.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const d = event.data || {}
    if (d.type === 'open-conversation' && d.sessionId && d.convId) {
      selectSession(d.sessionId)
      openConversation(d.convId, d.sessionId)
    }
  })
}

/* ── Login ────────────────────────────────────────────────── */

function showLoginScreen(message) {
  document.getElementById('app').classList.add('hidden')
  document.getElementById('login-screen').classList.remove('hidden')
  const errBox = document.getElementById('login-error')
  if (message) { errBox.textContent = message; errBox.classList.remove('hidden') }
  else         { errBox.classList.add('hidden') }
}

// Botão de olho no campo de senha
function togglePasswordVisibility() {
  const input       = document.getElementById('login-password')
  const openIcon    = document.getElementById('pw-eye-open')
  const closedIcon  = document.getElementById('pw-eye-closed')
  const showingText = input.type === 'text'
  input.type = showingText ? 'password' : 'text'
  openIcon.classList.toggle('hidden', !showingText)
  closedIcon.classList.toggle('hidden', showingText)
}

// Envio real de <form> — é o gatilho que faz o navegador oferecer "salvar senha"
function handleLoginSubmit(event) {
  event.preventDefault()
  doLogin()
  return false
}

async function doLogin() {
  const email    = document.getElementById('login-email').value.trim()
  const password = document.getElementById('login-password').value
  const errBox   = document.getElementById('login-error')
  const btn      = document.getElementById('login-submit')
  errBox.classList.add('hidden')

  if (!email || !password) {
    errBox.textContent = 'Preencha e-mail e senha.'
    errBox.classList.remove('hidden')
    return
  }

  btn.disabled = true
  try {
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password })
    if (error) {
      errBox.textContent = 'E-mail ou senha inválidos.'
      errBox.classList.remove('hidden')
      return
    }
    await bootFromSession()
  } catch (e) {
    errBox.textContent = 'Erro de conexão: ' + e.message
    errBox.classList.remove('hidden')
  } finally {
    btn.disabled = false
  }
}

// Carrega a sessão salva (se houver) e monta o app — chamado no boot da
// página e logo após um login bem-sucedido
async function bootFromSession() {
  const { data: { session } } = await supabaseClient.auth.getSession()
  if (!session) { showLoginScreen(); return }

  setAuthToken(session.access_token)
  CURRENT_USER = session.user.id

  // Empresas que esse usuário realmente pertence (mesma fonte de verdade do CRM)
  const { data: memberships, error: mErr } = await supabaseClient
    .from('user_memberships')
    .select('tenant_id, role')
    .eq('user_id', CURRENT_USER)
    .eq('active', true)

  if (mErr || !memberships || memberships.length === 0) {
    await supabaseClient.auth.signOut()
    showLoginScreen('Sua conta não está vinculada a nenhuma empresa com WhatsApp.')
    return
  }

  // Guarda o cargo de cada empresa (decide quem vê o botão de adicionar número)
  Object.keys(TENANT_ROLES).forEach(k => delete TENANT_ROLES[k])
  memberships.forEach((m) => { TENANT_ROLES[m.tenant_id] = m.role })
  try {
    const { data: sa } = await supabaseClient
      .from('super_admins').select('user_id').eq('user_id', CURRENT_USER).maybeSingle()
    IS_SUPER_ADMIN = !!sa
  } catch (_) { IS_SUPER_ADMIN = false }

  const tenantIds = memberships.map((m) => m.tenant_id)
  const { data: tenants } = await supabaseClient
    .from('tenants')
    .select('id, name')
    .in('id', tenantIds)

  AVAILABLE_TENANTS = (tenants || []).map((t) => ({ id: t.id, name: t.name }))
  AVAILABLE_TENANTS.forEach((t) => { TENANT_NAMES[t.id] = t.name })

  document.getElementById('login-screen').classList.add('hidden')
  document.getElementById('app').classList.remove('hidden')

  joinTenantRooms()
  await init()
  maybeShowInstallGuideAutomatically()
  requestNotificationPermission()
}

async function doLogout() {
  await unsubscribeFromPush()   // para de receber push neste aparelho (antes de perder o token)
  await supabaseClient.auth.signOut()
}

/* ── Guia de instalação (usar como app / PWA) ──────────────── */

const INSTALL_GUIDE_SEEN_KEY = 'crc-install-guide-seen'

function openInstallGuide()  { document.getElementById('modal-install-guide').classList.remove('hidden') }
function closeInstallGuide() { document.getElementById('modal-install-guide').classList.add('hidden') }

function setInstallTab(tab) {
  document.getElementById('install-tab-android').classList.toggle('active', tab === 'android')
  document.getElementById('install-tab-ios').classList.toggle('active', tab === 'ios')
  document.getElementById('install-steps-android').classList.toggle('hidden', tab !== 'android')
  document.getElementById('install-steps-ios').classList.toggle('hidden', tab !== 'ios')
}

function detectPlatformTab() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent || '') ? 'ios' : 'android'
}

// Só aparece sozinho uma vez por aparelho (localStorage), no primeiro login.
// Se já está rodando instalado (modo standalone), a pessoa já instalou — não mostra.
function maybeShowInstallGuideAutomatically() {
  if (localStorage.getItem(INSTALL_GUIDE_SEEN_KEY)) return
  localStorage.setItem(INSTALL_GUIDE_SEEN_KEY, '1')

  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
  if (isStandalone) return

  setInstallTab(detectPlatformTab())
  openInstallGuide()
}

// Reage a logout ou renovação de token em qualquer momento da sessão
supabaseClient.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') {
    setAuthToken(null)
    showLoginScreen()
  } else if (event === 'TOKEN_REFRESHED' && session) {
    setAuthToken(session.access_token)
  }
})

// Volta pra tela de login se uma resposta da API vier 401/403 (sessão
// expirou ou perdeu o vínculo com a empresa no meio do uso)
function handleAuthFailure(res) {
  if (res.status === 401 || res.status === 403) {
    showLoginScreen('Sua sessão expirou. Entre novamente.')
    return true
  }
  return false
}

/* ── Init ─────────────────────────────────────────────────── */

async function init() {
  await Promise.all([loadSessions(), loadConversations(), loadQuickReplies()])
}

// Ao carregar a página: se já tem sessão salva, entra direto sem pedir login de novo
bootFromSession()

/* ── Sessions ─────────────────────────────────────────────── */

async function loadSessions() {
  const res = await fetch('/api/sessions', { headers: TENANT_HEADERS })
  if (!res.ok) { if (handleAuthFailure(res)) return; state.sessions = []; return }
  state.sessions = await res.json()

  // Auto-claim: se há sessões sem dono e o usuário está logado, assume o controle
  if (CURRENT_USER) {
    const unclaimed = state.sessions.filter(s => !s.created_by)
    await Promise.all(unclaimed.map(s =>
      fetch(`/api/sessions/${s.id}/claim`, {
        method: 'POST',
        headers: { ...TENANT_HEADERS, 'Content-Type': 'application/json' },
      }).then(r => r.json()).then(data => { s.created_by = data.created_by })
    ))
  }

  renderSessions()
}

// Soma o unread_count de todas as conversas de um número (ou geral, se sessionId for null)
function unreadCountFor(sessionId) {
  return state.conversations.reduce((sum, c) => {
    if (sessionId !== null && c.session_id !== sessionId) return sum
    return sum + (c.unread_count || 0)
  }, 0)
}

function badgeHtml(count) {
  if (!count) return ''
  return `<span class="unread-badge">${count > 99 ? '99+' : count}</span>`
}

function renderSessions() {
  const list = document.getElementById('sessions-list')

  /* Botão "+" (adicionar número): só ADMIN e GESTOR, pelo cargo real do CRM.
     Antes a regra era "ser dono de alguma sessão existente", o que fez o botão
     sumir de vez: as sessões antigas guardam o identificador de dono do login
     anterior (o CRC passou a autenticar com a conta do CRM/Supabase), então o
     usuário deixou de ser reconhecido como dono de qualquer uma.
     O servidor valida a mesma regra em POST /api/sessions — esconder aqui é
     conveniência, não segurança. */
  const addBtn = document.getElementById('btn-add-session')
  if (addBtn) addBtn.style.display = canAddNumber() ? 'flex' : 'none'

  // Badge da "Todas" (caixa unificada)
  const allBadge = document.getElementById('filter-all-badge')
  const allCount = unreadCountFor(null)
  if (allBadge) {
    allBadge.textContent = allCount > 99 ? '99+' : allCount
    allBadge.classList.toggle('hidden', allCount === 0)
  }

  list.innerHTML = state.sessions.map(s => `
    <div class="session-item ${state.activeSession?.id === s.id ? 'active' : ''}"
         onclick="selectSession('${s.id}')">
      <div class="session-avatar" style="background:${avatarColor(s.name)}">
        ${initials(s.name)}
      </div>
      <div class="session-info">
        <span class="session-name">${esc(s.name)}</span>
        <span class="session-status-text">${s.phone || statusLabel(s.status)}</span>
        ${TENANT_NAMES[s.tenant_id]
          ? `<span class="session-tenant-tag">${esc(TENANT_NAMES[s.tenant_id])}</span>`
          : ''}
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
        ${badgeHtml(unreadCountFor(s.id))}
        <span class="status-dot ${s.status}"></span>
        ${canManageTenant(s.tenant_id) ? `
        <div class="session-actions">
          ${s.status === 'disconnected' ? `
          <button class="btn-muted" title="Reconectar (novo QR)" onclick="event.stopPropagation();reconnectSession('${s.id}','${esc(s.name)}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          </button>
          <button class="btn-muted" title="Não reconecta? Vincular do zero (mantém as conversas)" onclick="event.stopPropagation();relinkSession('${s.id}','${esc(s.name)}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18.36 6.64A9 9 0 1 1 5.64 5.64"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
          </button>` : ''}
          <button class="btn-muted" title="Limpar conversas" onclick="event.stopPropagation();clearConversations('${s.id}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
          </button>
          <button class="btn-danger" title="Desconectar e remover" onclick="event.stopPropagation();removeSession('${s.id}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18.36 6.64A9 9 0 1 1 5.64 5.64"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
          </button>
        </div>` : ''}
      </div>
    </div>
  `).join('')
}

// Alterna entre método QR e Código no modal de adicionar número
function setConnectMethod(method) {
  state.connectMethod = method
  document.getElementById('method-btn-qr').classList.toggle('active', method === 'qr')
  document.getElementById('method-btn-code').classList.toggle('active', method === 'code')
  document.getElementById('phone-number-wrap').style.display = method === 'code' ? 'block' : 'none'
}

function openPendingModal(sessionId, name, method) {
  state.pendingQrSession = sessionId
  document.getElementById('qr-session-label').textContent = `Número: ${name}`
  if (method === 'code') {
    document.getElementById('pairing-code-wrapper').outerHTML =
      `<div id="pairing-code-wrapper" class="qr-placeholder"><div class="spinner"></div><span>Gerando código…</span></div>`
    document.getElementById('qr-method-block').style.display = 'none'
    document.getElementById('pairing-method-block').style.display = 'flex'
  } else {
    document.getElementById('qr-wrapper').innerHTML =
      `<div class="qr-placeholder"><div class="spinner"></div><span>Gerando QR Code…</span></div>`
    document.getElementById('qr-method-block').style.display = 'flex'
    document.getElementById('pairing-method-block').style.display = 'none'
  }
  document.getElementById('modal-qr').classList.remove('hidden')
}

async function addSession() {
  const input     = document.getElementById('input-session-name')
  const tenantEl  = document.getElementById('input-session-tenant')
  const phoneEl   = document.getElementById('input-session-phone')
  const name      = input.value.trim()
  if (!name) return
  // Reserva também respeita o cargo: nunca cair numa empresa que a pessoa não
  // gerencia (o servidor recusaria, mas o erro sairia confuso)
  const tenant_id = tenantEl?.value || AVAILABLE_TENANTS.find(t => canManageTenant(t.id))?.id
  if (!tenant_id) {
    showToast('Você não é administrador nem gestor de nenhuma empresa', 'error')
    return
  }
  const method    = state.connectMethod

  let phone_number = null
  if (method === 'code') {
    phone_number = (phoneEl?.value || '').replace(/\D/g, '')
    if (phone_number.length < 10) {
      showToast('Digite o número completo com DDI + DDD (ex: 5511999998888)', 'error')
      return
    }
  }

  input.value = ''
  if (phoneEl) phoneEl.value = ''
  closeAddModal()

  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...TENANT_HEADERS },
      body: JSON.stringify({ name, tenant_id, phone_number }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `Erro ${res.status}` }))
      showToast('Erro ao conectar: ' + (err.error || res.status), 'error')
      return
    }
    const sess = await res.json()
    state.sessions.push(sess)
    renderSessions()
    openPendingModal(sess.id, name, method)
  } catch (e) {
    showToast('Erro de conexão: ' + e.message, 'error')
  }
}

async function reconnectSession(id, name, forceRelink = false) {
  // Pergunta o método de reconexão — permite reconectar à distância via código
  const method = await showDialog({
    title: forceRelink ? `Vincular ${name} do zero` : `Reconectar ${name}`,
    message: forceRelink
      ? 'A vinculação atual será zerada e você fará uma nova.\nAs conversas e mensagens são preservadas.'
      : 'Como deseja reconectar este número?',
    buttons: [
      { label: '📷 QR Code', value: 'qr', style: 'muted' },
      { label: '🔢 Código (à distância)', value: 'code', style: 'primary' },
    ],
  })
  if (method === null) return

  let phone_number = null
  if (method === 'code') {
    const raw = await showDialog({
      title: 'Número do WhatsApp',
      message: 'Com DDI + DDD, ex: 5511999998888.\nO 9º dígito é corrigido automaticamente.',
      input: { type: 'tel', placeholder: '5561999998888' },
      buttons: [
        { label: 'Cancelar', value: null, style: 'muted' },
        { label: 'Gerar código', style: 'primary' },
      ],
    })
    if (raw === null) return
    phone_number = String(raw).replace(/\D/g, '')
    if (phone_number.length < 10) {
      showToast('Número inválido. Use DDI + DDD + número.', 'error')
      return
    }
  }

  openPendingModal(id, name, method)
  try {
    const res = await fetch(`/api/sessions/${id}/reconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...TENANT_HEADERS },
      body: JSON.stringify({ phone_number, force_relink: forceRelink }),
    })
    if (!res.ok) { const e = await res.json().catch(() => ({})); showToast('Erro: ' + (e.error || res.status), 'error') }
  } catch (e) { showToast('Erro de conexão: ' + e.message, 'error') }
}

/* Saída para quando o "Reconectar" normal não resolve: zera a vinculação e
   começa uma nova. NÃO apaga conversas — antes, a única alternativa nesse
   caso era excluir o número e perder todo o histórico. */
async function relinkSession(id, name) {
  const ok = await showConfirm(
    'Vincular do zero',
    `O número "${name}" será desvinculado e você fará uma nova leitura de QR/código.\n\n` +
    'As conversas e mensagens NÃO são apagadas.',
    'Vincular do zero',
  )
  if (!ok) return
  await reconnectSession(id, name, true)
}

async function removeSession(id) {
  const s = state.sessions.find(x => x.id === id)
  const nome = s?.name || 'este número'
  // Conta o histórico que SERÁ APAGADO — sem esse número o usuário não entende
  // o tamanho do estrago. A perda real de uma cliente com 200 conversas antigas
  // ensinou que só "Tem certeza?" é fraco demais.
  const convs = state.conversations.filter(c => c.session_id === id).length

  const primeiro = await showDialog({
    title: `⚠️ Apagar "${nome}" APAGA todo o histórico`,
    message:
      `Ao continuar, este número será removido do CRC e junto vão:\n` +
      `  • ${convs} conversa(s)\n` +
      `  • TODAS as mensagens dessas conversas\n` +
      `Isso NÃO PODE ser desfeito.\n\n` +
      `Se sua intenção era só reconectar (o número caiu), use:\n` +
      `  • Reconectar (seta circular) — mantém tudo\n` +
      `  • Vincular do zero — se o Reconectar não resolve, mantém tudo`,
    buttons: [
      { label: 'Cancelar', value: null, style: 'muted' },
      { label: 'Entendo, quero continuar', value: 'ok', style: 'danger' },
    ],
  })
  if (primeiro !== 'ok') return

  // Segunda barreira: obrigar digitar a palavra APAGAR — não dá pra clicar
  // errado sem querer, e força o usuário a ler o que vai fazer.
  const digitado = await showDialog({
    title: 'Confirmação final',
    message: `Para apagar "${nome}" e todo o histórico, digite: APAGAR`,
    input: { placeholder: 'APAGAR' },
    buttons: [
      { label: 'Cancelar', value: null, style: 'muted' },
      { label: 'APAGAR AGORA', style: 'danger' },
    ],
  })
  if (String(digitado || '').trim().toUpperCase() !== 'APAGAR') {
    if (digitado !== null) showToast('Não apagou — a palavra digitada não bate', 'info')
    return
  }

  await fetch(`/api/sessions/${id}`, { method: 'DELETE', headers: TENANT_HEADERS })
  state.sessions      = state.sessions.filter(s => s.id !== id)
  state.conversations = state.conversations.filter(c => c.session_id !== id)
  if (state.activeSession?.id === id) selectSession(null)
  renderSessions()
  renderConversations()
  showToast(`"${nome}" apagado`, 'info')
}

async function clearConversations(sessionId) {
  if (!(await showConfirm('Limpar conversas', 'Limpar todas as conversas desta sessão no CRC?\nAs mensagens continuam no WhatsApp normalmente.', 'Limpar', true))) return
  await fetch(`/api/sessions/${sessionId}/conversations`, { method: 'DELETE', headers: TENANT_HEADERS })
  state.conversations = state.conversations.filter(c => c.session_id !== sessionId)
  if (state.activeConversation?.session_id === sessionId) {
    state.activeConversation = null
    document.getElementById('chat-empty').classList.remove('hidden')
    document.getElementById('chat-content').classList.add('hidden')
    if (state.mobileView === 'chat') setMobileView('conversations')
  }
  renderConversations()
  showToast('Conversas limpas com sucesso', 'info')
}

function selectSession(id) {
  state.activeSession = id ? state.sessions.find(s => s.id === id) : null
  document.getElementById('filter-all').classList.toggle('active', !id)
  document.getElementById('conv-panel-title').textContent = state.activeSession ? state.activeSession.name : 'Conversas'
  renderSessions()
  loadConversations()
  setMobileView('conversations')
}

/* ── Conversations ────────────────────────────────────────── */

function renderConversations() {
  const list    = document.getElementById('conversations-list')
  const showTag = !state.activeSession

  if (!state.conversations.length) {
    list.innerHTML = `<div class="empty-state" style="padding:40px 0"><span>Nenhuma conversa</span></div>`
    renderSessions()   // zera os contadores de não lidas
    return
  }

  list.innerHTML = state.conversations.map(c => {
    const isActive = state.activeConversation?.id === c.id && state.activeConversation?.session_id === c.session_id
    const avatarContent = c.profile_pic
      ? `<img src="${esc(c.profile_pic)}" onerror="this.style.display='none'" />${initials(c.name || c.phone)}`
      : initials(c.name || c.phone)
    const sColor = sessionColor(c.session_id)
    return `
    <div class="conv-item ${isActive ? 'active' : ''}"
         style="border-left:3px solid ${sColor}"
         onclick="openConversation('${esc(c.id)}','${c.session_id}')">
      <div class="conv-avatar" style="border:2px solid ${sColor}">${avatarContent}</div>
      <div class="conv-body">
        <div class="conv-top">
          <span class="conv-name">${esc(c.name || c.phone)}</span>
          <span class="conv-time">${formatTime(c.last_message_at)}</span>
        </div>
        ${c.label ? `<span class="conv-label" style="background:${esc(c.label_color || '#666')}">${esc(c.label)}</span>` : ''}
        <div class="conv-bottom">
          <span class="conv-preview">${previewIcon(c.last_message)}${esc(c.last_message || '')}</span>
          <span class="conv-session-tag" style="border-left:2px solid ${sColor};padding-left:5px">${esc(c.session_name)}</span>
          ${c.unread_count > 0 ? `<span class="unread-badge">${c.unread_count}</span>` : ''}
        </div>
      </div>
      <button class="conv-del btn-danger" title="Apagar esta conversa (só do CRC)"
        onclick="event.stopPropagation();deleteConversation('${esc(c.id)}','${c.session_id}')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
      </button>
    </div>`
  }).join('')

  renderSessions()   // mantém os contadores de não lidas por número em sincronia
}

// Apaga uma conversa (só do CRC — não afeta o WhatsApp)
async function deleteConversation(convId, sessionId) {
  if (!(await showConfirm('Apagar conversa', 'Apagar esta conversa do CRC?\nAs mensagens continuam no WhatsApp normalmente.', 'Apagar', true))) return
  try {
    const params = new URLSearchParams({ session_id: sessionId })
    const res = await fetch(`/api/conversations/${encodeURIComponent(convId)}?${params}`, { method: 'DELETE', headers: TENANT_HEADERS })
    if (!res.ok) { const e = await res.json().catch(() => ({})); showToast('Erro: ' + (e.error || res.status), 'error'); return }
    state.conversations = state.conversations.filter(c => !(c.id === convId && c.session_id === sessionId))
    if (state.activeConversation?.id === convId && state.activeConversation?.session_id === sessionId) {
      state.activeConversation = null
      document.getElementById('chat-empty').classList.remove('hidden')
      document.getElementById('chat-content').classList.add('hidden')
      if (state.mobileView === 'chat') setMobileView('conversations')
    }
    renderConversations()
  } catch (e) { showToast('Erro de conexão: ' + e.message, 'error') }
}

// Apaga TODAS as conversas (só do CRC) — respeita o filtro de número selecionado
async function clearAllConversations() {
  const escopo = state.activeSession ? `do número "${state.activeSession.name}"` : 'de TODOS os números'
  if (!(await showConfirm('Apagar todas as conversas', `Apagar todas as conversas ${escopo} no CRC?\nAs mensagens continuam no WhatsApp normalmente.`, 'Apagar tudo', true))) return
  try {
    const params = new URLSearchParams()
    if (state.activeSession) params.set('session_id', state.activeSession.id)
    const res = await fetch(`/api/conversations?${params}`, { method: 'DELETE', headers: TENANT_HEADERS })
    if (!res.ok) { const e = await res.json().catch(() => ({})); showToast('Erro: ' + (e.error || res.status), 'error'); return }
    state.conversations = []
    state.activeConversation = null
    document.getElementById('chat-empty').classList.remove('hidden')
    document.getElementById('chat-content').classList.add('hidden')
    if (state.mobileView === 'chat') setMobileView('conversations')
    renderConversations()
    showToast('Conversas apagadas do CRC', 'info')
  } catch (e) { showToast('Erro de conexão: ' + e.message, 'error') }
}

function previewIcon(msg) {
  if (!msg) return ''
  if (msg.startsWith('[Imagem'))   return '🖼️ '
  if (msg.startsWith('[Vídeo'))    return '🎥 '
  if (msg.startsWith('[Áudio'))    return '🎵 '
  if (msg.startsWith('[Documento'))return '📄 '
  if (msg.startsWith('[Figurinha'))return '🎨 '
  return ''
}

/* ── Chat ─────────────────────────────────────────────────── */

async function openConversation(convId, sessionId) {
  const conv = state.conversations.find(c => c.id === convId && c.session_id === sessionId)
  if (!conv) return
  state.activeConversation = conv
  setMobileView('chat')
  hideQuickReplySuggest()
  cancelReply()
  if (state.editingMessage) cancelEditMessage()
  document.getElementById('scroll-bottom-btn').classList.add('hidden')

  document.getElementById('chat-empty').classList.add('hidden')
  document.getElementById('chat-content').classList.remove('hidden')
  document.getElementById('chat-presence').textContent = ''  // limpa "digitando" anterior
  const sColor = sessionColor(conv.session_id)
  document.getElementById('chat-name').textContent            = conv.name || conv.phone
  document.getElementById('chat-avatar-initials').textContent = initials(conv.name || conv.phone)
  const phoneLabel = conv.phone ? fmtPhone(conv.phone) : 'Número não identificado'
  document.getElementById('chat-meta').innerHTML =
    `${esc(phoneLabel)} · <span style="color:${sColor};font-weight:600">${esc(conv.session_name)}</span>`
  document.getElementById('chat-header').style.borderBottom = `2px solid ${sColor}`

  const phone = (conv.phone || '').replace(/\D/g, '')
  document.getElementById('chat-wa-link').href = phone
    ? `https://web.whatsapp.com/send?phone=${phone}`
    : '#'

  // Foto de perfil no header
  loadProfilePic(conv)

  conv.unread_count = 0
  renderConversations()

  await loadMessages(convId, sessionId)
  document.getElementById('msg-input').focus()
}

// Busca as mensagens do servidor e redesenha a lista — usado ao abrir a
// conversa e no botão de atualizar manual (fallback caso o socket perca
// algum evento em tempo real)
async function loadMessages(convId, sessionId) {
  const params = new URLSearchParams({ session_id: sessionId })
  const res    = await fetch(`/api/conversations/${encodeURIComponent(convId)}/messages?${params}`, { headers: TENANT_HEADERS })
  const msgs   = await res.json()

  const list = document.getElementById('messages-list')
  list.innerHTML = ''
  list.dataset.lastDay = ''   // zera o separador de data pra recontar do zero
  msgs.forEach(m => appendMessage(m))
  scrollToBottom()
  document.getElementById('scroll-bottom-btn').classList.add('hidden')
}

// Botão "Atualizar" no cabeçalho da conversa aberta
async function refreshMessages() {
  const conv = state.activeConversation
  if (!conv) return
  const btn = document.getElementById('chat-refresh-btn')
  btn.classList.add('spinning')
  try {
    await loadMessages(conv.id, conv.session_id)
  } catch (e) {
    showToast('Erro ao atualizar: ' + e.message, 'error')
  } finally {
    btn.classList.remove('spinning')
  }
}

async function loadProfilePic(conv) {
  const img      = document.getElementById('chat-avatar-img')
  const initials = document.getElementById('chat-avatar-initials')

  img.classList.add('hidden')
  img.removeAttribute('src')     // limpa a foto da conversa anterior
  initials.classList.remove('hidden')

  try {
    const res  = await fetch(`/api/conversations/${encodeURIComponent(conv.id)}/profile-picture?session_id=${conv.session_id}`, { headers: TENANT_HEADERS })
    const data = await res.json()
    if (!data.url) return

    // A conversa pode ter mudado enquanto a requisição estava no ar — só aplica
    // se ainda estamos na MESMA conversa (evita foto de um contato aparecer noutro)
    if (!state.activeConversation || state.activeConversation.id !== conv.id) return

    // CRÍTICO: anexar onload/onerror ANTES de setar o src. Se a imagem vier do
    // cache/CDN rápido, o onload dispararia antes do handler existir e a foto
    // ficava carregada mas ESCONDIDA pra sempre (era o bug). Carrega direto do
    // servidor do WhatsApp — nada é baixado pra cá (zero peso no nosso servidor).
    img.onload  = () => { img.classList.remove('hidden'); initials.classList.add('hidden') }
    img.onerror = () => { img.classList.add('hidden');    initials.classList.remove('hidden') }
    img.src = data.url
  } catch (_) { /* sem foto — segue com as iniciais */ }
}

/* ── Etiqueta + anotação da conversa (organização visual — ex: atendente
   responsável, serviço buscado). Puramente local ao CRC, não mexe no WhatsApp. */
const CONV_LABEL_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#64748b']
let convNoteColor = CONV_LABEL_COLORS[0]

function openConvNoteModal() {
  const conv = state.activeConversation
  if (!conv) return
  document.getElementById('convnote-label').value = conv.label || ''
  document.getElementById('convnote-text').value  = conv.note  || ''
  convNoteColor = conv.label_color || CONV_LABEL_COLORS[0]
  renderConvNoteColors()
  document.getElementById('modal-conv-note').classList.remove('hidden')
}

function closeConvNoteModal() { document.getElementById('modal-conv-note').classList.add('hidden') }

function renderConvNoteColors() {
  const wrap = document.getElementById('convnote-color-wrap')
  wrap.innerHTML = CONV_LABEL_COLORS.map(c =>
    `<div class="color-dot ${c === convNoteColor ? 'active' : ''}" style="background:${c}" onclick="pickConvNoteColor('${c}')"></div>`
  ).join('')
}

function pickConvNoteColor(c) { convNoteColor = c; renderConvNoteColors() }

async function saveConvNote() {
  const conv = state.activeConversation
  if (!conv) return
  const label = document.getElementById('convnote-label').value.trim()
  const note  = document.getElementById('convnote-text').value.trim()

  const res = await fetch(`/api/conversations/${encodeURIComponent(conv.id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...TENANT_HEADERS },
    body: JSON.stringify({ session_id: conv.session_id, label, label_color: convNoteColor, note }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return showToast(data.error || 'Erro ao salvar', 'error')

  const idx = state.conversations.findIndex(c => c.id === conv.id && c.session_id === conv.session_id)
  if (idx >= 0) state.conversations[idx] = data
  state.activeConversation = data
  renderConversations()
  closeConvNoteModal()
  showToast('Anotação salva', 'success')
}

function renderMediaContent(msg) {
  const mt = msg.media_type
  const mu = msg.media_url
  if ((mt === 'image' || mt === 'sticker') && mu) {
    const cls = mt === 'sticker' ? 'msg-sticker' : 'msg-media-img'
    let html = `<img src="${mu}" class="${cls}" onclick="openLightbox('${mu}','image')" loading="lazy" />`
    if (msg.body && !['[Imagem]','[Figurinha]'].includes(msg.body))
      html += `<span class="msg-caption">${esc(msg.body)}</span>`
    return html
  }
  if (mt === 'video' && mu) {
    let html = `<video src="${mu}" class="msg-media-video" controls preload="metadata" onclick="event.stopPropagation()"></video>`
    if (msg.body && msg.body !== '[Vídeo]') html += `<span class="msg-caption">${esc(msg.body)}</span>`
    return html
  }
  if (mt === 'audio' && mu) {
    // controls nativos — funciona em todos os browsers modernos com OGG, WebM e MP4
    return `<audio src="${mu}" controls preload="none" style="width:240px;display:block"></audio>`
  }
  if (mt === 'document' && mu) {
    return `<a href="${mu}" class="msg-doc" download target="_blank">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      ${esc(msg.body)}
    </a>`
  }
  // Sem mídia ainda (baixando em background) ou texto puro
  if (mt && !mu) {
    return `<span style="color:var(--text-2);font-size:12px">⏳ ${esc(msg.body)}</span>`
  }
  return esc(msg.body)
}

const EDIT_WINDOW_MS = 15 * 60 * 1000   // mesma janela que o servidor aplica

// "Hoje" / "Ontem" / dd/mm(/aaaa) — usado só no separador entre dias, formatTime cuida do resto
function dateSeparatorLabel(iso) {
  const d     = new Date(iso)
  const now   = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const day   = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diff  = Math.round((today - day) / 86400000)
  if (diff === 0) return 'Hoje'
  if (diff === 1) return 'Ontem'
  return d.toLocaleDateString('pt-BR', {
    day: '2-digit', month: '2-digit',
    year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  })
}

// Insere um separador de dia sempre que a mensagem pertence a um dia diferente
// do último renderizado na lista (guardado em list.dataset — zerado em loadMessages)
function maybeInsertDateSeparator(list, msg) {
  const day = new Date(msg.timestamp).toDateString()
  if (list.dataset.lastDay === day) return
  list.dataset.lastDay = day
  const sep = document.createElement('div')
  sep.className = 'date-separator'
  sep.innerHTML = `<span>${dateSeparatorLabel(msg.timestamp)}</span>`
  list.appendChild(sep)
}

function appendMessage(msg) {
  const list = document.getElementById('messages-list')
  maybeInsertDateSeparator(list, msg)

  const side = msg.from_me ? 'from-me' : 'from-them'
  const div  = document.createElement('div')
  div.className = `msg-group ${side}`
  div.id        = `msg-${msg.id}`

  const statusHtml = msg.from_me
    ? `<span class="msg-status">${statusIcon(msg.status || 'sent')}</span>`
    : ''
  const editedTag = msg.edited ? `<span class="msg-edited-tag">editada</span>` : ''

  // Editar: só texto próprio, sem mídia, dentro da janela de 15min
  const canEdit = msg.from_me && !msg.media_type &&
    (Date.now() - new Date(msg.timestamp).getTime()) < EDIT_WINDOW_MS
  const editBtn = canEdit
    ? `<button class="msg-edit-btn" title="Editar mensagem" data-msg-id="${esc(msg.id)}" data-body="${esc(msg.body)}" onclick="startEditMessage(this.dataset.msgId, this.dataset.body)">
         <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
       </button>`
    : ''

  const replyBtn = `<button class="msg-reply-btn" title="Responder" data-msg-id="${esc(msg.id)}" data-body="${esc(msg.body)}" data-from-me="${msg.from_me ? 1 : 0}" onclick="startReply(this.dataset.msgId, this.dataset.body, this.dataset.fromMe === '1')">
       <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
     </button>`

  const quoteHtml = msg.quoted_id
    ? `<div class="msg-quote" title="Ir para a mensagem citada" onclick="scrollToMessage('${esc(msg.quoted_id)}')">
         <span class="msg-quote-author">${msg.quoted_from_me ? 'Você' : esc(state.activeConversation?.name || state.activeConversation?.phone || '')}</span>
         <span class="msg-quote-text">${esc((msg.quoted_body || '').slice(0, 120))}</span>
       </div>`
    : ''

  div.innerHTML = `
    <div class="msg-bubble">${quoteHtml}${renderMediaContent(msg)}</div>
    <span class="msg-time">${replyBtn}${editBtn}${editedTag}${formatTime(msg.timestamp)}${statusHtml}</span>
  `
  list.appendChild(div)
}

// ✓ enviado | ✓✓ entregue | ✓✓ azul lido
function statusIcon(status) {
  if (status === 'read')
    return `<svg class="tick read" width="16" height="11" viewBox="0 0 16 11" fill="none"><path d="M1 5.5L4 8.5L9.5 2.5" stroke="#53bdeb" stroke-width="1.5" stroke-linecap="round"/><path d="M6 8.5L11.5 2.5" stroke="#53bdeb" stroke-width="1.5" stroke-linecap="round"/></svg>`
  if (status === 'delivered')
    return `<svg class="tick" width="16" height="11" viewBox="0 0 16 11" fill="none"><path d="M1 5.5L4 8.5L9.5 2.5" stroke="#8a8a8a" stroke-width="1.5" stroke-linecap="round"/><path d="M6 8.5L11.5 2.5" stroke="#8a8a8a" stroke-width="1.5" stroke-linecap="round"/></svg>`
  // sent
  return `<svg class="tick" width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1 5.5L4 8.5L10 2" stroke="#8a8a8a" stroke-width="1.5" stroke-linecap="round"/></svg>`
}

/* ── Enviar texto ─────────────────────────────────────────── */

async function sendMessage() {
  const conv  = state.activeConversation
  if (!conv) return

  // Editando uma mensagem existente em vez de mandar uma nova
  if (state.editingMessage) { await confirmEditMessage(); return }

  // Se há arquivo pendente, envia o arquivo
  if (state.pendingFile) { await sendPendingFile(); return }

  const input = document.getElementById('msg-input')
  const text  = input.value.trim()
  if (!text) return

  const btn = document.getElementById('send-btn')
  const quotedId = state.replyingTo?.id || null
  btn.disabled = true
  input.value  = ''
  autoResize(input)
  hideQuickReplySuggest()
  cancelReply()

  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(conv.id)}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...TENANT_HEADERS },
      body: JSON.stringify({ body: text, session_id: conv.session_id, quoted_id: quotedId }),
    })
    if (!res.ok) {
      const e = await res.json().catch(() => ({}))
      showToast(`Erro ${res.status}: ${e.error || 'falha ao enviar'}`, 'error')
    }
  } catch (e) {
    showToast('Erro de conexão: ' + e.message, 'error')
  } finally {
    btn.disabled = false
    input.focus()
  }
}

function onMsgKeydown(e) {
  if (quickReplySuggestItems.length) {
    if (e.key === 'ArrowDown') { e.preventDefault(); quickReplyActiveIndex = Math.min(quickReplyActiveIndex + 1, quickReplySuggestItems.length - 1); highlightQuickReplySuggest(); return }
    if (e.key === 'ArrowUp')   { e.preventDefault(); quickReplyActiveIndex = Math.max(quickReplyActiveIndex - 1, 0); highlightQuickReplySuggest(); return }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickQuickReplySuggest(quickReplyActiveIndex); return }
    if (e.key === 'Escape') { hideQuickReplySuggest(); return }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  if (e.key === 'Escape' && state.editingMessage) { cancelEditMessage() }
  if (e.key === 'Escape' && state.replyingTo)     { cancelReply() }
}

/* ── Respostas rápidas (atalhos "/nome" que expandem pra texto pronto) ──
   Compartilhadas por empresa: qualquer pessoa da equipe da mesma empresa
   vê e usa as mesmas. Digitar "/algo" na caixa de mensagem abre o dropdown. */

async function loadQuickReplies() {
  const res = await fetch('/api/quick-replies', { headers: TENANT_HEADERS })
  if (!res.ok) { state.quickReplies = []; return }
  state.quickReplies = await res.json()
}

let editingQuickReplyId = null   // id da resposta rápida em edição, ou null (criando nova)

function openQuickRepliesModal() {
  const sel = document.getElementById('qreply-tenant')
  sel.innerHTML = AVAILABLE_TENANTS.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')
  document.getElementById('qreply-tenant-wrap').classList.toggle('hidden', AVAILABLE_TENANTS.length <= 1)
  cancelEditQuickReply()
  renderQuickRepliesList()
  document.getElementById('modal-quick-replies').classList.remove('hidden')
}

function closeQuickRepliesModal() {
  document.getElementById('modal-quick-replies').classList.add('hidden')
}

function renderQuickRepliesList() {
  const list = document.getElementById('qreply-list')
  if (!state.quickReplies.length) {
    list.innerHTML = '<p class="text-muted" style="font-size:12px;padding:8px 0">Nenhuma resposta rápida ainda.</p>'
    return
  }
  list.innerHTML = state.quickReplies.map(qr => `
    <div class="qreply-item">
      <div class="qreply-item-text">
        <strong>/${esc(qr.shortcut)}</strong>${AVAILABLE_TENANTS.length > 1 ? `<span class="text-muted" style="font-size:11px"> · ${esc(TENANT_NAMES[qr.tenant_id] || '')}</span>` : ''}
        <p>${esc(qr.message)}</p>
      </div>
      <div style="display:flex;gap:2px;flex-shrink:0">
        <button class="btn-muted" title="Editar" onclick="editQuickReply('${qr.id}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        </button>
        <button class="btn-danger" title="Excluir" onclick="deleteQuickReply('${qr.id}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </div>
    </div>
  `).join('')
}

function editQuickReply(id) {
  const qr = state.quickReplies.find(q => q.id === id)
  if (!qr) return
  editingQuickReplyId = id
  document.getElementById('qreply-tenant').value   = qr.tenant_id
  document.getElementById('qreply-shortcut').value = qr.shortcut
  document.getElementById('qreply-message').value  = qr.message
  document.getElementById('qreply-submit-btn').textContent = 'Salvar edição'
  document.getElementById('qreply-cancel-btn').classList.remove('hidden')
  document.getElementById('qreply-shortcut').focus()
}

function cancelEditQuickReply() {
  editingQuickReplyId = null
  document.getElementById('qreply-shortcut').value = ''
  document.getElementById('qreply-message').value  = ''
  document.getElementById('qreply-submit-btn').textContent = 'Salvar'
  document.getElementById('qreply-cancel-btn').classList.add('hidden')
}

async function submitQuickReply() {
  const shortcut = document.getElementById('qreply-shortcut').value
  const message  = document.getElementById('qreply-message').value
  if (!shortcut.trim() || !message.trim()) return showToast('Preencha atalho e mensagem', 'error')

  let res
  if (editingQuickReplyId) {
    res = await fetch(`/api/quick-replies/${editingQuickReplyId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...TENANT_HEADERS },
      body: JSON.stringify({ shortcut, message }),
    })
  } else {
    const tenant_id = document.getElementById('qreply-tenant').value
    res = await fetch('/api/quick-replies', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...TENANT_HEADERS },
      body: JSON.stringify({ tenant_id, shortcut, message }),
    })
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return showToast(data.error || 'Erro ao salvar', 'error')

  const wasEditing = !!editingQuickReplyId
  cancelEditQuickReply()
  await loadQuickReplies()
  renderQuickRepliesList()
  showToast(wasEditing ? 'Resposta rápida atualizada' : 'Resposta rápida salva', 'success')
}

async function deleteQuickReply(id) {
  const ok = await showConfirm('Excluir resposta rápida', 'Essa ação não pode ser desfeita.', 'Excluir', true)
  if (!ok) return
  if (editingQuickReplyId === id) cancelEditQuickReply()
  await fetch(`/api/quick-replies/${id}`, { method: 'DELETE', headers: TENANT_HEADERS })
  await loadQuickReplies()
  renderQuickRepliesList()
}

/* ── Autocomplete no campo de mensagem ── */
let quickReplySuggestItems = []
let quickReplyActiveIndex  = -1

function onMsgInput(el) {
  const match = /^\/([a-z0-9_-]{0,40})$/i.exec(el.value)
  if (!match) { hideQuickReplySuggest(); return }

  const conv     = state.activeConversation
  const tenantId = conv ? state.sessions.find(s => s.id === conv.session_id)?.tenant_id : null
  const q        = match[1].toLowerCase()
  const matches  = state.quickReplies
    .filter(qr => (!tenantId || qr.tenant_id === tenantId) && qr.shortcut.startsWith(q))
    .slice(0, 6)

  if (!matches.length) { hideQuickReplySuggest(); return }
  renderQuickReplySuggest(matches)
}

function renderQuickReplySuggest(items) {
  quickReplySuggestItems = items
  quickReplyActiveIndex  = 0
  const box = document.getElementById('qreply-suggest')
  box.innerHTML = items.map((qr, i) => `
    <div class="qreply-suggest-item ${i === 0 ? 'active' : ''}" data-i="${i}" onmousedown="event.preventDefault();pickQuickReplySuggest(${i})">
      <strong>/${esc(qr.shortcut)}</strong>
      <span>${esc(qr.message.slice(0, 60))}</span>
    </div>
  `).join('')
  box.classList.remove('hidden')
}

function highlightQuickReplySuggest() {
  document.querySelectorAll('.qreply-suggest-item').forEach((el, i) => el.classList.toggle('active', i === quickReplyActiveIndex))
}

function hideQuickReplySuggest() {
  quickReplySuggestItems = []
  quickReplyActiveIndex  = -1
  const box = document.getElementById('qreply-suggest')
  if (box) box.classList.add('hidden')
}

function pickQuickReplySuggest(i) {
  const qr = quickReplySuggestItems[i]
  if (!qr) return
  const input = document.getElementById('msg-input')
  input.value = qr.message
  autoResize(input)
  hideQuickReplySuggest()
  input.focus()
}

/* ── Editar mensagem enviada (estilo WhatsApp) ───────────────
   Clique no lápis que aparece ao passar o mouse numa mensagem sua (só texto,
   até 15min) — preenche o campo de digitação em "modo edição"; Enter confirma,
   Esc cancela. */
function startEditMessage(msgId, currentBody) {
  const conv = state.activeConversation
  if (!conv) return
  state.editingMessage = { id: msgId }
  const input = document.getElementById('msg-input')
  input.value = currentBody
  autoResize(input)
  input.focus()
  document.getElementById('edit-banner').classList.remove('hidden')
}

function cancelEditMessage() {
  state.editingMessage = null
  const input = document.getElementById('msg-input')
  input.value = ''
  autoResize(input)
  document.getElementById('edit-banner').classList.add('hidden')
}

async function confirmEditMessage() {
  const conv  = state.activeConversation
  const edit  = state.editingMessage
  if (!conv || !edit) return
  const input = document.getElementById('msg-input')
  const text  = input.value.trim()
  if (!text) return

  const btn = document.getElementById('send-btn')
  btn.disabled = true
  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(conv.id)}/messages/${encodeURIComponent(edit.id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...TENANT_HEADERS },
      body: JSON.stringify({ body: text, session_id: conv.session_id }),
    })
    if (!res.ok) {
      const e = await res.json().catch(() => ({}))
      showToast(e.error || 'Erro ao editar', 'error')
      return   // mantém o modo edição pro usuário tentar de novo/cancelar
    }
    cancelEditMessage()
  } catch (e) {
    showToast('Erro de conexão: ' + e.message, 'error')
  } finally {
    btn.disabled = false
    input.focus()
  }
}

/* ── Enviar arquivo ───────────────────────────────────────── */

function onFileSelected(input) {
  const file = input.files[0]
  if (!file) return
  state.pendingFile = file
  showFilePreview(file)
  input.value = '' // reset para permitir selecionar o mesmo arquivo novamente
}

function showFilePreview(file) {
  // Injeta preview bar acima do input se ainda não existir
  let bar = document.getElementById('file-preview')
  if (!bar) {
    bar = document.createElement('div')
    bar.id = 'file-preview'
    document.getElementById('chat-input-area').before(bar)
  }
  bar.classList.remove('hidden')

  let thumb = ''
  if (file.type.startsWith('image/')) {
    const url = URL.createObjectURL(file)
    thumb = `<img src="${url}" />`
  } else if (file.type.startsWith('video/')) {
    thumb = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:#888"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`
  } else if (file.type.startsWith('audio/')) {
    thumb = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:#888"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`
  } else {
    thumb = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:#888"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`
  }

  bar.innerHTML = `
    ${thumb}
    <span id="file-preview-name">${esc(file.name)} <span style="color:#555">(${formatBytes(file.size)})</span></span>
    <button id="file-preview-cancel" onclick="cancelFile()" title="Cancelar">✕</button>
    <button id="file-preview-send" onclick="sendPendingFile()">Enviar</button>
  `
}

function cancelFile() {
  state.pendingFile = null
  const bar = document.getElementById('file-preview')
  if (bar) bar.classList.add('hidden')
}

async function sendPendingFile() {
  const conv = state.activeConversation
  const file = state.pendingFile
  if (!conv || !file) return

  const btn = document.getElementById('file-preview-send')
  if (btn) btn.disabled = true

  const fd = new FormData()
  fd.append('file', file)
  fd.append('session_id', conv.session_id)

  const caption = document.getElementById('msg-input').value.trim()
  if (caption) fd.append('caption', caption)

  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(conv.id)}/media`, {
      method: 'POST', headers: TENANT_HEADERS, body: fd,
    })
    if (!res.ok) { const e = await res.json(); showToast('Erro ao enviar: ' + e.error, 'error') }
    else {
      document.getElementById('msg-input').value = ''
      autoResize(document.getElementById('msg-input'))
    }
  } catch (e) {
    showToast('Erro de conexão: ' + e.message, 'error')
  } finally {
    cancelFile()
    document.getElementById('msg-input').focus()
  }
}

/* ── Áudio (gravar) ───────────────────────────────────────── */

let mediaRecorder   = null
let audioChunks     = []
let recordingStream = null
let recordingConv   = null   // conversa capturada no INÍCIO da gravação

async function startRecording(e) {
  if (e) e.preventDefault()

  // Anti-zumbi: se sobrou um gravador ativo de um clique anterior (ex: soltou o
  // mouse FORA do botão e o stop nunca disparou), ele continuaria despejando
  // pedaços SEM cabeçalho na próxima gravação — o WebM chegava "começando no
  // meio" e a conversão falhava. Mata qualquer gravador/stream anterior.
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.ondataavailable = null; mediaRecorder.onstop = null; mediaRecorder.stop() } catch (_) {}
  }
  recordingStream?.getTracks().forEach(t => t.stop())

  // Captura a conversa AGORA — antes de qualquer await
  recordingConv = state.activeConversation
  if (!recordingConv) return

  console.log('[rec] iniciando para', recordingConv.id, '| session:', recordingConv.session_id)

  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true })

    // Ordem de preferência por navegador: Chrome/Firefox gravam WebM/Opus;
    // Safari/iPad (WebKit) só grava MP4/AAC — e mente se pedirem webm.
    // Sem formato suportado, deixa o navegador escolher o padrão dele.
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
    const mimeType = candidates.find(m => MediaRecorder.isTypeSupported(m))

    const rec    = mimeType ? new MediaRecorder(recordingStream, { mimeType }) : new MediaRecorder(recordingStream)
    const chunks = []          // LOCAL desta gravação — zumbi nenhum escreve aqui
    const stream = recordingStream
    const conv   = recordingConv
    mediaRecorder = rec

    rec.ondataavailable = ev => { if (ev.data.size > 0) chunks.push(ev.data) }

    rec.onstop = async () => {
      // usa o mime REAL do gravador (Safari pode divergir do pedido)
      const actualMime = rec.mimeType || mimeType || 'audio/webm'
      const blob = new Blob(chunks, { type: actualMime })
      const ext  = actualMime.includes('mp4') ? 'm4a' : actualMime.includes('ogg') ? 'ogg' : 'webm'
      const file = new File([blob], `audio_${Date.now()}.${ext}`, { type: actualMime })

      console.log('[rec] gravação finalizada | size:', blob.size, '| mime:', actualMime,
                  '| conv:', conv?.id, '| session:', conv?.session_id)

      stream.getTracks().forEach(t => t.stop())
      if (blob.size < 500) { console.warn('[rec] áudio muito curto, ignorando'); return }
      await sendAudioFile(file, conv)
    }

    rec.start(250)  // coleta dados a cada 250ms
    document.getElementById('mic-btn').classList.add('recording')
  } catch (err) {
    console.error('[rec] erro:', err)
    showToast('Microfone: ' + err.message, 'error')
    recordingConv = null
  }
}

function stopRecording(e) {
  if (e) e.preventDefault()
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
  }
  document.getElementById('mic-btn').classList.remove('recording')
}

// Rede de segurança: soltar o botão FORA dele (arrastou o dedo/mouse) também
// encerra a gravação — sem isso o gravador virava zumbi e corrompia a próxima
document.addEventListener('mouseup',    () => stopRecording())
document.addEventListener('touchend',   () => stopRecording())
document.addEventListener('touchcancel',() => stopRecording())

// Mostra/esconde o botão "ir pro fim" conforme a posição do scroll
document.getElementById('messages-list').addEventListener('scroll', () => {
  const list = document.getElementById('messages-list')
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 150
  document.getElementById('scroll-bottom-btn').classList.toggle('hidden', nearBottom)
})

/* ── Pressionar e segurar numa mensagem → menu "Copiar" / "Editar" ──
   No celular não existe hover, então o toque longo é o jeito nativo de
   acessar ações da mensagem (igual WhatsApp de verdade). No desktop, o
   botão direito faz a mesma coisa. */
let msgPressTimer  = null
let msgPressTarget = null

function findMsgGroup(el) { return el.closest('.msg-group') }

document.getElementById('messages-list').addEventListener('touchstart', (e) => {
  const group = findMsgGroup(e.target)
  if (!group) return
  msgPressTarget = group
  msgPressTimer = setTimeout(() => {
    if (navigator.vibrate) navigator.vibrate(15)   // feedback tátil, se o aparelho suportar
    openMessageMenu(group, e.touches[0].clientX, e.touches[0].clientY)
  }, 450)
}, { passive: true })

document.getElementById('messages-list').addEventListener('touchend',  () => clearTimeout(msgPressTimer))
document.getElementById('messages-list').addEventListener('touchmove', () => clearTimeout(msgPressTimer))

// Desktop: botão direito abre o mesmo menu, sem precisar segurar
document.getElementById('messages-list').addEventListener('contextmenu', (e) => {
  const group = findMsgGroup(e.target)
  if (!group) return
  e.preventDefault()
  openMessageMenu(group, e.clientX, e.clientY)
})

function openMessageMenu(group, x, y) {
  closeMessageMenu()
  const msgId  = group.id.replace('msg-', '')
  const bubble = group.querySelector('.msg-bubble')
  const text   = bubble?.textContent || ''
  const editBtn = group.querySelector('.msg-edit-btn')   // só existe se for editável (from_me, texto, <15min)

  const menu = document.createElement('div')
  menu.id = 'msg-context-menu'
  menu.className = 'msg-context-menu'
  menu.innerHTML = `
    <button data-action="copy">📋 Copiar texto</button>
    ${editBtn ? `<button data-action="edit">✏️ Editar</button>` : ''}
  `
  document.body.appendChild(menu)

  // Posiciona sem estourar a tela
  const maxX = window.innerWidth  - menu.offsetWidth  - 8
  const maxY = window.innerHeight - menu.offsetHeight - 8
  menu.style.left = Math.min(x, maxX) + 'px'
  menu.style.top  = Math.min(y, maxY) + 'px'

  menu.addEventListener('click', (e) => {
    const action = e.target.closest('button')?.dataset.action
    if (action === 'copy') {
      navigator.clipboard?.writeText(text).then(
        () => showToast('Texto copiado', 'info'),
        () => showToast('Não foi possível copiar', 'error')
      )
    } else if (action === 'edit' && editBtn) {
      editBtn.click()   // reaproveita a mesma lógica do lápis
    }
    closeMessageMenu()
  })

  setTimeout(() => document.addEventListener('click', closeMessageMenuOnce), 0)
}
function closeMessageMenuOnce(e) {
  if (!e.target.closest('#msg-context-menu')) closeMessageMenu()
}
function closeMessageMenu() {
  document.getElementById('msg-context-menu')?.remove()
  document.removeEventListener('click', closeMessageMenuOnce)
}

async function sendAudioFile(file, conv) {
  if (!conv) { console.error('[audio] conv is null'); return }

  const fd = new FormData()
  fd.append('file', file)
  fd.append('session_id', conv.session_id)

  console.log('[audio] enviando para', conv.id, '| session:', conv.session_id, '| size:', file.size)

  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(conv.id)}/media`, {
      method: 'POST', headers: TENANT_HEADERS, body: fd,
    })
    if (!res.ok) {
      const err = await res.json()
      console.error('[audio] erro do servidor:', err)
      showToast('Erro ao enviar áudio: ' + err.error, 'error')
    }
  } catch (err) {
    console.error('[audio] erro de rede:', err)
    showToast('Erro de conexão: ' + err.message, 'error')
  }
}

/* ── Lightbox ─────────────────────────────────────────────── */

function openLightbox(url, type) {
  const content = document.getElementById('lightbox-content')
  content.innerHTML = type === 'image'
    ? `<img src="${url}" onclick="event.stopPropagation()" />`
    : `<video src="${url}" controls autoplay onclick="event.stopPropagation()"></video>`
  document.getElementById('lightbox').classList.remove('hidden')
}

function closeLightbox() {
  document.getElementById('lightbox').classList.add('hidden')
  document.getElementById('lightbox-content').innerHTML = ''
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeLightbox(); closeQrModal(); closeAddModal() } })

/* ── Busca ────────────────────────────────────────────────── */

let searchTimer = null
let searchQuery = ''
function onSearch(val) {
  searchQuery = val
  clearTimeout(searchTimer)
  searchTimer = setTimeout(loadConversations, 300)
}

async function loadConversations() {
  const params = new URLSearchParams()
  if (state.activeSession) params.set('session_id', state.activeSession.id)
  if (searchQuery)         params.set('search', searchQuery)
  const res = await fetch(`/api/conversations?${params}`, { headers: TENANT_HEADERS })
  if (!res.ok) { if (handleAuthFailure(res)) return; state.conversations = []; renderConversations(); return }
  state.conversations = await res.json()
  renderConversations()
}

// Botão "Atualizar todas as conversas" — recarrega TUDO (ignora o filtro de
// número atual), conta quantas conversas têm mensagem nova desde a última
// vez, e se a conversa aberta também mudou, recarrega ela também.
async function refreshAllConversations() {
  const btn = document.getElementById('btn-refresh-all')
  btn.classList.add('spinning')
  try {
    const [convRes] = await Promise.all([
      fetch('/api/conversations', { headers: TENANT_HEADERS }),
      loadSessions(),
    ])
    if (!convRes.ok) { if (handleAuthFailure(convRes)) return; showToast('Erro ao atualizar', 'error'); return }
    const freshAll = await convRes.json()

    // Compara com o que já tínhamos pra contar o que é realmente novo
    const prevByKey = new Map(state.conversations.map(c => [`${c.id}|${c.session_id}`, c]))
    let newCount = 0
    for (const c of freshAll) {
      const prev = prevByKey.get(`${c.id}|${c.session_id}`)
      if (!prev || new Date(c.last_message_at) > new Date(prev.last_message_at || 0)) newCount++
    }

    // Reaplica o filtro/busca atual (a API acima trouxe tudo, sem filtro)
    const q = searchQuery.trim().toLowerCase()
    state.conversations = freshAll.filter(c => {
      if (state.activeSession && c.session_id !== state.activeSession.id) return false
      if (q && !(c.name || c.phone || '').toLowerCase().includes(q)) return false
      return true
    })
    renderConversations()

    // Se a conversa aberta também recebeu mensagem, atualiza ela na hora
    if (state.activeConversation) {
      await loadMessages(state.activeConversation.id, state.activeConversation.session_id)
    }

    showToast(newCount > 0 ? `${newCount} conversa(s) com mensagem nova` : 'Tudo atualizado, nada de novo', 'info')
  } catch (e) {
    showToast('Erro de conexão: ' + e.message, 'error')
  } finally {
    btn.classList.remove('spinning')
  }
}

/* ── Modais ───────────────────────────────────────────────── */

function openAddModal() {
  // Só lista as empresas onde a pessoa é admin/gestor. Antes vinham TODAS as
  // empresas dela: quem é gestor de uma e vendedor de outra via as duas e só
  // descobria a restrição ao tentar (o servidor recusa) — armadilha à toa.
  const gerenciaveis = AVAILABLE_TENANTS.filter(t => canManageTenant(t.id))
  const sel  = document.getElementById('input-session-tenant')
  const wrap = document.getElementById('tenant-selector-wrap')
  sel.innerHTML = gerenciaveis.map(t =>
    `<option value="${t.id}">${esc(t.name)}</option>`
  ).join('')
  // Mostra sempre que houver ao menos UMA empresa gerenciável — mesmo com uma
  // só, é importante ver PARA QUAL empresa o número está indo (antes sumia
  // quando havia apenas uma, deixando a pessoa no escuro). Sem nenhuma, some
  // (e o botão de adicionar nem aparece).
  wrap.style.display = gerenciaveis.length > 0 ? 'flex' : 'none'
  wrap.style.flexDirection = 'column'
  wrap.style.gap = '4px'

  setConnectMethod('qr')  // sempre reabre no método padrão (QR)

  document.getElementById('modal-add').classList.remove('hidden')
  setTimeout(() => document.getElementById('input-session-name').focus(), 50)
}
function closeAddModal() { document.getElementById('modal-add').classList.add('hidden') }
function closeQrModal()  { state.pendingQrSession = null; document.getElementById('modal-qr').classList.add('hidden') }
function resetQrModal()  {
  document.getElementById('qr-wrapper').innerHTML = `
    <div class="qr-placeholder"><div class="spinner"></div><span>Aguardando QR Code…</span></div>`
}

document.addEventListener('click', e => {
  if (e.target.id === 'modal-add') closeAddModal()
  if (e.target.id === 'modal-qr')  closeQrModal()
})

/* ── Helpers ──────────────────────────────────────────────── */

function scrollToBottom(smooth = false) {
  const list = document.getElementById('messages-list')
  if (smooth) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' })
  else        list.scrollTop = list.scrollHeight
  document.getElementById('scroll-bottom-btn').classList.add('hidden')
}

// Pula pra uma mensagem já renderizada (usado ao clicar numa citação) e pisca
// a bolha pra ajudar a achar visualmente
function scrollToMessage(msgId) {
  const el = document.getElementById(`msg-${msgId}`)
  if (!el) { showToast('Mensagem citada não está carregada aqui', 'info'); return }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  const bubble = el.querySelector('.msg-bubble')
  bubble.classList.remove('flash-highlight')
  void bubble.offsetWidth   // força reflow pra reiniciar a animação se já rodou antes
  bubble.classList.add('flash-highlight')
}

/* ── Responder citando mensagem ── */
function startReply(msgId, body, fromMe) {
  state.replyingTo = { id: msgId, body, fromMe: !!fromMe }
  document.getElementById('reply-banner-author').textContent = fromMe ? 'Respondendo a você' : 'Respondendo'
  document.getElementById('reply-banner-body').textContent   = body
  document.getElementById('reply-banner').classList.remove('hidden')
  document.getElementById('msg-input').focus()
}

function cancelReply() {
  state.replyingTo = null
  document.getElementById('reply-banner').classList.add('hidden')
}

function autoResize(el) {
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 120) + 'px'
}

function esc(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;')
}

function initials(name) {
  if (!name) return '?'
  const parts = String(name).trim().split(/\s+/)
  return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : parts[0].slice(0, 2).toUpperCase()
}

// Formata número BR pra leitura: 5561981793632 → +55 (61) 98179-3632
function fmtPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '')
  if (!d) return ''
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4), rest = d.slice(4)
    const meio = rest.length === 9 ? `${rest.slice(0, 5)}-${rest.slice(5)}` : `${rest.slice(0, 4)}-${rest.slice(4)}`
    return `+55 (${ddd}) ${meio}`
  }
  return '+' + d   // outros países: mostra com + na frente
}

const COLORS = ['#16a34a','#0891b2','#7c3aed','#db2777','#ea580c','#ca8a04','#059669']
function avatarColor(name) {
  if (!name) return COLORS[0]
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff
  return COLORS[Math.abs(h) % COLORS.length]
}

// Cor fixa por sessão — facilita identificar qual número está respondendo
const SESSION_PALETTE = ['#22c55e','#3b82f6','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6']
function sessionColor(sessionId) {
  const idx = state.sessions.findIndex(s => s.id === sessionId)
  return SESSION_PALETTE[(idx >= 0 ? idx : 0) % SESSION_PALETTE.length]
}

function statusLabel(s) {
  return { connected: 'Conectado', connecting: 'Conectando…', disconnected: 'Desconectado' }[s] || s
}

function formatTime(iso) {
  if (!iso) return ''
  const d     = new Date(iso)
  const now   = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const msgDay= new Date(d.getFullYear(), d.getMonth(), d.getDate())
  if (msgDay.getTime() === today.getTime())
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const diff = Math.floor((today - msgDay) / 86400000)
  if (diff === 1) return 'Ontem'
  if (diff < 7)  return d.toLocaleDateString('pt-BR', { weekday: 'short' })
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
}

function formatBytes(b) {
  if (b < 1024)       return b + ' B'
  if (b < 1024*1024)  return (b/1024).toFixed(0) + ' KB'
  return (b/1024/1024).toFixed(1) + ' MB'
}

/* ── Toast ────────────────────────────────────────────────── */

/* ── Diálogos estilizados (substituem alert/confirm/prompt nativos) ── */
function showDialog({ title, message, input = null, buttons }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
      <div class="modal-box dialog-box">
        <div class="modal-header"><span>${esc(title)}</span></div>
        <div class="modal-body">
          ${message ? `<p class="dialog-msg">${esc(message).replace(/\n/g, '<br>')}</p>` : ''}
          ${input ? `<input id="dialog-input" class="field-input" type="${input.type || 'text'}"
                       placeholder="${esc(input.placeholder || '')}" value="${esc(input.value || '')}" />` : ''}
          <div class="dialog-actions">
            ${buttons.map((b, i) => `<button class="dialog-btn dialog-${b.style || 'muted'}" data-i="${i}">${esc(b.label)}</button>`).join('')}
          </div>
        </div>
      </div>`
    const done = v => { overlay.remove(); resolve(v) }
    overlay.addEventListener('click', e => {
      if (e.target === overlay) return done(null)
      const btn = e.target.closest('.dialog-btn')
      if (!btn) return
      const b = buttons[+btn.dataset.i]
      const inputVal = overlay.querySelector('#dialog-input')?.value ?? null
      done(b.value !== undefined ? b.value : inputVal)
    })
    document.body.appendChild(overlay)
    const inp = overlay.querySelector('#dialog-input')
    if (inp) { inp.focus(); inp.addEventListener('keydown', e => { if (e.key === 'Enter') done(inp.value) }) }
  })
}

// Confirmação simples: resolve true só se o usuário confirmar
async function showConfirm(title, message, confirmLabel = 'Confirmar', danger = false) {
  const r = await showDialog({
    title, message,
    buttons: [
      { label: 'Cancelar', value: false, style: 'muted' },
      { label: confirmLabel, value: true, style: danger ? 'danger' : 'primary' },
    ],
  })
  return r === true
}

function showToast(msg, type = 'info') {
  const toast = document.createElement('div')
  toast.textContent = msg
  toast.style.cssText = `
    position:fixed;bottom:24px;right:24px;z-index:9999;
    background:${type === 'error' ? '#ef4444' : type === 'info' ? '#3b82f6' : '#22c55e'};
    color:#fff;padding:10px 16px;border-radius:8px;
    font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.4);
    animation:fadeInUp .2s ease;max-width:320px;word-break:break-word;
  `
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), 4000)
}

/* ── Novo contato (mandar msg pra número que nunca escreveu) ── */
let ncCheckedRaw     = null   // dígitos brutos que foram verificados (o que o usuário digitou)
let ncCheckedCanonical = null // formato canônico devolvido pelo servidor (o que é enviado de fato)

function openNewContactModal() {
  const sel = document.getElementById('nc-session')
  const connected = state.sessions.filter(s => s.status === 'connected')
  sel.innerHTML = connected.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')
    || '<option value="">Nenhum número conectado</option>'

  document.getElementById('nc-phone').value   = ''
  document.getElementById('nc-message').value = ''
  document.getElementById('nc-status').innerHTML = ''
  ncCheckedRaw = null
  ncCheckedCanonical = null
  updateNcButton('idle')

  document.getElementById('modal-new-contact').classList.remove('hidden')
  setTimeout(() => document.getElementById('nc-phone').focus(), 50)
}
function closeNewContactModal() { document.getElementById('modal-new-contact').classList.add('hidden') }

function updateNcButton(mode) {
  const btn = document.getElementById('nc-submit-btn')
  if (mode === 'checking') { btn.textContent = 'Verificando…'; btn.disabled = true }
  else if (mode === 'ready') { btn.textContent = 'Enviar mensagem'; btn.disabled = false }
  else if (mode === 'sending') { btn.textContent = 'Enviando…'; btn.disabled = true }
  else { btn.textContent = 'Verificar e enviar'; btn.disabled = false }
}

// Verifica se o número existe no WhatsApp; se sim, já habilita o envio direto
async function checkNewContactNumber() {
  const raw = document.getElementById('nc-phone').value
  const digits = raw.replace(/\D/g, '')
  const statusEl = document.getElementById('nc-status')
  if (digits.length < 10) { statusEl.innerHTML = `<span style="color:#ef4444;font-size:12px">Número incompleto</span>`; return }

  updateNcButton('checking')
  statusEl.innerHTML = `<span class="text-muted" style="font-size:12px">Verificando no WhatsApp…</span>`
  try {
    const res = await fetch(`/api/check-number?phone=${digits}`, { headers: TENANT_HEADERS })
    const data = await res.json()
    if (!res.ok) { statusEl.innerHTML = `<span style="color:#ef4444;font-size:12px">${esc(data.error || 'Erro')}</span>`; updateNcButton('idle'); return }
    if (!data.exists) {
      statusEl.innerHTML = `<span style="color:#ef4444;font-size:12px">✕ Esse número não tem WhatsApp</span>`
      ncCheckedRaw = null
      ncCheckedCanonical = null
      updateNcButton('idle')
      return
    }
    ncCheckedRaw = digits
    ncCheckedCanonical = data.phone
    statusEl.innerHTML = `<span style="color:var(--green);font-size:12px">✓ Número válido no WhatsApp</span>`
    updateNcButton('ready')
  } catch (e) {
    statusEl.innerHTML = `<span style="color:#ef4444;font-size:12px">Erro de conexão: ${esc(e.message)}</span>`
    updateNcButton('idle')
  }
}

// Botão único: 1º clique verifica, 2º clique (já verificado) envia
async function sendToNewContact() {
  const sessionId = document.getElementById('nc-session').value
  const message    = document.getElementById('nc-message').value.trim()
  const rawPhone   = document.getElementById('nc-phone').value.replace(/\D/g, '')

  if (!sessionId) { showToast('Nenhum número conectado disponível', 'error'); return }
  if (!message)   { showToast('Digite uma mensagem', 'error'); return }

  // Se o número digitado mudou desde a última verificação, verifica de novo antes de enviar
  if (ncCheckedRaw === null || ncCheckedRaw !== rawPhone) {
    if (rawPhone.length < 10) { showToast('Número inválido', 'error'); return }
    await checkNewContactNumber()
    return   // só envia no próximo clique, já com o resultado da checagem
  }

  updateNcButton('sending')
  try {
    const res = await fetch('/api/send-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...TENANT_HEADERS },
      body: JSON.stringify({ session_id: sessionId, phone: ncCheckedCanonical, message }),
    })
    const data = await res.json()
    if (!res.ok) { showToast('Erro ao enviar: ' + (data.error || res.status), 'error'); updateNcButton('ready'); return }
    showToast('Mensagem enviada!', 'info')
    closeNewContactModal()
    loadConversations()
  } catch (e) {
    showToast('Erro de conexão: ' + e.message, 'error')
    updateNcButton('ready')
  }
}

/* ── Start ────────────────────────────────────────────────── */
// init() agora é chamado por bootFromSession(), só depois do login confirmado
