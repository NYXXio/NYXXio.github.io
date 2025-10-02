// index.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const {google} = require('googleapis');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json());

// config
const PORT = process.env.PORT || 3000;
const CALENDAR_ID = process.env.CALENDAR_ID; // e.g. restaurant@example.com or calendarId

if(!CALENDAR_ID) {
  console.error('Missing CALENDAR_ID in env. Set CALENDAR_ID to your Google Calendar ID.');
  process.exit(1);
}

// Build Google auth client once
async function getAuthClient() {
  // If GOOGLE_SERVICE_ACCOUNT_KEY (raw JSON) provided, use it.
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/calendar']
    });
  }

  // Otherwise rely on GOOGLE_APPLICATION_CREDENTIALS path (recommended)
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const keyFilePath = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    if (!fs.existsSync(keyFilePath)) {
      throw new Error(`Service account key file not found at ${keyFilePath}`);
    }
    return new google.auth.GoogleAuth({
      keyFile: keyFilePath,
      scopes: ['https://www.googleapis.com/auth/calendar']
    });
  }

  throw new Error('No Google service account credentials found in env. Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_KEY.');
}

// Helper to create calendar API client
async function getCalendar() {
  const auth = await getAuthClient();
  const authClient = await auth.getClient();
  return google.calendar({version: 'v3', auth: authClient});
}

// Basic input validation
function validateReservation(body) {
  const { name, email, phone, startDateTime, endDateTime, partySize, notes } = body;
  if (!name || !startDateTime) return 'name and startDateTime are required';
  // startDateTime should be ISO string or parseable date
  const start = new Date(startDateTime);
  if (Number.isNaN(start.getTime())) return 'startDateTime must be a valid ISO datetime';
  if (endDateTime) {
    const end = new Date(endDateTime);
    if (Number.isNaN(end.getTime())) return 'endDateTime must be a valid ISO datetime';
    if (end <= start) return 'endDateTime must be after startDateTime';
  }
  return null;
}

// POST /api/reservations
// JSON body example:
// { "name":"John Doe", "email":"john@example.com", "phone":"+3711234567",
//   "startDateTime":"2025-10-12T19:00:00", "endDateTime":"2025-10-12T21:00:00",
//   "partySize":4, "notes":"Allergic to nuts" }
app.post('/api/reservations', async (req, res) => {
  try {
    const err = validateReservation(req.body);
    if (err) return res.status(400).json({ error: err });

    const {
      name,
      email,
      phone = '',
      startDateTime,
      endDateTime = null,
      partySize = null,
      notes = ''
    } = req.body;

    // Default duration: 2 hours if no end provided
    const start = new Date(startDateTime);
    const end = endDateTime ? new Date(endDateTime) : new Date(start.getTime() + 2 * 60 * 60 * 1000);

    // Ensure timezone set — restaurant timezone is Europe/Riga
    // We will set start/end in ISO with timezone offset
    const startISO = start.toISOString();
    const endISO = end.toISOString();

    const calendar = await getCalendar();

    // Build event summary and description
    const summary = `Reservation: ${name}${partySize ? ` — party of ${partySize}` : ''}`;
    let description = `Name: ${name}\n`;
    if (email) description += `Email: ${email}\n`;
    if (phone) description += `Phone: ${phone}\n`;
    if (partySize) description += `Party size: ${partySize}\n`;
    if (notes) description += `Notes: ${notes}\n`;
    description += `Created by: website reservation API`;

    const event = {
      summary,
      description,
      start: { dateTime: startISO, timeZone: 'Europe/Riga' },
      end: { dateTime: endISO, timeZone: 'Europe/Riga' },
      // optional: add guests as attendees (this will send invites if configured)
      attendees: email ? [{ email }] : [],
      // optional: set reminders
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 }, // 1 hour prior popup (in calendar UI)
          { method: 'email', minutes: 24 * 60 } // 24 hours email
        ]
      }
    };

    const created = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: event,
      sendUpdates: 'none' // set to 'all' to email attendees
    });

    return res.status(201).json({
      message: 'Reservation created',
      eventId: created.data.id,
      htmlLink: created.data.htmlLink,
      createdEvent: created.data
    });

  } catch (error) {
    console.error('Error creating reservation event:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Basic health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Reservation API listening on http://localhost:${PORT}`);
});
