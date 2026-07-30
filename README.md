# MCCS Revenue Intelligence

An advanced analytics web app built on the original Revenue Intelligence prototype. It adds authenticated access, a Postgres data layer, an engageable sales dataset, and Ask Sage powered AI that narrates computed metrics.

Prototype using synthetic data. Not for operational use.

---

## What it does

**Scorecard.** Program level KPIs rolling up to three enterprise objectives, with a measurement health score and quantified opportunity cards. This is the anchor view.

**Sales and forecast.** Monthly revenue and gross margin, a three month projection with an 80 percent interval and a stated error rate, an installation heat table indexed to each installation's own average, and month over month movers.

**Promotion ROI.** Spend against return, spend weighted channel economics, and a campaign league table. Click any campaign for an AI assessment of whether to continue, rework, or stop it.

**Programs.** Portfolio view with margin rate, trend, and promotion efficiency per business line, plus a sustain, scale, or sunset recommendation with every input visible. Includes seasonally adjusted anomaly detection.

**Scenario.** What-if levers for demand, margin rate, and promotion budget, including reallocating spend out of campaigns that lose money. Results can be saved and explained by the AI.

**Data.** The full sales dataset, filterable and sortable, editable in place, with CSV import and export and a change history.

**AI analyst.** Executive briefing and grounded question answering. Every AI response is built from metrics computed server side, and every call is logged.

---

## Architecture

```
Browser ──▶ Express (server.js)
              ├─ /auth        sessions, users            ──▶ Postgres
              ├─ /api         data, analytics, scenarios ──▶ Postgres
              └─ /api/ai      grounded prompts           ──▶ Ask Sage API
```

Two things matter here:

1. **The AI never computes numbers.** `src/metrics.js` computes everything server side and passes a JSON digest to the model, which only writes prose. That is what makes "grounded in computed metrics" a true statement rather than a claim.
2. **The Ask Sage key never reaches the browser.** All AI calls are proxied through the server. If Ask Sage is unreachable, a deterministic built in writer produces the same content from the same metrics, and the interface shows which engine answered. A demo will not die on a bad network.

```
server.js       Express app, sessions, routing
db.js           Postgres pool and schema
auth.js         Login, roles, user management
asksage.js      Ask Sage client with token caching
metrics.js      All analytics: forecast, ROI, scorecard, anomalies, scenarios
api.js          Data and analytics endpoints
ai.js           AI endpoints with fallbacks
seed.js         Loads the dataset into Postgres
dataset.json    The synthetic dataset
login.html      Sign in page
app.html        Dashboard
app.css         Styles for both pages
client.js       Dashboard logic (browser)
package.json
render.yaml
```

Every file sits at the repo root. There are no subfolders, so `require` paths are all `./name`. The browser script is named `client.js` rather than `app.js` to keep it clearly separate from the server modules sitting beside it.

**Roles.** Viewer reads everything. Analyst can also edit data. Admin can manage accounts and see the AI call log.

---

## Step by step: from these files to a live site

### 1. Put the files in your repo

All 16 files go at the root of the repo, side by side. No subfolders.

```bash
cd your-repo
ls        # server.js, db.js, auth.js, ... package.json should all be here
git add .
git commit -m "MCCS Revenue Intelligence app"
git push origin main
```

Two things to confirm before pushing:

- `package.json` is at the repo root, not inside a folder. Render looks for it there and the build fails if it is nested.
- `.gitignore` is present, so `node_modules/` and `.env` are never committed.

### 2. Create the Postgres database on Render

1. Render dashboard, **New**, **Postgres**.
2. Name it `mccs-ri-db`, pick a region, choose a plan (the smallest paid tier is fine, the free tier expires).
3. Create it, then open it and copy the **Internal Database URL**.

Use the internal URL when the web service is in the same region. It is faster and does not leave Render's network.

### 3. Create the web service

