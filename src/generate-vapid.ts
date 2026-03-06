import webpush from 'web-push'
import 'dotenv/config'

function main(): void {
  const vapidKeys = webpush.generateVAPIDKeys()
  console.log('Generated VAPID keys:')
  console.log('')
  console.log(`VAPID_PUBLIC_KEY=${vapidKeys.publicKey}`)
  console.log(`VAPID_PRIVATE_KEY=${vapidKeys.privateKey}`)
  console.log('')
  console.log('Add these to your .env file:')
  console.log('  VAPID_SUBJECT=mailto:your-email@example.com')
}

main()