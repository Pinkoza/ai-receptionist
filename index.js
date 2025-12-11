// AI Receptionist Backend - Google Sheets Version
// Install: npm install express twilio dotenv googleapis body-parser cors @anthropic-ai/sdk

require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(cors());

// Initialize clients
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Google Sheets setup
let auth;

if (process.env.GOOGLE_CREDENTIALS) {
  // If credentials are passed as env variable
  auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
} else {
  // If credentials are in a file
  auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const CALLS_SHEET = 'Calls';
const CONFIG_SHEET = 'ClientConfigs';

// Store active conversations in memory
const conversations = {};

// System prompt for the receptionist
const SYSTEM_PROMPT = `You are a professional AI receptionist for a business. Your role is to:
1. Answer common questions about the business
2. Help schedule appointments (collect: name, phone, preferred time, reason for visit)
3. Take messages if the business is closed or busy (collect: caller name, phone, message)

Be friendly, professional, and efficient. Ask clarifying questions when needed.
Keep responses concise (1-2 sentences max when speaking).

When a caller wants to:
- SCHEDULE: Confirm name, phone, preferred date/time, and reason. Then say "I'll have the team confirm your appointment and call you back."
- LEAVE MESSAGE: Get their name, phone, and message. Say "Thank you, I've recorded your message. Someone will get back to you soon."
- ESCALATE: If they ask to speak to a human or seem frustrated, acknowledge and say "I'm transferring you to our team now."

Always be warm and helpful.`;

// Get client config from Google Sheet
async function getClientConfig(clientId) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${CONFIG_SHEET}!A:F`,
    });

    const rows = response.data.values || [];
    if (rows.length < 2) return null;

    const headers = rows[0];
    const clientIdIndex = headers.indexOf('ClientID');
    const greetingIndex = headers.indexOf('Greeting');
    const escalationIndex = headers.indexOf('EscalationNumber');
    const hoursIndex = headers.indexOf('BusinessHours');

    const config = rows.find(row => row[clientIdIndex] === clientId);
    if (!config) return null;

    return {
      ClientID: config[clientIdIndex],
      Greeting: config[greetingIndex] || 'Hello, thanks for calling!',
      EscalationNumber: config[escalationIndex],
      BusinessHours: config[hoursIndex],
    };
  } catch (error) {
    console.error('Error fetching config:', error);
    return null;
  }
}

// Log call to Google Sheets
async function logCall(clientId, fromNumber, toNumber, transcript, duration, callType, status) {
  try {
    const timestamp = new Date().toISOString();
    const values = [[clientId, fromNumber, toNumber, timestamp, transcript, duration, callType, status]];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${CALLS_SHEET}!A:H`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });

    console.log(`Call logged for ${clientId}`);
  } catch (error) {
    console.error('Error logging call:', error);
  }
}

// Main endpoint: Handle incoming call
app.post('/voice', async (req, res) => {
  const { CallSid, From, To } = req.body;
  const ClientID = req.query.clientId || 'default';

  // Get client config
  const config = await getClientConfig(ClientID);

  if (!config) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("Sorry, we couldn't find your business configuration. Please try again later.");
    return res.type('text/xml').send(twiml.toString());
  }

  // Initialize conversation
  conversations[CallSid] = {
    messages: [],
    transcript: '',
    startTime: Date.now(),
    clientId: ClientID,
    fromNumber: From,
    toNumber: To,
  };

  const twiml = new twilio.twiml.VoiceResponse();

  // Gather speech input
  const gather = twiml.gather({
    input: 'speech',
    speechTimeout: 'auto',
    action: `/handle-input?CallSid=${CallSid}&ClientID=${ClientID}`,
    method: 'POST',
    timeout: 5,
    numDigits: 0,
  });

  gather.say(config.Greeting);
  gather.say("Please tell me how I can help you.");

  res.type('text/xml').send(twiml.toString());
});

// Handle caller input and AI conversation
app.post('/handle-input', async (req, res) => {
  const { CallSid, ClientID } = req.query;
  const { SpeechResult } = req.body;
  const conv = conversations[CallSid];

  if (!conv) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("Session expired. Goodbye.");
    return res.type('text/xml').send(twiml.toString());
  }

  // Get caller input
  const callerInput = SpeechResult || '';
  if (callerInput) {
    conv.messages.push({ role: 'user', content: callerInput });
    conv.transcript += `Caller: ${callerInput}\n`;
  }

  try {
    // Get AI response from Claude
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-1-20250805',
      max_tokens: 150,
      system: SYSTEM_PROMPT,
      messages: conv.messages,
    });

    const aiMessage = response.content[0].text;
    conv.messages.push({ role: 'assistant', content: aiMessage });
    conv.transcript += `Receptionist: ${aiMessage}\n`;

    const twiml = new twilio.twiml.VoiceResponse();

    // Check if call should be escalated or ended
    const shouldEscalate = aiMessage.toLowerCase().includes('transfer') ||
                          aiMessage.toLowerCase().includes('agent') ||
                          aiMessage.toLowerCase().includes('speak to');

    if (shouldEscalate || conv.messages.length > 12) {
      // Log and handle escalation
      await logCall(conv.clientId, conv.fromNumber, conv.toNumber, conv.transcript,
                   Math.round((Date.now() - conv.startTime) / 1000), 'escalated', 'transferred');

      const config = await getClientConfig(ClientID);
      if (config?.EscalationNumber) {
        twiml.say("Connecting you to someone on our team.");
        twiml.dial(config.EscalationNumber);
      } else {
        twiml.say("Let me record a message for our team.");
        twiml.record({ maxLength: 120, action: `/voicemail?CallSid=${CallSid}&ClientID=${ClientID}` });
      }
    } else {
      // Continue conversation
      const gather = twiml.gather({
        input: 'speech',
        speechTimeout: 'auto',
        action: `/handle-input?CallSid=${CallSid}&ClientID=${ClientID}`,
        method: 'POST',
        timeout: 5,
        numDigits: 0,
      });
      gather.say(aiMessage);
    }

    res.type('text/xml').send(twiml.toString());
  } catch (error) {
    console.error('Error:', error);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("Sorry, I encountered an error. Please try again.");
    res.type('text/xml').send(twiml.toString());
  }
});

// Handle voicemail
app.post('/voicemail', async (req, res) => {
  const { CallSid, ClientID } = req.query;
  const { RecordingUrl } = req.body;
  const conv = conversations[CallSid];

  if (conv) {
    await logCall(conv.clientId, conv.fromNumber, conv.toNumber,
                 conv.transcript + `\n[Voicemail: ${RecordingUrl}]`,
                 Math.round((Date.now() - conv.startTime) / 1000), 'message', 'voicemail');
  }

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("Thank you. Your message has been saved. Goodbye.");
  res.type('text/xml').send(twiml.toString());
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AI Receptionist running on port ${PORT}`);
  console.log(`Webhook URL: https://yourdomain.com/voice?clientId=YOUR_CLIENT_ID`);
});