# Running Wes World on Azure

Everything here fits in always-free tiers. The one setting that decides whether
this costs $0 or ~$24/month is the Cosmos DB free-tier checkbox in step 1 —
don't skip past it.

```
Browser ──/.auth/*──►  Static Web Apps built-in auth  (Microsoft / GitHub)
        ──/api/*───►  Managed Azure Functions ──► Cosmos DB (free tier)
```

No SDK, no API key, and no secret in `index.html`. The session cookie rides
along with every `/api` call, and the platform hands the identity to the
Functions as a header.

---

## 1. Cosmos DB

Create an **Azure Cosmos DB for NoSQL** account.

- **Apply Free Tier Discount: Apply.** This is the whole ball game: 1000 RU/s
  and 25 GB free for the lifetime of the account. One free-tier account is
  allowed per subscription.
- Inside the account create:
  - Database `wesworld` — **Manual** throughput, **400 RU/s** (inside the free
    grant; autoscale starts at 1000 and leaves no headroom)
  - Container `entries`, **partition key `/kind`**

The app code deliberately never creates these. Provisioning throughput from code
is the usual way a "free" account quietly starts billing.

Copy a **primary connection string** from Keys — you'll need it twice.

## 2. Static Web App

Create a **Static Web App** on the **Free** plan, deployment source **Other**.

> Pick "Other", not GitHub. Choosing GitHub makes Azure commit a second
> deployment workflow that competes with the tested one in this repo.

Then:

1. **Overview → Manage deployment token** — copy it.
2. Save it as a GitHub secret so the existing workflow can deploy:
   ```
   gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN --repo haleyneiman/wes-world
   ```
3. **Settings → Environment variables**, add:
   | Name | Value |
   |---|---|
   | `COSMOS_CONNECTION_STRING` | the connection string from step 1 |
   | `COSMOS_DATABASE` | `wesworld` *(optional, this is the default)* |
   | `COSMOS_CONTAINER` | `entries` *(optional, this is the default)* |

If `node:20` is rejected for the API runtime, change `platform.apiRuntime` in
`staticwebapp.config.json` to `node:18`.

## 3. Invite yourselves

Signing in with a Microsoft or GitHub account only proves *who* someone is —
anyone in the world can do that. Reaching the data additionally needs the
**`family`** role, enforced in two places: `allowedRoles` on `/api/*`, and again
inside every Function.

1. Open the site and sign in. You'll be told you aren't invited yet, and the
   screen will show **your user ID** — copy it.
2. Azure portal → the Static Web App → **Role management** → **Invite**, and
   grant that user the role `family`.
3. Repeat for the second parent.

Free tier allows up to 25 invited users, which is 23 more than needed.

## 4. Bring Wesley's history across

1. Firebase console → Realtime Database → ⋮ → **Export JSON**.
2. Check what will be written:
   ```bash
   node tools/migrate-from-firebase.js ~/Downloads/wes-world-export.json
   ```
3. Write it:
   ```bash
   cd api && npm install && cd ..
   COSMOS_CONNECTION_STRING="<connection string>" \
     node tools/migrate-from-firebase.js ~/Downloads/wes-world-export.json --write
   ```

Firebase push keys become Cosmos document ids and the write is an upsert, so
re-running imports the same history once. Safe to repeat if it stops half way.

## 5. Go live

This work is on the `azure-backend` branch. `master` still runs the Firebase
backend, so **merge only once steps 1–4 are done** — merging earlier deploys an
app whose backend doesn't exist yet.

```bash
git checkout master && git merge azure-backend && git push origin master
```

## 6. Decommission

Once you've used the Azure app for a few days and are happy:

- **Netlify** — delete the site.
- **Firebase** — delete the Realtime Database and disable Authentication.
  Keep the export file somewhere safe first.

---

## What changed behaviourally

| | Before (Firebase) | Now (Azure) |
|---|---|---|
| Sign-in | Google or email/password | Microsoft or GitHub |
| Access control | any signed-in user | invited accounts only (`family` role) |
| Other parent's changes | pushed instantly | polled every 45s, and immediately whenever the app is reopened |
| Offline writes | queued by the SDK | queued in a local outbox, drained on reconnect |

The sign-in change is forced by the free tier: custom providers like Google
require the Standard plan at $9/month, which is what we were avoiding.

Losing instant push is the real trade. For two people who mostly aren't logging
at the same moment, a refresh-on-open plus a 45s poll covers it — but if it ever
feels stale, Azure SignalR's free tier (20 connections, 20k messages/day) is the
upgrade path, and only `refresh()` would need to change.
