// api/feedback.js
// Vercel serverless function: customer SMS -> Claude classification -> Google Sheet log
// + auto-reply to customer + instant alert text to owner for complaints
//
// Deploy alongside api/sms.js. Point a SEPARATE Twilio number (or the same one,
// see routing note at the bottom) at this endpoint.

const Anthropic = require("@anthropic-ai/sdk");
const { google } = require("googleapis");
const twilio = require("twilio");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Owner's phone number to receive instant complaint alerts (E.164 format)
const OWNER_ALERT_NUMBER = process.env.OWNER_ALERT_NUMBER;

function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function classifyMessage(rawText) {
  const prompt = `Classify this incoming customer text message for a cannabis product company.

Message: "${rawText}"

Respond with ONLY valid JSON, no preamble, no markdown fences, in this exact shape:

{
  "category": "favorite_flavor" | "complaint" | "compliment" | "other",
  "sentiment": "positive" | "neutral" | "negative",
  "product_mentioned": "string or empty, e.g. a strain or flavor name if mentioned",
  "summary": "one sentence summarizing what the customer wants or is saying"
}

Rules:
- "favorite_flavor" = customer is naming a favorite existing flavor/strain, or answering "what's your favorite flavor?"
- "complaint" = any negative experience, product issue, or dissatisfaction
- "compliment" = positive feedback about a product or experience
- "other" = doesn't fit the above (general questions, spam, unclear)`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const cleaned = (textBlock?.text || "{}").replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("Failed to parse Claude classification:", cleaned);
    return {
      category: "other",
      sentiment: "neutral",
      product_mentioned: "",
      summary: rawText.slice(0, 100),
    };
  }
}

async function logToSheet(sheets, { from, rawText, classification }) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.FEEDBACK_SHEET_ID,
    range: "Feedback!A:G",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [
        [
          new Date().toISOString(),
          from,
          classification.category,
          classification.sentiment,
          classification.product_mentioned,
          classification.summary,
          rawText,
        ],
      ],
    },
  });
}

function channelsLine() {
  return " Come find us... like a game 👀";
}

function replyFor(classification) {
  switch (classification.category) {
    case "favorite_flavor":
      return `Love it, thanks for sharing!${channelsLine()}`;
    case "complaint":
      // Deliberately no channel links on complaints — not the moment to promote.
      return "We're sorry to hear that. This has been flagged for our team and someone will follow up with you soon.";
    case "compliment":
      return `Thank you so much, glad you're enjoying it!${channelsLine()}`;
    default:
      return `Thanks for reaching out!${channelsLine()}`;
  }
}

async function alertOwnerOfComplaint(from, classification, rawText) {
  if (!OWNER_ALERT_NUMBER) return;
  await twilioClient.messages.create({
    to: OWNER_ALERT_NUMBER,
    from: process.env.TWILIO_FROM_NUMBER,
    body: `COMPLAINT from ${from}: ${classification.summary}\n\nFull text: ${rawText}`,
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
    res.status(200).set("Content-Type", "text/xml").send(twimlResponse("Thanks for reaching out!"));
    return;
  }

  try {
    const classification = await classifyMessage(bodyText);
    const sheets = getSheetsClient();

    await logToSheet(sheets, { from, rawText: bodyText, classification });

    if (classification.category === "complaint") {
      await alertOwnerOfComplaint(from, classification, bodyText);
    }

    const reply = replyFor(classification);
    res.status(200).set("Content-Type", "text/xml").send(twimlResponse(reply));
  } catch (err) {
    console.error("Error processing feedback SMS:", err);
    res.status(200).set("Content-Type", "text/xml").send(
      twimlResponse("Thanks for your message — we've received it.")
    );
  }
};

/*
ROUTING NOTE if you want ONE number to handle both family schedules and
customer feedback: don't do that — keep them on separate Twilio numbers.
Mixing a private family line with a public customer-facing line creates
confusion (family texts triggering "complaint" classification, customers
seeing family calendar confirmations, etc.) and makes opt-out/compliance
handling messier. Two numbers, two webhooks (api/sms.js and api/feedback.js),
same Vercel project is the clean setup.
*/
