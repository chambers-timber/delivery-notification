// 📦 FINAL server.js (fully cleaned and working)

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const twilio = require('twilio');
const path = require('path');

const app = express();

// ✅ Middlewares
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

console.log('🔐 TWILIO_SID:', process.env.TWILIO_SID);
console.log('🔐 TWILIO_AUTH_TOKEN:', process.env.TWILIO_AUTH_TOKEN ? '[HIDDEN]' : 'MISSING');

// ✅ Twilio setup
const accountSid = process.env.TWILIO_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);
const whatsappNumber = 'whatsapp:+447706802841';

// ✅ In-memory stores
const inboxMessages = [];
const messageStatusMap = {}; // 💡 Track SID → status

// ✅ Template SID for Order Confirmation
const orderConfirmationTemplateSid = 'HXb930591ce15ddf1213379a48a92349e0';

// THIS SECTION IS NEW FOR MIGRATING TO SERVER STORAGE
// New memory stores
const savedDrafts = [];
const orderHistory = [];

// API: Save sent message to history 
app.post('/save-history', (req, res) => {
  const historyItem = req.body;
  orderHistory.unshift(historyItem);
  res.json({ success: true });
});

// API: Get all history
app.get('/history', (req, res) => {
  res.json(orderHistory);
});

// API: Save draft
app.post('/save-draft', (req, res) => {
  const draft = req.body;
  savedDrafts.unshift(draft);
  res.json({ success: true });
});

// API: Get all drafts
app.get('/drafts', (req, res) => {
  res.json(savedDrafts);
});

// API: Clear all drafts
app.delete('/drafts', (req, res) => {
  savedDrafts.length = 0;
  res.json({ success: true });
});
// THIS SECTION IS NEW FOR MIGRATING TO SERVER STORAGE

// ✅ Format UK phone numbers
function formatPhoneNumber(phone) {
  phone = phone.replace(/\s+/g, '').replace(/[^0-9+]/g, '');
  if (phone.startsWith('0')) return '+44' + phone.slice(1);
  if (phone.startsWith('44') && !phone.startsWith('+')) return '+' + phone;
  if (!phone.startsWith('+')) return '+' + phone;
  return phone;
}

// ✅ Format delivery date as "Thursday 9th May 25"
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

// ✅ Send WhatsApp Message
app.post('/send-message', async (req, res) => {
  try {
    console.log('📩 Incoming send-message POST body:', req.body);

    let { phone, orderNumber, eta, deliveryDate, customerAddress, siteContact, vehicleReg, templateSid } = req.body;
    let vehicleType = vehicleReg;


    phone = formatPhoneNumber(phone);

    if (!phone.startsWith('+44') || phone.length < 10) {
      return res.status(400).json({ success: false, error: 'Invalid UK phone number format' });
    }

    const mapImageUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(customerAddress)}`;

    deliveryDate = typeof deliveryDate === 'string' ? deliveryDate : '';
    eta = typeof eta === 'string' ? eta : '';

    let contentVariables;

    if (templateSid === orderConfirmationTemplateSid) {
      if (!deliveryDate.trim()) {
        return res.status(400).json({ success: false, error: 'Delivery Date is required for Order Confirmations.' });
      }
      contentVariables = JSON.stringify({
        '1': orderNumber || 'N/A',
        '2': formatUKDate(deliveryDate.trim()),
        '3': customerAddress || 'N/A',
        '4': siteContact || 'N/A',
        '5': mapImageUrl
      });
    } else {
      contentVariables = JSON.stringify({
        '1': orderNumber || 'N/A',
        '2': eta.trim() || 'N/A',
        '3': customerAddress || 'N/A',
        '4': siteContact || 'N/A',
        '5': mapImageUrl,
        '6': vehicleType || 'N/A' // NEW VARIABLE FOR VEHICLE TYPE
      });
    }

    console.log('📦 Sending WhatsApp template with:', {
      to: `whatsapp:${phone}`,
      contentSid: templateSid,
      variables: JSON.parse(contentVariables)
    });

    const message = await client.messages.create({
      from: whatsappNumber,
      to: `whatsapp:${phone}`,
      contentSid: templateSid,
      contentVariables: contentVariables,
      contentLanguage: 'en',
      statusCallback: 'https://delivery-notification.onrender.com/status-callback'
    });

    console.log('✅ WhatsApp template message sent. SID:', message.sid);
    res.json({ success: true, sid: message.sid });

  } catch (error) {
    console.error('❌ Error sending WhatsApp message:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ Receive incoming WhatsApp messages
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

// ✅ Track delivery status updates
app.post('/status-callback', (req, res) => {
  const messageSid = req.body.MessageSid || 'unknown';
  const messageStatus = req.body.MessageStatus || 'unknown';

  console.log(`📬 Status update received: SID ${messageSid} → ${messageStatus}`);
  messageStatusMap[messageSid] = messageStatus;

  res.sendStatus(200);
});

// ✅ Expose message status for frontend polling
app.get('/message-status/:sid', (req, res) => {
  const sid = req.params.sid;
  const status = messageStatusMap[sid] || 'unknown';
  res.json({ sid, status });
});

// ✅ Inbox route
app.get('/inbox', (req, res) => {
  res.json(inboxMessages);
});

// ✅ Static files
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ✅ Start server
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

//fully working 06/05/25