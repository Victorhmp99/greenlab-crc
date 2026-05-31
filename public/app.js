/* ═══════════════════════════════════════════════════════════
   CRC Green Lab — Frontend
   ═══════════════════════════════════════════════════════════ */

// Lê todos os tenants e o usuário atual da URL (passados pelo CRM)
const _params      = new URLSearchParams(window.location.search)
const TENANT_ID    = _params.get('tenant_id') || 'default'
const CURRENT_USER = _params.get('user_id') || ''
const _rawNames    = (_params.get('tenant_names') || '').split(',').map(s => decodeURIComponent(s)).filter(Boolean)
const _ids         = TENANT_ID === 'all' ? [] : TENANT_ID.split(',').filter(Boolean)

// Mapa: tenant_id → nome da empresa
const TENANT_NAMES = {}
_ids.forEach((id, i) => { TENANT_NAMES[id] = _rawNames[i] || id.slice(0, 8) })

// Segredo compartilhado com o servidor (injetado via meta tag em produção)
const CRC_SECRET = document.querySelector('meta[name="crc-secret"]')?.content || ''

// Cabeçalho enviado em todas as requisições
const TENANT_HEADERS = {
  'x-tenant-id':  TENANT_ID,
  'x-user-id':    CURRENT_USER,
  'x-crc-secret': CRC_SECRET,
}

// Usuário é dono de uma sessão se foi ele quem criou
// (created_by vazio = sessão sem dono ainda, tratado no auto-claim)
function isOwner(session) {
  if (!CURRENT_USER) return false
  return session.created_by === CURRENT_USER
}

// Lista de tenants disponíveis para o seletor (ao criar nova sessão)
const AVAILABLE_TENANTS = _ids.length > 0
  ? _ids.map(id => ({ id, name: TENANT_NAMES[id] || id }))
  : [{ id: 'default', name: 'Padrão' }]

const state = {
  sessions:           [],
  conversations:      [],
  activeSession:      null,
  activeConversation: null,
  pendingFile:        null,
}

/* ── Socket.io ────────────────────────────────────────────── */

const socket = io()

socket.on('qr', ({ sessionId, qr }) => {
  const sess = state.sessions.find(s => s.id === sessionId)
  document.getElementById('qr-session-label').textContent = sess ? `Número: ${sess.name}` : sessionId
  document.getElementById('qr-wrapper').innerHTML = `<img src="${qr}" width="240" height="240" alt="QR Code" />`
  document.getElementById('modal-qr').classList.remove('hidden')
})

