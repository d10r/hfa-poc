const API_BASE = window.location.origin
let deviceId = localStorage.getItem('deviceId')

function showStatus(elementId, message, type) {
  const el = document.getElementById(elementId)
  el.textContent = message
  el.className = `status ${type}`
  el.classList.remove('hidden')
}

function hideStatus(elementId) {
  document.getElementById(elementId).classList.add('hidden')
}

function updateActionsSupport() {
  const el = document.getElementById('actions-support')
  const supported = typeof Notification !== 'undefined' && (Notification.maxActions ?? 0) > 0
  el.textContent = supported ? 'Actions supported' : 'Actions not supported'
}

function updateUI() {
  const registerBtn = document.getElementById('register-btn')
  const deviceInfo = document.getElementById('device-info')
  const deviceIdEl = document.getElementById('device-id')
  
  updateActionsSupport()
  
  if (deviceId) {
    registerBtn.classList.add('hidden')
    deviceInfo.classList.remove('hidden')
    deviceIdEl.textContent = deviceId
  } else {
    registerBtn.classList.remove('hidden')
    deviceInfo.classList.add('hidden')
  }
}

async function getVapidPublicKey() {
  const res = await fetch(`${API_BASE}/vapid-public-key`)
  if (!res.ok) {
    throw new Error('Failed to get VAPID public key')
  }
  const data = await res.json()
  return data.publicKey
}

async function registerDevice() {
  hideStatus('register-status')
  
  if (!('serviceWorker' in navigator)) {
    showStatus('register-status', 'Service Workers not supported', 'error')
    return
  }
  
  if (!('PushManager' in window)) {
    showStatus('register-status', 'Push notifications not supported', 'error')
    return
  }

  try {
    showStatus('register-status', 'Registering...', 'info')
    
    const reg = await navigator.serviceWorker.register('/sw.js')
    console.log('Service worker registered:', reg)
    
    let subscription = await reg.pushManager.getSubscription()
    
    if (!subscription) {
      const vapidKey = await getVapidPublicKey()
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey)
      })
      console.log('Push subscription created:', subscription)
    }
    
    const res = await fetch(`${API_BASE}/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription })
    })
    
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Registration failed')
    }
    
    const data = await res.json()
    deviceId = data.id
    localStorage.setItem('deviceId', deviceId)
    
    showStatus('register-status', 'Device registered successfully!', 'success')
    updateUI()
    loadNotifications()
    
  } catch (err) {
    console.error('Registration error:', err)
    showStatus('register-status', `Error: ${err.message}`, 'error')
  }
}

async function unregisterDevice() {
  if (!deviceId) return
  
  try {
    const res = await fetch(`${API_BASE}/devices/${deviceId}`, {
      method: 'DELETE'
    })
    
    if (res.ok) {
      deviceId = null
      localStorage.removeItem('deviceId')
      showStatus('register-status', 'Device unregistered', 'info')
      updateUI()
    }
  } catch (err) {
    console.error('Unregister error:', err)
    showStatus('register-status', `Error: ${err.message}`, 'error')
  }
}

async function loadNotifications() {
  const container = document.getElementById('notifications')
  
  if (!deviceId) {
    container.innerHTML = '<p class="timestamp">Register device to see notifications</p>'
    return
  }
  
  try {
    const res = await fetch(`${API_BASE}/notifications?deviceId=${deviceId}`)
    const notifications = await res.json()
    
    if (notifications.length === 0) {
      container.innerHTML = '<p class="timestamp">No notifications yet</p>'
      return
    }
    
    container.innerHTML = notifications.map(n => {
      const statusClass = n.response || 'pending'
      const responseBadge = n.response 
        ? `<span class="response-badge ${n.response}">${n.response.toUpperCase()}</span>`
        : '<span class="response-badge pending">PENDING</span>'
      
      return `
        <div class="notification-item ${statusClass}">
          <div>${responseBadge}</div>
          <p>${escapeHtml(n.message)}</p>
          <div class="timestamp">${new Date(n.createdAt).toLocaleString()}</div>
        </div>
      `
    }).join('')
    
  } catch (err) {
    console.error('Load notifications error:', err)
    container.innerHTML = `<p class="status error">Error: ${err.message}</p>`
  }
}

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4)
  const base64 = (base64String + padding)
    .replace(/\-/g, '+')
    .replace(/_/g, '/')
  
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

updateUI()
loadNotifications()