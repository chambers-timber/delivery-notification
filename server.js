// 📦 FINAL server.js with driver support + freeform reply (fixed)
const admin = require('firebase-admin');
const serviceAccount = require('./firebase-service-account.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://ct-delivery-notification-default-rtdb.europe-west1.firebasedatabase.app'
});

const db = admin.database();

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const twilio = require('twilio');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

console.log('🔐 TWILIO_SID:', process.env.TWILIO_SID);
console.log('🔐 TWILIO_AUTH_TOKEN:', process.env.TWILIO_AUTH_TOKEN ? '[HIDDEN]' : 'MISSING');

const accountSid = process.env.TWILIO_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);
const whatsappNumber = 'whatsapp:+447706802841';
const orderConfirmationTemplateSid = 'HXb930591ce15ddf1213379a48a92349e0';

function formatPhoneNumber(phone) {
  phone = phone.replace(/\s+/g, '').replace(/[^0-9+]/g, '');
  if (phone.startsWith('0')) return '+44' + phone.slice(1);
  if (phone.startsWith('44') && !phone.startsWith('+')) return '+' + phone;
  if (!phone.startsWith('+')) return '+' + phone;
  return phone;
}

function formatUKDate(dateStr) {
  const date = new Date(dateStr);
  if (isNaN(date)) return dateStr;
  const dayName = date.toLocaleDateString('en', { weekday: 'long' });
  const dayNum = date.getDate();
  const monthName = date.toLocaleDateString('en', { month: 'long' });
  const year = date.getFullYear().toString().slice(-2);
  const suffix = (dayNum === 1 || dayNum === 21 || dayNum === 31) ? 'st' :
                 (dayNum === 2 || dayNum === 22) ? 'nd' :
                 (dayNum === 3 || dayNum === 23) ? 'rd' : 'th';
  return `${dayName} ${dayNum}${suffix} ${monthName} ${year}`;
}

// ✅ Send templated WhatsApp message to customer + optional driver
app.post('/send-message', async (req, res) => {
  try {
    const {
      phone, orderNumber, eta, deliveryDate, customerAddress,
      siteContact, vehicleReg, templateSid, driver
    } = req.body;

    const customerPhone = formatPhoneNumber(phone);
    const vehicleType = vehicleReg || '';
    const mapImageUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(customerAddress || '')}`;
    const etaValue = typeof eta === 'string' ? eta : '';
    const deliveryDateValue = typeof deliveryDate === 'string' ? deliveryDate : '';

    let driverPhone = '';
    if (driver && typeof driver === 'string') {
      if (driver.includes(' - ')) {
        driverPhone = formatPhoneNumber(driver.split(' - ')[1].trim());
      } else {
        driverPhone = formatPhoneNumber(driver.trim());
      }
    }

    if (!customerPhone.startsWith('+44') || customerPhone.length < 10) {
      return res.status(400).json({ success: false, error: 'Invalid customer UK phone number' });
    }

    let contentVariables;
    if (templateSid === orderConfirmationTemplateSid) {
      if (!deliveryDateValue.trim()) {
        return res.status(400).json({ success: false, error: 'Delivery Date is required for Order Confirmations.' });
      }
      contentVariables = JSON.stringify({
        '1': orderNumber || 'N/A',
        '2': formatUKDate(deliveryDateValue.trim()),
        '3': customerAddress || 'N/A',
        '4': siteContact || 'N/A',
        '5': mapImageUrl
      });
    } else {
      contentVariables = JSON.stringify({
        '1': orderNumber || 'N/A',
        '2': etaValue || 'N/A',
        '3': customerAddress || 'N/A',
        '4': siteContact || 'N/A',
        '5': mapImageUrl,
        '6': vehicleType || 'N/A'
      });
    }

    const messagePayload = {
      from: whatsappNumber,
      contentSid: templateSid,
      contentVariables,
      contentLanguage: 'en',
      statusCallback: 'https://delivery-notification.onrender.com/status-callback'
    };

    const customerMessage = await client.messages.create({
      ...messagePayload,
      to: `whatsapp:${customerPhone}`
    });

    console.log('✅ Customer message SID:', customerMessage.sid);

    let driverSid = '';
    if (driverPhone && /^\+44\d{9,10}$/.test(driverPhone)) {
      try {
        const driverMessage = await client.messages.create({
          ...messagePayload,
          to: `whatsapp:${driverPhone}`
        });
        driverSid = driverMessage.sid;
        console.log('✅ Driver message SID:', driverSid);
      } catch (err) {
        console.error(`❌ Driver message failed: ${err.message}`);
      }
    }

    res.json({ success: true, sid: customerMessage.sid, driverSid });
  } catch (err) {
    console.error('❌ Error in /send-message:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ Freeform reply (manual messages)
app.post('/send-reply', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'Missing phone or message' });
  }

  const to = phone.startsWith('whatsapp:') ? phone : `whatsapp:${formatPhoneNumber(phone)}`;

  try {
    const reply = await client.messages.create({
      from: whatsappNumber,
      to,
      body: message
    });

    console.log('✅ Freeform reply SID:', reply.sid);
    res.json({ success: true, sid: reply.sid });
  } catch (err) {
    console.error('❌ Failed to send reply:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ Incoming WhatsApp messages saved to Firebase
app.post('/incoming-whatsapp', (req, res) => {
  const from = req.body.From || '';
  const body = req.body.Body || '';
  console.log('📩 Incoming message:', { from, body });

  if (from.startsWith('whatsapp:') && body) {
    const number = from.replace('whatsapp:', '');
    const timestamp = new Date().toISOString();
    db.ref('inboxMessages').push({ number, message: body, time: timestamp });
  }

  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

// ✅ Delivery status updates from Twilio
app.post('/status-callback', (req, res) => {
  const messageSid = req.body.MessageSid || '';
  const messageStatus = req.body.MessageStatus || '';
  console.log(`📬 Status update: ${messageSid} → ${messageStatus}`);

  if (!messageSid) return res.sendStatus(400);

  db.ref('messageHistory')
    .orderByChild('messageSid')
    .equalTo(messageSid)
    .once('value', snapshot => {
      if (!snapshot.exists()) {
        console.warn(`⚠️ SID not found in Firebase: ${messageSid}`);
      }
      snapshot.forEach(child => {
        child.ref.update({ status: messageStatus });
      });
      res.sendStatus(200);
    });
});

// ✅ Manually check message status
app.get('/message-status/:sid', async (req, res) => {
  try {
    const message = await client.messages(req.params.sid).fetch();
    res.json({ sid: message.sid, status: message.status });
  } catch (err) {
    console.error('❌ Fetch status failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Load inbox messages from Firebase
app.get('/inbox', (req, res) => {
  db.ref('inboxMessages')
    .once('value')
    .then(snapshot => {
      const messages = snapshot.val() || {};
      const sorted = Object.values(messages).sort((a, b) => new Date(b.time) - new Date(a.time));
      res.json(sorted);
    })
    .catch(err => {
      console.error('❌ Inbox fetch failed:', err.message);
      res.status(500).json({ error: 'Inbox fetch failed' });
    });
});

// ✅ Serve frontend
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ✅ Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