1. **New**, **Web Service**, connect your GitHub repo.
2. Settings:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/healthz`

If you would rather have Render read `render.yaml`, choose **New**, **Blueprint** instead and point it at the repo. It will create both the database and the service.

### 4. Set environment variables

In the web service, open **Environment** and add:

| Key | Value |
|---|---|
| `DATABASE_URL` | the Internal Database URL from step 2 |
| `SESSION_SECRET` | run `openssl rand -hex 32` and paste the result |
| `ADMIN_EMAIL` | your email, this becomes the first admin |
| `ADMIN_PASSWORD` | a strong password, at least 10 characters |
| `ADMIN_NAME` | your name |
| `ASKSAGE_API_KEY` | your Ask Sage API key |
| `ASKSAGE_EMAIL` | the email on your Ask Sage account |
| `ASKSAGE_MODEL` | `gpt-4.1-mini`, or another model your account has |
| `AUTO_SEED` | `true` |
| `NODE_ENV` | `production` |

Leave `PORT` alone. Render sets it.

To get an Ask Sage API key: sign in to your Ask Sage instance, open account settings, and create an API key. The key and the account email are both required, because the app exchanges them for a 24 hour access token.

If your organization uses a different Ask Sage instance, also set `ASKSAGE_USER_BASE` and `ASKSAGE_SERVER_BASE` to match it. The `api.` prefix and the `/user/` and `/server/` suffixes stay the same, only the middle segment changes.

### 5. Deploy

Click **Manual Deploy**, then **Deploy latest commit**. Watch the logs for:

```
Schema ready.
Bootstrapped admin account: you@example.com
Sales rows: 1152
Campaigns: 48
MCCS Revenue Intelligence listening on 10000
Ask Sage configured: true
```

`Ask Sage configured: false` means the key or email is missing. The app still runs and uses the built in engine.

### 6. Sign in

Open your Render URL. You should land on the sign in page. Use `ADMIN_EMAIL` and `ADMIN_PASSWORD`.

First checks:
- The Scorecard tab shows a health percentage and populated objectives.
- The Sales tab renders the chart with a dashed forecast tail.
- On the AI analyst tab, the engine badge reads **engine: Ask Sage** with a green dot. If it is orange and reads **built-in metrics**, see troubleshooting.

### 7. Add the accounts you need for the meeting

Admin tab, add each person with the **viewer** role. Viewers can explore everything but cannot alter the data, which is what you want for a live audience.

### 8. Before you present

- Click through every tab once on the deployed URL, not on localhost.
- Generate the executive briefing so the first run is warm.
- Confirm the engine badge is green.
- Have the Promotion ROI tab ready, since that is where the money argument lands.

---

## Running locally

```bash
npm install
cp .env.example .env      # fill in DATABASE_URL and the Ask Sage values
npm run seed              # load the synthetic dataset (runs seed.js)
npm run dev               # http://localhost:3000
```

You need Postgres running locally. To create the database:

```bash
createdb mccs_ri
```

To wipe and reload the analytics data:

```bash
npm run seed:reset
```

---

## Using your own data

The CSV import on the Data tab expects these columns:

```csv
period,installation,business_line,category,revenue,gross_margin,units
2026-06,Quantico,MCX Retail,Electronics,251053,35734,982
```

`period` accepts `YYYY-MM` or `YYYY-MM-DD`. `gross_margin` and `units` are optional. Installations and categories must already exist, and rows referencing unknown ones are rejected with a line number so you can fix them.

Export first to get a correctly shaped template.

---

## Troubleshooting

**Engine badge says built-in metrics.** Open `/api/ai/status` in the browser while signed in. It returns the reason. Usually the API key or email is wrong, or the model name is not one your account can use. Try `gpt-4.1-mini`.

**Deploy fails on the database connection.** Confirm `DATABASE_URL` is set and that the database and web service are in the same region. The app enables SSL automatically for anything that is not localhost.

**Login redirects back to the login page.** `SESSION_SECRET` is probably missing, so sessions do not persist. Set it and redeploy.

**No data anywhere.** `AUTO_SEED` was not `true` on first boot. Set it and redeploy, or open a Render shell and run `npm run seed`.

**Charts do not render.** Chart.js loads from a CDN. If your network blocks `cdnjs.cloudflare.com`, download `chart.umd.min.js` next to the other files and add a route for it in `server.js` alongside the `/client.js` route, then point the script tag in `app.html` at it. Worth doing anyway if you might present from a restricted network.

**A campaign edit does not change the scorecard.** Refresh the filters or reload. The analytics payload is fetched per filter change.

---

## Security notes

Sessions are stored in Postgres, cookies are httpOnly and secure in production, passwords use bcrypt at 12 rounds, login is rate limited to 20 attempts per 15 minutes, and AI calls are rate limited per user per minute. Helmet sets a content security policy. Every data change and every AI call is written to an audit table.

This is a prototype on synthetic data. Before it touches real MCCS data it would need an authority to operate, an accreditation boundary, and an Ask Sage instance approved for that data classification.