socket.on('session:update', ({ sessionId, status, phone }) => {
  const s = state.sessions.find(s => s.id === sessionId)
  if (!s) return
  s.status = status
  if (phone) s.phone = phone
  renderSessions()
  if (status === 'connected') {
    document.getElementById('modal-qr').classList.add('hidden')
    resetQrModal()
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
  if (active && active.id === message.conversation_id && active.session_id === message.session_id) {
    appendMessage(message)
    scrollToBottom()
  }
})

/* ── Init ─────────────────────────────────────────────────── */

async function init() {
  await Promise.all([loadSessions(), loadConversations()])
}

/* ── Sessions ─────────────────────────────────────────────── */

async function loadSessions() {
  const res = await fetch('/api/sessions', { headers: TENANT_HEADERS })
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

function renderSessions() {
  const list = document.getElementById('sessions-list')

  // Botão "+" só aparece se o usuário já criou alguma sessão OU se não há sessões ainda
  const userOwnsAny = state.sessions.some(s => isOwner(s))
  const addBtn      = document.querySelector('#sessions-panel .panel-header .btn-icon')
  if (addBtn) addBtn.style.display = (userOwnsAny || !state.sessions.length) ? 'flex' : 'none'

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
        <span class="status-dot ${s.status}"></span>
        ${isOwner(s) ? `
        <div class="session-actions">
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

async function addSession() {
  const input    = document.getElementById('input-session-name')
  const tenantEl = document.getElementById('input-session-tenant')
  const name     = input.value.trim()
  if (!name) return
  const tenant_id = tenantEl?.value || AVAILABLE_TENANTS[0]?.id || 'default'
  input.value = ''
  closeAddModal()

  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...TENANT_HEADERS },
      body: JSON.stringify({ name, tenant_id }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `Erro ${res.status}` }))
      showToast('Erro ao conectar: ' + (err.error || res.status), 'error')
      return
    }
    const sess = await res.json()
    state.sessions.push(sess)
    renderSessions()

    document.getElementById('qr-session-label').textContent = `Número: ${name}`
    document.getElementById('modal-qr').classList.remove('hidden')
  } catch (e) {
    showToast('Erro de conexão: ' + e.message, 'error')
  }
}

async function removeSession(id) {
  if (!confirm('Desconectar este número? A sessão será encerrada.')) return
  await fetch(`/api/sessions/${id}`, { method: 'DELETE', headers: TENANT_HEADERS })
  state.sessions      = state.sessions.filter(s => s.id !== id)
  state.conversations = state.conversations.filter(c => c.session_id !== id)
  if (state.activeSession?.id === id) selectSession(null)
  renderSessions()
  renderConversations()
}

async function clearConversations(sessionId) {
  if (!confirm('Limpar todas as conversas desta sessão no CRC?\n\nAs mensagens continuam no WhatsApp normalmente.')) return
  await fetch(`/api/sessions/${sessionId}/conversations`, { method: 'DELETE', headers: TENANT_HEADERS })
  state.conversations = state.conversations.filter(c => c.session_id !== sessionId)
  if (state.activeConversation?.session_id === sessionId) {
    state.activeConversation = null
    document.getElementById('chat-empty').classList.remove('hidden')
    document.getElementById('chat-content').classList.add('hidden')
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
}

/* ── Conversations ────────────────────────────────────────── */

async function loadConversations() {
  const params = new URLSearchParams()
  if (state.activeSession)   params.set('session_id', state.activeSession.id)
  if (state.searchQuery)     params.set('search', state.searchQuery)
  const res = await fetch(`/api/conversations?${params}`, { headers: TENANT_HEADERS })
  state.conversations = await res.json()
  renderConversations()
}

function renderConversations() {
  const list    = document.getElementById('conversations-list')
  const showTag = !state.activeSession

  if (!state.conversations.length) {
    list.innerHTML = `<div class="empty-state" style="padding:40px 0"><span>Nenhuma conversa</span></div>`
    return
  }

  list.innerHTML = state.conversations.map(c => {
    const isActive = state.activeConversation?.id === c.id && state.activeConversation?.session_id === c.session_id
    const avatarContent = c.profile_pic
      ? `<img src="${c.profile_pic}" onerror="this.style.display='none'" />${initials(c.name || c.phone)}`
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
        <div class="conv-bottom">
          <span class="conv-preview">${previewIcon(c.last_message)}${esc(c.last_message || '')}</span>
          <span class="conv-session-tag" style="border-left:2px solid ${sColor};padding-left:5px">${esc(c.session_name)}</span>
          ${c.unread_count > 0 ? `<span class="unread-badge">${c.unread_count}</span>` : ''}
        </div>
      </div>
    </div>`
  }).join('')
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

  document.getElementById('chat-empty').classList.add('hidden')
  document.getElementById('chat-content').classList.remove('hidden')
  const sColor = sessionColor(conv.session_id)
  document.getElementById('chat-name').textContent            = conv.name || conv.phone
  document.getElementById('chat-avatar-initials').textContent = initials(conv.name || conv.phone)
  document.getElementById('chat-meta').innerHTML =
    `${conv.phone} · <span style="color:${sColor};font-weight:600">${esc(conv.session_name)}</span>`
  document.getElementById('chat-header').style.borderBottom = `2px solid ${sColor}`

  const phone = conv.phone.replace(/\D/g, '')
  document.getElementById('chat-wa-link').href = `https://web.whatsapp.com/send?phone=${phone}`

  // Foto de perfil no header
  loadProfilePic(conv)

  conv.unread_count = 0
  renderConversations()

  const params = new URLSearchParams({ session_id: sessionId })
  const res    = await fetch(`/api/conversations/${encodeURIComponent(convId)}/messages?${params}`, { headers: TENANT_HEADERS })
  const msgs   = await res.json()

  const list = document.getElementById('messages-list')
  list.innerHTML = ''
  msgs.forEach(m => appendMessage(m))
  scrollToBottom()

  document.getElementById('msg-input').focus()
}

async function loadProfilePic(conv) {
  const img      = document.getElementById('chat-avatar-img')
  const initials = document.getElementById('chat-avatar-initials')

  img.classList.add('hidden')
  initials.classList.remove('hidden')

  try {
    const res  = await fetch(`/api/conversations/${encodeURIComponent(conv.id)}/profile-picture?session_id=${conv.session_id}`, { headers: TENANT_HEADERS })
    const data = await res.json()
    if (data.url) {
      img.src = data.url
      img.onload  = () => { img.classList.remove('hidden'); initials.classList.add('hidden') }
      img.onerror = () => { img.classList.add('hidden');    initials.classList.remove('hidden') }
    }
  } catch (_) { /* sem foto */ }
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

function appendMessage(msg) {
  const list = document.getElementById('messages-list')
  const side = msg.from_me ? 'from-me' : 'from-them'
  const div  = document.createElement('div')
  div.className = `msg-group ${side}`
  div.id        = `msg-${msg.id}`   // usado pelo evento message:media

  div.innerHTML = `
    <div class="msg-bubble">${renderMediaContent(msg)}</div>
    <span class="msg-time">${formatTime(msg.timestamp)}</span>
  `
  list.appendChild(div)
}

/* ── Enviar texto ─────────────────────────────────────────── */

async function sendMessage() {
  const conv  = state.activeConversation
  if (!conv) return

  // Se há arquivo pendente, envia o arquivo
  if (state.pendingFile) { await sendPendingFile(); return }

  const input = document.getElementById('msg-input')
  const text  = input.value.trim()
  if (!text) return

  const btn = document.getElementById('send-btn')
  btn.disabled = true
  input.value  = ''
  autoResize(input)

  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(conv.id)}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...TENANT_HEADERS },
      body: JSON.stringify({ body: text, session_id: conv.session_id }),
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
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
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
    if (!res.ok) { const e = await res.json(); alert('Erro: ' + e.error) }
    else {
      document.getElementById('msg-input').value = ''
      autoResize(document.getElementById('msg-input'))
    }
  } catch (e) {
    alert('Erro: ' + e.message)
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

  // Captura a conversa AGORA — antes de qualquer await
  recordingConv = state.activeConversation
  if (!recordingConv) return

  console.log('[rec] iniciando para', recordingConv.id, '| session:', recordingConv.session_id)

  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true })

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/ogg'

    mediaRecorder = new MediaRecorder(recordingStream, { mimeType })
    audioChunks   = []

    mediaRecorder.ondataavailable = ev => { if (ev.data.size > 0) audioChunks.push(ev.data) }

    mediaRecorder.onstop = async () => {
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType })
      const ext  = mimeType.includes('webm') ? 'webm' : 'ogg'
      const file = new File([blob], `audio_${Date.now()}.${ext}`, { type: mimeType })

      console.log('[rec] gravação finalizada | size:', blob.size, '| mime:', mimeType,
                  '| conv:', recordingConv?.id, '| session:', recordingConv?.session_id)

      if (blob.size < 500) {
        console.warn('[rec] áudio muito curto, ignorando')
        recordingStream?.getTracks().forEach(t => t.stop())
        return
      }

      // Usa recordingConv capturado no início — não depende de state.activeConversation
      await sendAudioFile(file, recordingConv)
      recordingStream?.getTracks().forEach(t => t.stop())
    }

    mediaRecorder.start(250)  // coleta dados a cada 250ms
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
    document.getElementById('mic-btn').classList.remove('recording')
  }
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

