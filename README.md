# PluckTube — YouTube to MP3 & MP4

Paste a YouTube link, see every quality + file size, download as MP4 or MP3.

## Run it (Windows)

```powershell
cd "F:\Code Playground\Projects\Websites\youtube-downloader"
npm install
npm start
# open http://localhost:3000
```

Requirements (already present on this machine, verified):
- Node 18+
- `yt-dlp` on PATH (`pip install -U yt-dlp`)
- `ffmpeg` on PATH (`winget install Gyan.FFmpeg`)

## What it does

- `GET /api/info?url=` → title, channel, duration, views, thumbnail, tags,
  subtitles list + curated format ladders (`mp4_ladder`, `audio_only`,
  `video_only`, `formats`) with `size_bytes` / `size_label` per row.
- `GET /api/download?url=&mode=mp4&height=720` → merges best video ≤ height + best audio to MP4 (streamed, nothing stored).
- `GET /api/download?url=&mode=mp3&quality=192` → extracts MP3 96–320kbps via ffmpeg.
- `GET /api/download?url=&mode=best` → best merged MP4.
- `GET /api/download?url=&format_id=22` → raw format passthrough.
- `GET /api/health` → checks yt-dlp availability.

Frontend (`public/`): no build step — input + fetch, skeleton loader,
video card (thumbnail, duration, views, likes, date, tags), Quick MP4/MP3
buttons, 3 tabs (Video / Audio / All) with codec, FPS, size-on-disk column,
thumbnail/title/link copy, localStorage history, health pill.

## Notes

- Personal / fair-use downloads only. Respect creators and copyright.
- Live streams and DRM/age-gated videos may fail — error is shown in UI.
