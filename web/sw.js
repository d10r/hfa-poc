const API_BASE = self.location.origin

self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {}
  
  const options = {
    body: data.message || 'New notification',
    actions: [
      { action: 'accept', title: 'Accept' },
      { action: 'reject', title: 'Reject' }
    ],
    data: {
      notificationId: data.notificationId
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
  
  if (action === 'accept' || action === 'reject') {
    const response = action === 'accept' ? 'accepted' : 'rejected'
    
    event.waitUntil(
      fetch(`${API_BASE}/response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notificationId,
          response
        })
      }).then(res => {
        if (res.ok) {
          console.log(`Response sent: ${response}`)
        } else {
          console.error('Failed to send response')
        }
      }).catch(err => {
        console.error('Error sending response:', err)
      })
    )
  }
})

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim())
})