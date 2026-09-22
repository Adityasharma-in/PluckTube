# PluckTube full backend — yt-dlp + ffmpeg (for Render / Railway / Fly / VPS).
# Vercel can't run this (no binaries, no long-lived processes), so the
# full-quality engine lives here and the Vercel app falls back to compat mode.
FROM node:20-slim

# Python + ffmpeg + curl for yt-dlp
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --no-cache-dir --break-system-packages -U yt-dlp

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
