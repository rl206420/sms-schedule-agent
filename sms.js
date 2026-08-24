// api/sms.js
// Vercel serverless function: Twilio SMS webhook -> Claude parsing -> Google Calendar event
//
// Deploy this to Vercel. Set the resulting URL (https://your-project.vercel.app/api/sms)
// as your Twilio number's "A Message Comes In" webhook (HTTP POST).

const Anthropic = require("@anthropic-ai/sdk");
const { google } = require("googleapis");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Map incoming phone numbers -> kid names, e.g.
// KID_MAP='{"+14255551234":"Jake","+14255555678":"Emma"}'
const KID_MAP = JSON.parse(process.env.KID_MAP || "{}");

// Timezone used when Claude has to interpret relative dates ("Tuesday", "this Saturday")
const TIMEZONE = process.env.TIMEZONE || "America/Los_Angeles";

function getGoogleCalendarClient() {
  // Service account credentials (JSON) stored as a single env var.
  // In Google Cloud, share your calendar with the service account's email
  // (found in the credentials JSON as "client_email") with "Make changes to events" permission.
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  return google.calendar({ version: "v3", auth });
}

async function parseScheduleWithClaude(rawText, kidName, todayIso) {
  const prompt = `You are extracting sports schedule events from a text message so they can be added to a calendar.

Today's date is ${todayIso} (timezone: ${TIMEZONE}).
The message is from or about: ${kidName || "unknown sender"}.

Message: "${rawText}"

Extract every distinct event (practice, game, tournament, etc.) mentioned. For each event, resolve relative dates
("Tuesday", "this Saturday", "next week") to actual calendar dates based on today's date above. If no year is given,
assume the current or next upcoming occurrence. If a time is missing, use "TBD" for the time and default to a
90-minute all-day-ambiguous block starting at 4:00 PM local time. If a location is missing, leave it blank.

Respond with ONLY valid JSON, no preamble, no markdown fences, in this exact shape:

{
  "events": [
    {
      "title": "string, e.g. 'Jake - Soccer Practice'",
      "date": "YYYY-MM-DD",
      "start_time": "HH:MM" (24-hour, local time),
      "end_time": "HH:MM" (24-hour, local time; estimate 90 min after start if not given),
      "location": "string or empty",
      "notes": "string or empty, any extra detail from the message"
    }
  ]
}

If the message contains no identifiable event, respond with {"events": []}.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const cleaned = (textBlock?.text || "{}").replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(cleaned).events || [];
  } catch (err) {
    console.error("Failed to parse Claude response as JSON:", cleaned);
    return [];
  }
}

async function createCalendarEvent(calendar, event) {
  const startDateTime = `${event.date}T${event.start_time || "16:00"}:00`;
  const endDateTime = `${event.date}T${event.end_time || "17:30"}:00`;

  return calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
    requestBody: {
      summary: event.title,
      location: event.location || undefined,
      description: event.notes || undefined,
      start: { dateTime: startDateTime, timeZone: TIMEZONE },
      end: { dateTime: endDateTime, timeZone: TIMEZONE },
    },
  });
}

function twimlResponse(message) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response><Message>${message.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</Message></Response>`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  const from = req.body.From;
  const bodyText = req.body.Body;

  if (!bodyText || !bodyText.trim()) {
    res.status(200).set("Content-Type", "text/xml").send(twimlResponse("Got an empty text, nothing added."));
    return;
  }

  const kidName = KID_MAP[from] || null;
  const todayIso = new Date().toISOString().slice(0, 10);

  try {
    const events = await parseScheduleWithClaude(bodyText, kidName, todayIso);

    if (events.length === 0) {
      res.status(200).set("Content-Type", "text/xml").send(
        twimlResponse("Couldn't find a schedule in that text — try including day, time, and sport.")
      );
      return;
    }

    const calendar = getGoogleCalendarClient();
    const created = [];

    for (const event of events) {
      await createCalendarEvent(calendar, event);
      created.push(`${event.title} on ${event.date}${event.start_time ? " at " + event.start_time : ""}`);
    }

    const confirmation =
      created.length === 1
        ? `Added: ${created[0]}`
        : `Added ${created.length} events:\n${created.join("\n")}`;

    res.status(200).set("Content-Type", "text/xml").send(twimlResponse(confirmation));
  } catch (err) {
    console.error("Error processing SMS:", err);
    res.status(200).set("Content-Type", "text/xml").send(
      twimlResponse("Something went wrong adding that to the calendar. It's been logged.")
    );
  }
};
