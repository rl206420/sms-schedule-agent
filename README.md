# SMS Sports Schedule Agent

Kids text their sports schedule to a phone number. Claude parses the message.
Events get created automatically on your Google Calendar.

## How it works

```
Kid's text  ->  Twilio number  ->  /api/sms webhook  ->  Claude (parse to JSON)  ->  Google Calendar API
                                                       ->  auto-reply text confirming what was added
```

## 1. Twilio

1. Sign up at twilio.com, buy a phone number (SMS-capable).
2. Note the number — this is what the kids text.
3. You'll set the webhook URL after deploying (step 4).

## 2. Google Calendar (service account — no manual login needed each time)

1. Go to console.cloud.google.com, create a project.
2. Enable the **Google Calendar API** for that project.
3. Create a **Service Account** (IAM & Admin > Service Accounts), then create a JSON key for it and download it.
4. Open your Google Calendar (the one you want events added to) > Settings > "Share with specific people" >
   add the service account's email (looks like `xxx@xxx.iam.gserviceaccount.com`) with **"Make changes to events"** permission.
5. Grab the Calendar ID from Settings > your calendar > "Integrate calendar" (or use `primary` for your main calendar).

## 3. Claude API

1. Sign up at console.anthropic.com, create an API key.

## 4. Deploy

1. Push this folder to a GitHub repo.
2. Go to vercel.com, import the repo, deploy (defaults are fine — Vercel auto-detects the `/api` folder).
3. In Vercel's project settings > Environment Variables, add everything from `.env.example`:
   - `ANTHROPIC_API_KEY`
   - `GOOGLE_SERVICE_ACCOUNT_JSON` — paste the **entire contents** of the downloaded JSON key file as one line
   - `GOOGLE_CALENDAR_ID`
   - `KID_MAP` — e.g. `{"+14255551234":"Jake","+14255555678":"Emma"}`
   - `TIMEZONE` — e.g. `America/Los_Angeles`
4. Redeploy after adding env vars.
5. Copy your deployed URL, e.g. `https://sms-schedule-agent.vercel.app/api/sms`.

## 5. Connect Twilio to your deployed function

1. In the Twilio console, open your phone number's settings.
2. Under "Messaging" > "A Message Comes In", set the webhook to your Vercel URL from step 4, method **HTTP POST**.
3. Save.

## 6. Test

Text the Twilio number something like:

> "Jake has soccer practice Tuesday at 4pm and a game Saturday 10am at the north field"

You should get an auto-reply confirming what was added, and the events should appear on the calendar within a few seconds.

---

## Customer Feedback Line (`api/feedback.js`)

A second, separate use of the same architecture: a public number customers text to share their favorite
flavor, or leave complaints/compliments. No retailer locator — your customers already know where to go.

**Use a SEPARATE Twilio number from the family schedule line.** Don't reuse the same number — mixing a
private family line with a public customer line causes classification confusion and messier compliance
handling (see the routing note at the bottom of `feedback.js`).

### Flow

```
Customer text -> Twilio number 2 -> /api/feedback -> Claude (classify) -> Google Sheet log
                                                    -> auto-reply to customer (with IG/website link)
                                                    -> instant alert text to you (complaints only)
```

Claude classifies every message into one of: `favorite_flavor`, `complaint`, `compliment`, `other` —
and each gets its own auto-reply and gets logged as a row in a Google Sheet you can scan later.
Replies to `favorite_flavor`, `compliment`, and `other` include your IG and website links; complaint
replies deliberately don't (not the moment to promote).

### Setup

1. **Second Twilio number** — buy one more SMS-capable number specifically for this line.
2. **Google Sheet** — create a new sheet with a tab named exactly `Feedback` and header row:
   `Timestamp | From | Category | Sentiment | Product | Summary | RawText`.
   Share it with your service account's email (same one from the calendar setup) with **Editor** access.
   Grab the Sheet ID from its URL: `docs.google.com/spreadsheets/d/THIS_PART/edit`.
3. **Twilio credentials for sending** — unlike the schedule line (which only replies via TwiML), this
   one also sends a proactive alert text for complaints, so it needs your Account SID and Auth Token
   from the Twilio console dashboard.
4. **Env vars** — add the "Customer feedback line" block from `.env.example` to Vercel:
   `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `OWNER_ALERT_NUMBER`,
   `FEEDBACK_SHEET_ID`.
5. **Twilio webhook** — on the *second* number's messaging settings, set "A Message Comes In" to
   `https://your-project.vercel.app/api/feedback`.

### On the "come find us" line

Replies to `favorite_flavor`, `compliment`, and `other` end with a playful "Come find us... like a
game 👀" — no links, no product names, no brand promotion. That keeps it well clear of LCB's SMS
advertising warning requirement (which is triggered by actual advertising content, not a vague,
link-free nudge). If you later want to add a link back in, revisit the compliance note that used to
live here — worth a quick check with Peter Rudolf at that point, not before.

### ⚠️ Before giving this number to customers

This is a **public-facing cannabis business SMS line**, which brings extra compliance considerations
beyond the family schedule bot:

- **Carrier/10DLC restrictions**: many carriers restrict or block cannabis-related SMS content outright,
  even for legal, licensed businesses. Check with Twilio's compliance/support team about your specific
  use case (customer service vs. marketing matters here) before registering your campaign.
- **TCPA consent**: customers texting in first (inbound) is generally lower-risk than you texting them
  first, but any follow-up marketing texts you send later need proper opt-in consent and STOP/HELP
  handling — Twilio handles STOP/HELP automatically for registered campaigns.
- **WSLCB advertising rules**: Washington cannabis advertising has its own restrictions (e.g. no health
  claims, audience composition requirements). Worth a quick sanity check with Peter Rudolf before this
  goes live publicly, since it's now a customer-facing channel rather than an internal tool.

None of this blocks building/testing it — just don't publish the number to customers until that's cleared.

### Customizing the classification or replies

- Edit the `RETAILER_TEXT` env var to include your actual retailer list or store locator link.
- To route by zip code (e.g. show the *nearest* retailer instead of a static list), the classifier
  already extracts `zip_code` when a customer gives one — you'd add a lookup against your retailer list
  in `replyFor()`.
- To also email yourself a daily digest instead of only instant complaint alerts, that would pull from
  the Google Sheet on a schedule (Vercel Cron) — happy to build that next if useful.

---

## Notes / things to watch

- **Unknown senders**: if a text comes from a number not in `KID_MAP`, the event still gets created but without a kid's name attached — worth adding every family member's number.
- **Ambiguous messages**: Claude defaults missing times to 4:00 PM and 90-minute durations. If a text is too vague to extract anything, no event is created and a reply asks for more detail.
- **Cost**: at family-texting volume, Twilio (~$1/mo number + ~$0.0079/text) and Claude API usage will run a few dollars a month total.
- **Security**: for a production/public setup you'd normally validate the `X-Twilio-Signature` header to confirm requests actually came from Twilio. Skipped here for simplicity since this is a private family number — ask if you want that added.
