// PluckTube — Express + yt-dlp backend (full quality), with pure-JS fallback.
//
// PRIMARY (local / VPS / Render / Railway / Fly): yt-dlp + ffmpeg on PATH
//   → every quality, merged MP4, true MP3. This is the full product.
// FALLBACK (Vercel serverless, no binaries): youtubei.js via lib/compat.js
//   → metadata + 360p MP4. Enough for the Fetch button to work everywhere.
//
// Run locally: npm install && npm start -> http://localhost:3000
// Deploy full backend: see Dockerfile + README (Render/Railway/Fly).
// Deploy UI only: Vercel serves public/ + api/*.js (compat mode).
const express = require('express');
const cors = require('cors');
const path = require('path');
const { spawn, execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- shared validation ----------
const YT_URL_RE = /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com\/(watch|shorts|live|embed|v\/)|youtu\.be\/)[\w\-?&=;+/%#:.@!$,~'()*[\]]+$/;

function isValidYouTubeUrl(u) {
  if (typeof u !== 'string' || u.length > 2048) return false;
  return YT_URL_RE.test(u.trim());
}

function isValidFormatSelector(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 200) return false;
  return /^[a-zA-Z0-9_\-+*/\[\]()<>=!.,?: ]+$/.test(s);
}

// ---------- yt-dlp engine ----------
let YTDLP_OK = false;
let YTDLP_VERSION = null;

function checkYtDlp() {
  return new Promise((resolve) => {
    execFile('yt-dlp', ['--version'], { timeout: 10000, windowsHide: true }, (err, stdout) => {
      if (err) {
        YTDLP_OK = false;
        YTDLP_VERSION = null;
        resolve(false);
      } else {
        YTDLP_OK = true;
        YTDLP_VERSION = String(stdout || '').trim().split('\n')[0];
        resolve(true);
      }
    });
  });
}

function runYtDlp(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('yt-dlp timed out. Try again.'));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > 15 * 1024 * 1024) child.kill('SIGKILL');
    });
    child.stderr.on('data', (d) => { stderr += d.toString().slice(0, 4000); });
    child.on('error', () => {
      clearTimeout(timer);
      const e = new Error('YTDLP_MISSING');
      e.code = 'YTDLP_MISSING';
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(cleanYtDlpError(stderr) || `yt-dlp exited with code ${code}`));
    });
  });
}

function cleanYtDlpError(stderr) {
  if (!stderr) return '';
  const lines = stderr.split('\n').map(l => l.replace(/^ERROR:\s*/i, '').trim()).filter(Boolean);
  const last = lines.slice(-3).join(' ');
  if (/private|login/i.test(last)) return 'This video is private or requires login.';
  if (/age/i.test(last)) return 'Age-restricted video — cannot fetch without login.';
  if (/unavailable|deleted|removed/i.test(last)) return 'Video is unavailable, deleted, or region-blocked.';
  if (/unsupported url/i.test(last)) return 'Unsupported URL. Use a youtube.com/watch, youtu.be, shorts or music.youtube link.';
  return last.slice(0, 300);
}