// Permitindo usar searchQuery no loadConversations
const _origLoad = loadConversations
async function loadConversations() {
  const params = new URLSearchParams()
  if (state.activeSession) params.set('session_id', state.activeSession.id)
  if (searchQuery)         params.set('search', searchQuery)
  const res = await fetch(`/api/conversations?${params}`, { headers: TENANT_HEADERS })
  state.conversations = await res.json()
  renderConversations()
}

/* ── Modais ───────────────────────────────────────────────── */

function openAddModal() {
  // Popula o seletor de empresa
  const sel  = document.getElementById('input-session-tenant')
  const wrap = document.getElementById('tenant-selector-wrap')
  sel.innerHTML = AVAILABLE_TENANTS.map(t =>
    `<option value="${t.id}">${t.name}</option>`
  ).join('')
  // Esconde o seletor se só tem um tenant (não faz sentido escolher)
  wrap.style.display = AVAILABLE_TENANTS.length > 1 ? 'flex' : 'none'
  wrap.style.flexDirection = 'column'
  wrap.style.gap = '4px'

  document.getElementById('modal-add').classList.remove('hidden')
  setTimeout(() => document.getElementById('input-session-name').focus(), 50)
}
function closeAddModal() { document.getElementById('modal-add').classList.add('hidden') }
function closeQrModal()  { document.getElementById('modal-qr').classList.add('hidden') }
function resetQrModal()  {
  document.getElementById('qr-wrapper').innerHTML = `
    <div class="qr-placeholder"><div class="spinner"></div><span>Aguardando QR Code…</span></div>`
}

document.addEventListener('click', e => {
  if (e.target.id === 'modal-add') closeAddModal()
  if (e.target.id === 'modal-qr')  closeQrModal()
})

/* ── Helpers ──────────────────────────────────────────────── */

function scrollToBottom() {
  const list = document.getElementById('messages-list')
  list.scrollTop = list.scrollHeight
}

function autoResize(el) {
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 120) + 'px'
}

function esc(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function initials(name) {
  if (!name) return '?'
  const parts = String(name).trim().split(/\s+/)
  return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : parts[0].slice(0, 2).toUpperCase()
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

/* ── Start ────────────────────────────────────────────────── */
init()
