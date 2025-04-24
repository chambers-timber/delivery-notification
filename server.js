require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const twilio = require('twilio');

const app = express();
app.use((req, res, next) => {
  console.log(`📥 ${req.method} request to ${req.url}`);
  next();
});

// ✅ Middlewares
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ✅ Twilio setup
const accountSid = process.env.TWILIO_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);
const whatsappNumber = 'whatsapp:+447706802841';

// ✅ In-memory stores
const inboxMessages = [];
const messageStatusMap = {}; // 💡 Track SID → status

// ✅ Format UK phone numbers
function formatPhoneNumber(phone) {
  phone = phone.replace(/\s+/g, '').replace(/[^0-9+]/g, '');
  if (phone.startsWith('0')) return '+44' + phone.slice(1);
  if (phone.startsWith('44') && !phone.startsWith('+')) return '+' + phone;
  if (!phone.startsWith('+')) return '+' + phone;
  return phone;
}

// ✅ Template SID for Order Confirmation
const orderConfirmationTemplateSid = 'HXb2d2ab9e1ac3fac1909cb6d2bce1b15f';

// ✅ Format delivery date as DD/MM/YYYY 
function formatUKDate(dateStr) {
  const date = new Date(dateStr);
  if (isNaN(date)) return dateStr;
  return date.toLocaleDateString('en');
}

// ✅ Send WhatsApp message
app.post('/send-message', async (req, res) => {
  try {
    let { phone, orderNumber, eta, deliveryDate, customerAddress, siteContact, templateSid } = req.body;
    phone = formatPhoneNumber(phone);

    if (!phone.startsWith('+44') || phone.length < 10) {
      return res.status(400).json({ success: false, error: 'Invalid UK phone number format' });
    }

    const mapImageUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(customerAddress)}`;
    deliveryDate = typeof deliveryDate === 'string' ? deliveryDate : '';
    eta = typeof eta === 'string' ? eta : '';

    let contentVariables;

    if (templateSid === orderConfirmationTemplateSid) {
      contentVariables = JSON.stringify({
        '1': orderNumber || 'N/A',
        '2': formatUKDate(deliveryDate.trim()) || 'TBC',
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
        '5': mapImageUrl
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
      statusCallback: 'https://a787-151-2-156-66.ngrok-free.app/status-callback'
    });

    console.log('✅ WhatsApp template message sent. SID:', message.sid);
    res.json({ success: true, sid: message.sid }); // 💡 Return SID to frontend

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

const path = require('path');

// Serve index.html statically
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ✅ Start the server
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