function formatBytes(n) {
  if (n == null || isNaN(n)) return null;
  if (n === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2)} ${u[i]}`;
}

function pickThumb(thumbnails, fallback) {
  if (Array.isArray(thumbnails) && thumbnails.length) {
    const sorted = [...thumbnails].filter(t => t.url).sort((a, b) => (b.width || 0) - (a.width || 0));
    return sorted[0]?.url || fallback;
  }
  return fallback;
}

async function infoViaYtDlp(url) {
  const { stdout } = await runYtDlp(
    ['--dump-single-json', '--no-playlist', '--no-warnings', '--no-check-certificate', '--socket-timeout', '15', url],
    { timeoutMs: 45000 }
  );
  let data;
  try { data = JSON.parse(stdout); }
  catch { throw new Error('Could not parse video info. Try again.'); }

  if (data._type === 'playlist') {
    throw new Error('Playlist links are not supported. Open a single video.');
  }

  const formats = (Array.isArray(data.formats) ? data.formats : [])
    .filter(f => f.format_id && f.url && !/storyboard|mhtml/i.test(f.format_id + ' ' + (f.protocol || '')))
    .map(f => ({
      format_id: String(f.format_id),
      ext: f.ext || '',
      resolution: f.resolution || (f.width ? `${f.width}x${f.height}` : 'audio only'),
      width: f.width || null,
      height: f.height || null,
      fps: f.fps || null,
      vcodec: f.vcodec || null,
      acodec: f.acodec || null,
      abr: f.abr || null,
      vbr: f.vbr || null,
      tbr: f.tbr || null,
      asr: f.asr || null,
      filesize: f.filesize ?? null,
      filesize_approx: f.filesize_approx ?? null,
      size_bytes: f.filesize ?? f.filesize_approx ?? null,
      size_label: formatBytes(f.filesize ?? f.filesize_approx),
      format_note: f.format_note || '',
      quality: f.quality ?? null,
      protocol: f.protocol || '',
      has_video: f.vcodec && f.vcodec !== 'none',
      has_audio: f.acodec && f.acodec !== 'none',
    }))
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0));

  const bestAudio = formats.filter(f => !f.has_video && f.has_audio).slice(0, 12);
  const videoOnly = formats.filter(f => f.has_video && !f.has_audio).slice(0, 24);
  const progressive = formats.filter(f => f.has_video && f.has_audio);

  const seenHeights = new Set();
  const mp4Ladder = [];
  const topAudioBytes = (bestAudio.find(f => f.size_bytes != null) || {}).size_bytes || null;
  for (const f of formats) {
    if (!f.has_video || !f.height) continue;
    if (seenHeights.has(f.height)) continue;
    const sameHeight = formats.filter(x => x.height === f.height && x.has_video);
    const prog = sameHeight.find(x => x.has_video && x.has_audio && x.ext === 'mp4')
      || sameHeight.find(x => x.has_video && x.has_audio)
      || sameHeight.find(x => x.ext === 'mp4')
      || sameHeight[0];
    if (!prog) continue;
    seenHeights.add(f.height);
    let entry = prog;
    if (entry.size_bytes == null) {
      const vBytes = sameHeight.map(x => x.size_bytes).find(n => n != null);
      if (vBytes != null && topAudioBytes != null) {
        entry = {
          ...prog,
          size_bytes: vBytes + topAudioBytes,
          size_label: formatBytes(vBytes + topAudioBytes),
          format_note: (prog.format_note ? prog.format_note + ' ' : '') + '+ audio (est. merged)',
          has_audio: true,
        };
      }
    }
    mp4Ladder.push(entry);
    if (mp4Ladder.length >= 8) break;
  }

  const audioLadder = [...formats]
    .filter(f => f.has_audio && /m4a|webm|mp3|opus|mp4a/i.test((f.ext || '') + ' ' + (f.acodec || '')))
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))
    .slice(0, 8);

  return {
    engine: 'ytdlp',
    id: data.id,
    title: data.title || 'Untitled',
    uploader: data.uploader || data.channel || data.uploader_id || 'Unknown channel',
    channel_id: data.channel_id || null,
    duration: data.duration || null,
    duration_string: data.duration_string || null,
    view_count: data.view_count ?? null,
    like_count: data.like_count ?? null,
    upload_date: data.upload_date || null,
    description: (data.description || '').slice(0, 2000),
    thumbnail: pickThumb(data.thumbnails, data.thumbnail),
    webpage_url: data.webpage_url || url,
    is_live: !!data.is_live,
    was_live: !!data.was_live,
    age_limit: data.age_limit || 0,
    categories: data.categories || [],
    tags: (data.tags || []).slice(0, 20),
    subtitles: data.subtitles ? Object.keys(data.subtitles).slice(0, 40) : [],
    automatic_captions: data.automatic_captions ? Object.keys(data.automatic_captions).slice(0, 10) : [],
    format_count: formats.length,
    formats: formats.slice(0, 60),
    mp4_ladder: mp4Ladder,
    progressive,
    video_only: videoOnly,
    audio_only: bestAudio,
    audio_ladder: audioLadder,
  };
}

// Compat engine is lazy-required so `npm start` works even if youtubei.js
// is missing (pure yt-dlp setups). Vercel installs full deps, so fine.
function infoViaCompat(url) {
  const compat = require('./lib/compat');
  return compat.getVideoInfo(url);
}

// ---------- API: video info ----------
app.get('/api/info', async (req, res) => {
  const url = (req.query.url || '').trim();
  if (!isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Enter a valid YouTube URL (watch, youtu.be, shorts, music).' });
  }
  // Prefer yt-dlp (full quality). Fall back to compat when binary is missing
  // (Vercel) instead of returning the scary "not installed" error.
  if (YTDLP_OK) {
    try {
      const payload = await infoViaYtDlp(url);
      return res.json(payload);
    } catch (e) {
      if (e.code !== 'YTDLP_MISSING') return res.status(502).json({ error: e.message || 'Failed to fetch video info.' });
      YTDLP_OK = false; // binary vanished mid-run → fall through to compat
    }
  }
  try {
    const payload = await infoViaCompat(url);
    return res.json(payload);
  } catch (e) {
    return res.status(502).json({ error: e.message || 'Failed to fetch video info.' });
  }
});

// ---------- API: download ----------
app.get('/api/download', async (req, res) => {
  const url = (req.query.url || '').trim();
  const mode = (req.query.mode || 'raw').toString();
  const formatId = (req.query.format_id || req.query.format || '').toString();
  const height = parseInt(req.query.height || '0', 10);
  const mp3Quality = (req.query.quality || '192').toString();

  if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid YouTube URL.' });

  // Compat path (no yt-dlp): redirect to the deciphered progressive stream.
  // Redirects avoid Vercel's 4.5MB / timeout limits entirely.
  if (!YTDLP_OK) {
    try {
      const compat = require('./lib/compat');
      const dl = await compat.resolveDownload(url, { mode, formatId, height });
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(dl.filename)}`);
      return res.redirect(302, dl.redirectUrl);
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  let safeTitle = (req.query.title || 'youtube-video').toString().slice(0, 120)
    .replace(/[\\/:*?"<>|#%&{}$!'@+=`~]/g, '').replace(/\s+/g, ' ').trim() || 'youtube-video';

  try {
    let args = [];
    let filename = safeTitle;
    let contentType = 'application/octet-stream';

    if (mode === 'mp3') {
      const q = ['320', '256', '192', '128', '96'].includes(mp3Quality) ? mp3Quality : '192';
      args = ['--no-playlist', '--no-warnings', '-x', '--audio-format', 'mp3',
        '--audio-quality', `${q}K`, '--embed-metadata', '-o', '-', url];
      filename += ` [${q}kbps].mp3`;
      contentType = 'audio/mpeg';
    } else if (mode === 'mp4' && height > 0) {
      const h = Math.min(Math.max(height, 144), 4320);
      args = ['--no-playlist', '--no-warnings',
        '-f', `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`,
        '--merge-output-format', 'mp4', '--embed-metadata', '--embed-thumbnail', '--embed-subs',
        '-o', '-', url];
      filename += ` [${h}p].mp4`;
      contentType = 'video/mp4';
    } else if (mode === 'best') {
      args = ['--no-playlist', '--no-warnings', '-f', 'bv*+ba/b',
        '--merge-output-format', 'mp4', '--embed-metadata', '-o', '-', url];
      filename += ` [best].mp4`;
      contentType = 'video/mp4';
    } else {
      if (!isValidFormatSelector(formatId)) return res.status(400).json({ error: 'Invalid format selected.' });
      const wantsAudioOnly = /audio/i.test(req.query.kind || '');
      args = ['--no-playlist', '--no-warnings', '-f', formatId, '-o', '-', url];
      filename += ` [${formatId}].${wantsAudioOnly ? 'm4a' : 'mp4'}`;
      contentType = wantsAudioOnly ? 'audio/mp4' : 'video/mp4';
    }

    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-File-Name', encodeURIComponent(filename));

    const child = spawn('yt-dlp', args, { windowsHide: true });
    let stderrTail = '';

    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-3000); });
    child.on('error', () => {
      // yt-dlp disappeared → mark unavailable; this request can't recover
      // mid-stream, but the next one will use compat mode.
      YTDLP_OK = false;
      try { if (!res.headersSent) res.status(500).json({ error: 'Video engine unavailable. Try again (compatibility mode).' }); else res.end(); }
      catch { /* noop */ }
    });
    child.on('close', (code) => {
      if (!res.writableEnded) res.end();
    });

    child.stdout.pipe(res);
    req.on('close', () => { try { child.kill('SIGKILL'); } catch { /* noop */ } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- API: health ----------
app.get('/api/health', async (req, res) => {
  if (YTDLP_OK) return res.json({ ok: true, engine: 'ytdlp', ytdlp: YTDLP_VERSION });
  try {
    await checkYtDlp();
    if (YTDLP_OK) return res.json({ ok: true, engine: 'ytdlp', ytdlp: YTDLP_VERSION });
  } catch { /* fall through */ }
  res.json({
    ok: true,
    engine: 'compat',
    note: 'yt-dlp not found — running in compatibility mode (metadata + 360p MP4). Install yt-dlp + ffmpeg for full quality.',
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

checkYtDlp().then((ok) => {
  app.listen(PORT, () => {
    console.log(`\n  ▶ PluckTube running at http://localhost:${PORT}`);
    console.log(`  ▶ Engine: ${ok ? `yt-dlp ${YTDLP_VERSION} (full quality)` : 'compat mode (metadata + 360p; install yt-dlp + ffmpeg for full quality)'}`);
    console.log(`  ▶ Health check: http://localhost:${PORT}/api/health\n`);
  });
});
