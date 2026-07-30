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
dataset.json    The dataset, generated from the spreadsheet
convert_excel.py  Regenerates dataset.json when the spreadsheet changes
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

## The data

The app ships with `dataset.json`, generated from `MCCS_Sales_Sample_Data.xlsx`: 18 months (Jan 2025 to Jun 2026), 8 installations, 4 business lines across 8 categories, 1,152 monthly sales records totalling $220.7M, and 48 campaigns.

Per record it carries transactions, units sold, gross revenue, COGS, and inventory on hand. Gross margin is never stored as an independent input, it is always computed as revenue minus COGS, so the two can never drift apart. Inventory is present only for MCX Retail, since the other lines hold no stock, and the app shows those as "no stock" rather than zero.

### Why the app can deploy with no data

`dataset.json` is the seed. If it is missing from the repo, the tables are created but stay empty, and the dashboard renders with nothing in it. This is the most common cause, and it is easy to miss when copying files by hand because it is the only `.json` among a set of `.js` files.

Check the Render deploy log. You are looking for:

```
Dataset: 1152 sales rows, 48 campaigns (from MCCS_Sales_Sample_Data.xlsx)
Seed complete: 1152 sales rows (2025-01 to 2026-06), 48 campaigns, total revenue $220,712,879
```

If instead you see `dataset.json was not found next to seed.js`, that is the problem. Commit the file and redeploy.

If you see `Sales data already present (0 rows). Skipping seed.` you have a different issue, and if you see nothing about seeding at all, `AUTO_SEED` is not set to `true`.

### Three ways to load data

**1. Commit `dataset.json` and let the app seed itself.** This is the default and needs no local tooling. Confirm `AUTO_SEED=true` in the Render environment, push, and the app loads the data on boot. To replace data that is already loaded, set `RESET_DATA=true`, redeploy once, then remove that variable so a later restart does not wipe edits made during a demo.

**2. Import a CSV through the app.** Sign in as an admin or analyst, open the Data tab, and use **Import CSV**. Good for adding a few months without a redeploy. Export first to get a correctly shaped file.

**3. Load Postgres directly.** Only if you want to bypass the app. Copy the External Database URL from Render and run `psql "$EXTERNAL_URL" -f yourfile.sql`. The internal URL only resolves from inside Render.

Option 1 is the right one for a deployment you control through GitHub.

### Refreshing from a new spreadsheet

When the source data changes, regenerate the seed file:

```bash
pip install pandas openpyxl        # once
python convert_excel.py MCCS_Sales_Sample_Data.xlsx
```

It rewrites `dataset.json` and prints what it found so you can sanity check the totals before committing. The converter validates that revenue minus COGS matches the sheet's own Gross Margin column and stops if they disagree, which catches a spreadsheet whose formulas were edited.

Commit `dataset.json`, set `RESET_DATA=true`, redeploy, then unset it.

The spreadsheet itself does not need to be in the repo. Only `dataset.json` is read at runtime.

### CSV format

```csv
period,installation,business_line,category,transactions,units_sold,revenue,cogs,inventory_units
2026-06,Quantico,MCX Retail,Electronics,982,1063,251053.40,215319.10,1712
```

`period` accepts `YYYY-MM` or `YYYY-MM-DD`. Only `period`, `installation`, `business_line`, `category`, and `revenue` are required. Leave `inventory_units` empty for lines that hold no stock. If you supply `gross_margin` instead of `cogs`, COGS is backed out of it. Installations and categories must already exist, and unknown ones are rejected with the line number.

---

## Step by step: from these files to a live site

### 1. Put the files in your repo

All files go at the root of the repo, side by side. No subfolders.

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

## Troubleshooting

**The dashboard is empty.** See "Why the app can deploy with no data" above. Almost always a missing `dataset.json` or `AUTO_SEED` not set to `true`.

**Engine badge says built-in metrics.** Open `/api/ai/status` in the browser while signed in. It returns the reason. Usually the API key or email is wrong, or the model name is not one your account can use. Try `gpt-4.1-mini`.

**Deploy fails on the database connection.** Confirm `DATABASE_URL` is set and that the database and web service are in the same region. The app enables SSL automatically for anything that is not localhost.

**Login redirects back to the login page.** `SESSION_SECRET` is probably missing, so sessions do not persist. Set it and redeploy.

**Charts do not render.** Chart.js loads from a CDN. If your network blocks `cdnjs.cloudflare.com`, download `chart.umd.min.js` next to the other files and add a route for it in `server.js` alongside the `/client.js` route, then point the script tag in `app.html` at it. Worth doing anyway if you might present from a restricted network.

**A campaign edit does not change the scorecard.** Refresh the filters or reload. The analytics payload is fetched per filter change.

---

## Security notes

Sessions are stored in Postgres, cookies are httpOnly and secure in production, passwords use bcrypt at 12 rounds, login is rate limited to 20 attempts per 15 minutes, and AI calls are rate limited per user per minute. Helmet sets a content security policy. Every data change and every AI call is written to an audit table.

This is a prototype on synthetic data. Before it touches real MCCS data it would need an authority to operate, an accreditation boundary, and an Ask Sage instance approved for that data classification.
