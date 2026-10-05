> For this repository, run commands from `web/`. Use a separate Supabase project and apply `web/supabase/schema.sql`. The incompatible root migrations have been removed. Copy `web/.env.example` to `web/.env.local` and supply the new project URL and public publishable/anon key.

# Development environment — installation, configuration, run

Both applications (Encoder and Decoder) live in the same Next.js project and share
one Supabase backend, so this procedure is common to both. Allow about 15 minutes.

## 1. Tools to install

| Tool | Version | Check | Where |
|---|---|---|---|
| Node.js (includes npm) | 20.9 or newer | `node -v` | https://nodejs.org |
| Git | any | `git --version` | https://git-scm.com |
| A Supabase account | free tier is enough | — | https://supabase.com |
| Chrome, Edge, Firefox or Safari | recent | — | Encoder needs camera access |
| Code editor (optional) | VS Code recommended | — | https://code.visualstudio.com |

No database, Docker or native SDK is required on the computer: the database is hosted by Supabase.

## 2. Get the code and install dependencies

```bash
git clone https://github.com/kunjasrujanasri-afk/Dashcam_Assurance_Project.git
cd Dashcam_Assurance_Project/web
npm ci            # installs exactly the versions in package-lock.json
```

Main dependencies (see `package.json`): Next.js 16, React 19, TypeScript 5, Tailwind CSS 4,
`@supabase/supabase-js` 2, and `tsx` (dev only, runs the automated self-test).

## 3. Create and configure the Supabase backend

1. On https://supabase.com create a new project (any region, keep the database password).
2. Open **SQL Editor → New query**, paste the whole content of `supabase/schema.sql`, click **Run**.
   It creates the `devices` and `video_segments` tables, the immutability triggers,
   the row-level-security policies, the retention purge function, the private
   storage bucket `evidence` and the Realtime publication. The script is idempotent
   (safe to run again).
3. *(Recommended)* **Database → Extensions → enable `pg_cron`**, then run the script once more:
   the expired-hash purge is then scheduled every 15 minutes. Without pg_cron the purge
   can still be triggered from the Decoder ("Run retention purge").
4. Check **Database → Publications → supabase_realtime** contains `video_segments`
   (the script does it; this is only a check).
5. Copy **Project Settings → API**: the *Project URL* and the *anon / publishable* key.

## 4. Environment variables

Create a file named `.env.local` inside `web/` (it is git-ignored):

```env
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<anon-or-publishable-key>
```

If they are missing, both pages display a red configuration warning.

## 5. Run

```bash
npm run dev          # http://localhost:3000        → Encoder (driver)
                     # http://localhost:3000/admin  → Decoder (insurer)
```

Camera access and Web Crypto only work in a **secure context** (HTTPS or `localhost`).
On the computer, `http://localhost:3000` is fine. To use a **real smartphone** as the
dashcam, choose one of:

* **Same Wi-Fi, self-signed HTTPS** (quickest):
  ```bash
  npm run dev:https    # next dev --experimental-https -H 0.0.0.0
  ```
  On the phone open `https://<computer-LAN-IP>:3000` (find the IP with `ipconfig getifaddr en0`
  on macOS or `ipconfig` on Windows) and accept the certificate warning once.
* **Public HTTPS URL**: deploy to Vercel (`npx vercel`, add the two env vars in the
  Vercel project settings), or expose the dev server with a tunnel such as
  `npx localtunnel --port 3000` / `ngrok http 3000`.

On the phone, allow camera (and optionally location) access, keep the screen on and
the browser in the foreground (the app requests a screen wake lock).

## 6. Production build (optional)

```bash
npm run build && npm start
```

## 7. Automated checks

```bash
npm run typecheck    # TypeScript, no errors expected
npm run lint         # ESLint
npm run selftest     # integrity protocol + Decoder verification test (15 cases, no network needed)
```

Expected `selftest` output ends with `All tests passed`. It covers: authentic evidence,
1-bit corruption, edited block, truncation, removed segment, renamed/reordered files,
altered server record, deleted server record, record re-signed with a foreign key,
unrelated file, duplicate submission.

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Camera and Web Crypto need a secure context" | Page opened over plain `http://<IP>` — use `npm run dev:https` or an HTTPS URL. |
| "Supabase is not configured" | `.env.local` missing or dev server not restarted after creating it. |
| Hashes stay in the outbox with "Server rejected … relation does not exist" | `schema.sql` not run on this Supabase project. |
| Decoder "Realtime error" | Table not in the `supabase_realtime` publication (step 3.4). |
| "Browse submitted clips" fails | Storage bucket / policies missing — re-run `schema.sql`. |
| iPhone: no video recorded | Use iOS 15+ Safari; the app records MP4 automatically when WebM is unsupported. |
