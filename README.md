# PluckTube — YouTube to MP3 & MP4

Paste a YouTube link, see every quality + file size, download as MP4 or MP3.

## Why Fetch failed on Vercel

The error in your screenshot — `yt-dlp is not installed or not on PATH` — is
expected on Vercel, not a bug in your code:

- `server.js` shells out to the **`yt-dlp` binary** (plus `ffmpeg` for MP3/merge).
  Your laptop has both on PATH, so it works locally.
- **Vercel serverless has neither.** No Python/pip binary, no ffmpeg, no
  `spawn('yt-dlp')`, a 10–60s function timeout, and a ~4.5MB response limit —
  so `/api/info` always 502'd and the Fetch button could never work there.

This repo now has **two engines**:

| Engine | Where | What you get |
|---|---|---|
| `ytdlp` (full) | Local, Docker, Render/Railway/Fly/VPS | Every quality 144p→4K, merged MP4, true MP3 96–320kbps |
| `compat` (fallback) | Vercel serverless (`api/*.js`, no binaries) | Metadata + **360p MP4 only** (YouTube bot-checks block the rest without a PO token) |

The app picks automatically: yt-dlp when the binary exists, compat otherwise.
The UI tells you which one served the video.

## Run it locally (full quality, Windows)

```powershell
cd "F:\Code Playground\Projects\Websites\PluckTube"
npm install
npm start
# open http://localhost:3000
```

Requirements: Node 18+, `yt-dlp` on PATH (`pip install -U yt-dlp`),
`ffmpeg` on PATH (`winget install Gyan.FFmpeg`).
Check: `GET /api/health` → `{ engine: "ytdlp" }`.

## Deploy option A — Vercel only (compat mode, 360p)

Just redeploy. `vercel.json` serves `public/` statically and `api/*.js` as
functions (`maxDuration: 60`). No env vars needed. Fetch works immediately,
limited to 360p MP4 — the banner in the UI says so.

```powershell
vercel --prod
```

## Deploy option B — full quality (recommended)

1. Deploy this repo as a **Docker** service on Render / Railway / Fly:
   - Render: New → Web Service → select repo → Runtime: Docker → deploy.
     Health check path: `/api/health`.
   - Or: `docker build -t plucktube .` / `docker run -p 3000:3000 plucktube`.
2. Point the Vercel UI at it — in Vercel dashboard add a rewrite, or edit
   `vercel.json`:

```json
{
  "rewrites": [{ "source": "/api/:path*", "destination": "https://YOUR-BACKEND.onrender.com/api/:path*" }]
}
```

3. Redeploy Vercel. `/api/health` should now report `{ engine: "ytdlp" }`,
   and Fetch returns the full ladder + MP3.

## What it does

- `GET /api/info?url=` → title, channel, duration, views, thumbnail, tags +
  curated ladders (`mp4_ladder`, `audio_only`, `video_only`, `formats`) with
  `size_bytes` / `size_label`. Includes `engine: "ytdlp" | "compat"`.
- `GET /api/download?url=&mode=mp4&height=720` → merged MP4 (ytdlp) or
  302-redirect to the progressive stream (compat, no size/timeout limits).
- `GET /api/download?url=&mode=mp3&quality=192` → true MP3 (ytdlp only;
  compat returns a clear error telling you to use the full backend).
- `GET /api/download?url=&mode=best` → best merged MP4 (ytdlp) / best
  progressive (compat).
- `GET /api/download?url=&format_id=22` → raw format (ytdlp) / itag redirect (compat).
- `GET /api/health` → `{ engine, ytdlp? }`.

Frontend (`public/`): no build step — input + fetch, video card, Quick MP4/MP3
buttons, 3 tabs (Video / Audio / All), thumbnail/title/link copy,
localStorage history, compat-mode banner.

## Notes

- Personal / fair-use downloads only. Respect creators and copyright.
- Live streams, DRM, age-gated, and login-walled videos fail with a message.
- YouTube aggressively blocks datacenter IPs — if Vercel compat mode 502s on
  a specific video, try the full backend or a different network.
