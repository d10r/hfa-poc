const API_BASE = self.location.origin
const respondedIds = new Set()

function sendResponse(notificationId, response, messageLength) {
  if (respondedIds.has(notificationId)) return
  respondedIds.add(notificationId)
  const body = { notificationId, response }
  if (messageLength !== undefined) body.messageLength = messageLength
  return fetch(`${API_BASE}/response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(res => {
    if (res.ok) {
      console.log(`Response sent: ${response}`)
    } else {
      console.error('Failed to send response')
    }
  }).catch(err => {
    console.error('Error sending response:', err)
  })
}

self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {}
  
  const options = {
    body: data.message || 'New notification',
    // Android Chrome: both action buttons report the SAME event.action. Use single Accept
    // button; Reject = tap body or swipe to dismiss (notificationclose).
    actions: [{ action: 'accept', title: 'Accept' }],
    data: {
      notificationId: data.notificationId,
      message: data.message || ''
    },
    requireInteraction: true
  }
  
  event.waitUntil(
    self.registration.showNotification('Action Required', options)
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  
  const notificationId = event.notification.data?.notificationId
  const action = event.action
  
  if (!notificationId) {
    console.error('No notification ID in notification data')
    return
  }
  
  if (action === 'accept') {
    const message = event.notification.data?.message ?? ''
    event.waitUntil(sendResponse(notificationId, 'accepted', message.length))
  } else {
    // action === '' means user tapped notification body, not the Accept button
    event.waitUntil(sendResponse(notificationId, 'rejected'))
  }
})

self.addEventListener('notificationclose', event => {
  const notificationId = event.notification?.data?.notificationId
  if (!notificationId) return
  // User swiped to dismiss without tapping Accept = Reject
  event.waitUntil(sendResponse(notificationId, 'rejected'))
})

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim())
})