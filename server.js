// 📦 FINAL server.js with driver support (cleaned)
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

const inboxMessages = [];
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

app.post('/send-message', async (req, res) => {
  try {
    console.log('📩 Incoming send-message POST body:', req.body);

    const {
      phone,
      orderNumber,
      eta,
      deliveryDate,
      customerAddress,
      siteContact,
      vehicleReg,
      templateSid,
      driver // Format: "Name - 07123456789"
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

    // ✅ Send to customer
    const customerMessage = await client.messages.create({
      ...messagePayload,
      to: `whatsapp:${customerPhone}`
    });
    console.log('✅ Customer message SID:', customerMessage.sid);

    // ✅ Send to driver (separate call)
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
        console.error(`❌ Failed to send to driver ${driverPhone}:`, err.message);
      }
    } else {
      console.warn(`⚠️ Skipping driver send — invalid or missing number: ${driverPhone}`);
    }

    res.json({ success: true, sid: customerMessage.sid, driverSid });
  } catch (error) {
    console.error('❌ Failed to send message:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/incoming-whatsapp', (req, res) => {
  const from = req.body.From || '';
  const body = req.body.Body || '';
  console.log('📩 Incoming message received:', { from, body });

  if (from.startsWith('whatsapp:') && body) {
    const number = from.replace('whatsapp:', '');
    inboxMessages.push({
      number,
      message: body,
      time: new Date().toLocaleTimeString()
    });
  }

  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

app.post('/status-callback', (req, res) => {
  const messageSid = req.body.MessageSid || 'unknown';
  const messageStatus = req.body.MessageStatus || 'unknown';
  console.log(`📬 Status update received: SID ${messageSid} → ${messageStatus}`);

  const ref = db.ref('messageHistory');
  ref.orderByChild('messageSid').equalTo(messageSid).once('value', snapshot => {
    if (!snapshot.exists()) {
      console.warn(`⚠️ No Firebase entry found for SID: ${messageSid}`);
    }
    snapshot.forEach(child => {
      child.ref.update({ status: messageStatus });
      console.log(`✅ Firebase updated: ${messageSid} → ${messageStatus}`);
    });
  });

  res.sendStatus(200);
});

app.get('/message-status/:sid', async (req, res) => {
  try {
    const sid = req.params.sid;
    const message = await client.messages(sid).fetch();
    console.log(`📩 Fetched status from Twilio: ${sid} → ${message.status}`);
    res.json({ sid: message.sid, status: message.status });
  } catch (err) {
    console.error(`❌ Failed to fetch status from Twilio:`, err.message);
    res.status(500).json({ status: 'unknown', error: err.message });
  }
});

app.get('/inbox', (req, res) => {
  res.json(inboxMessages);
});

app.post('/reply', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ success: false, error: "Missing 'to' or 'message'" });
  }

  const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

  try {
    const sent = await client.messages.create({
      from: whatsappNumber,
      to: formattedTo,
      body: message
    });
    console.log('✅ Freeform reply sent:', sent.sid);
    res.json({ success: true, sid: sent.sid });
  } catch (error) {
    console.error('❌ Error sending freeform reply:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
}).on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use.`);
  } else {
    throw err;
  }
});

//fully working 16/05/25 1537 lines of code
// version 20250516
// 📦 FINAL server.js with driver support (cleaned)
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

const inboxMessages = [];
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

app.post('/send-message', async (req, res) => {
  try {
    console.log('📩 Incoming send-message POST body:', req.body);

    const {
      phone,
      orderNumber,
      eta,
      deliveryDate,
      customerAddress,
      siteContact,
      vehicleReg,
      templateSid,
      driver // Format: "Name - 07123456789"
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

    // ✅ Send to customer
    const customerMessage = await client.messages.create({
      ...messagePayload,
      to: `whatsapp:${customerPhone}`
    });
    console.log('✅ Customer message SID:', customerMessage.sid);

    // ✅ Send to driver (separate call)
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
        console.error(`❌ Failed to send to driver ${driverPhone}:`, err.message);
      }
    } else {
      console.warn(`⚠️ Skipping driver send — invalid or missing number: ${driverPhone}`);
    }

    res.json({ success: true, sid: customerMessage.sid, driverSid });
  } catch (error) {
    console.error('❌ Failed to send message:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/incoming-whatsapp', (req, res) => {
  const from = req.body.From || '';
  const body = req.body.Body || '';
  console.log('📩 Incoming message received:', { from, body });

  if (from.startsWith('whatsapp:') && body) {
    const number = from.replace('whatsapp:', '');
    inboxMessages.push({
      number,
      message: body,
      time: new Date().toLocaleTimeString()
    });
  }

  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

app.post('/status-callback', (req, res) => {
  const messageSid = req.body.MessageSid || 'unknown';
  const messageStatus = req.body.MessageStatus || 'unknown';
  console.log(`📬 Status update received: SID ${messageSid} → ${messageStatus}`);

  const ref = db.ref('messageHistory');
  ref.orderByChild('messageSid').equalTo(messageSid).once('value', snapshot => {
    if (!snapshot.exists()) {
      console.warn(`⚠️ No Firebase entry found for SID: ${messageSid}`);
    }
    snapshot.forEach(child => {
      child.ref.update({ status: messageStatus });
      console.log(`✅ Firebase updated: ${messageSid} → ${messageStatus}`);
    });
  });

  res.sendStatus(200);
});

app.get('/message-status/:sid', async (req, res) => {
  try {
    const sid = req.params.sid;
    const message = await client.messages(sid).fetch();
    console.log(`📩 Fetched status from Twilio: ${sid} → ${message.status}`);
    res.json({ sid: message.sid, status: message.status });
  } catch (err) {
    console.error(`❌ Failed to fetch status from Twilio:`, err.message);
    res.status(500).json({ status: 'unknown', error: err.message });
  }
});

app.get('/inbox', (req, res) => {
  res.json(inboxMessages);
});

app.post('/reply', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ success: false, error: "Missing 'to' or 'message'" });
  }

  const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

  try {
    const sent = await client.messages.create({
      from: whatsappNumber,
      to: formattedTo,
      body: message
    });
    console.log('✅ Freeform reply sent:', sent.sid);
    res.json({ success: true, sid: sent.sid });
  } catch (error) {
    console.error('❌ Error sending freeform reply:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
}).on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use.`);
  } else {
    throw err;
  }
});

//fully working 16/05/25 1537 lines of code
// version 20250516