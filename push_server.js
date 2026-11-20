const http = require('http');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const path = require('path');

// --- Firebase Init ---
let serviceAccount;
if (process.env.GOOGLE_CREDENTIALS) {
  serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS);
} else {
  serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));
}

initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();
const messaging = getMessaging();

let pushCount = 0;
const startedAt = new Date();

console.log('====================================================');
console.log('  Vesta Push Notification Daemon is active!');
console.log('  Connected to project: vesta-messenger-87c4');
console.log('  Listening for new incoming messages in Firestore...');
console.log('====================================================');

const startTime = Date.now();

// --- Firestore Listener ---
db.collectionGroup('messages')
  .onSnapshot(async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type === 'added') {
        const messageDoc = change.doc;
        const message = messageDoc.data();

        const msgTimestamp = message.timestamp;
        let msgTimeMs = 0;
        if (msgTimestamp && typeof msgTimestamp.toMillis === 'function') {
          msgTimeMs = msgTimestamp.toMillis();
        } else if (typeof msgTimestamp === 'number') {
          msgTimeMs = msgTimestamp;
        }

        if (msgTimeMs < startTime - 5000) {
          continue;
        }

        const chatDocRef = messageDoc.ref.parent.parent;
        if (!chatDocRef) continue;
        const chatId = chatDocRef.id;

        const senderTitle = message.senderName || 'Vesta Messenger';
        const bodyText = message.text || 'Новое сообщение';

        console.log(`\n[${new Date().toLocaleTimeString()}] New message in chat [${chatId}] from ${senderTitle}: "${bodyText}"`);

        try {
          const chatSnap = await chatDocRef.get();
          if (!chatSnap.exists) continue;

          const chatData = chatSnap.data();
          const participantIds = chatData.participantIds || [];

          const recipientIds = participantIds.filter(uid => uid !== message.senderId);

          for (const recipientId of recipientIds) {
            const userSnap = await db.collection('users').doc(recipientId).get();
            if (!userSnap.exists) {
              console.log(`  Warning: User document not found: ${recipientId}`);
              continue;
            }

            const userData = userSnap.data();
            const fcmToken = userData.fcmToken;

            if (!fcmToken) {
              console.log(`  Warning: Recipient [${recipientId}] has no FCM token.`);
              continue;
            }

            const payload = {
              token: fcmToken,
              notification: {
                title: senderTitle,
                body: bodyText,
              },
              data: {
                chatId: chatId,
                senderId: message.senderId || '',
              },
              android: {
                priority: 'high',
                notification: {
                  channelId: 'vesta_channel',
                  sound: 'default',
                  priority: 'high',
                  defaultVibrateTimings: true,
                },
              },
            };

            const response = await messaging.send(payload);
            pushCount++;
            console.log(`  Push delivered to ${recipientId}! (total: ${pushCount})`);
          }
        } catch (err) {
          console.error('  Error sending push:', err.message);
        }
      }
    }
  }, (err) => {
    console.error('Firestore listener error:', err.message);
  });

// --- Health-check HTTP server (keeps Render alive) ---
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const uptime = Math.floor((Date.now() - startedAt.getTime()) / 1000);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    service: 'Vesta Push Daemon',
    uptime_seconds: uptime,
    pushes_sent: pushCount,
    started_at: startedAt.toISOString()
  }));
});

server.listen(PORT, () => {
  console.log(`Health-check server listening on port ${PORT}`);
});
