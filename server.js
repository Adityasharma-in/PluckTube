// PluckTube — Express + yt-dlp backend
// Run: npm install && npm start  ->  http://localhost:3000
const express = require('express');
const cors = require('cors');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const YT_URL_RE = /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com\/(watch|shorts|live|embed|v\/)|youtu\.be\/)[\w\-?&=;+/%#:.@!$,~'()*[\]]+$/;

function isValidYouTubeUrl(u) {
  if (typeof u !== 'string' || u.length > 2048) return false;
  return YT_URL_RE.test(u.trim());
}

function isValidFormatSelector(s) {
  // allow yt-dlp format selectors like: 22, 18, bv*+ba/b, bestvideo[height<=720]+bestaudio/best
  if (typeof s !== 'string' || s.length === 0 || s.length > 200) return false;
  return /^[a-zA-Z0-9_\-+*/\[\]()<>=!.,?: ]+$/.test(s);
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
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error('yt-dlp is not installed or not on PATH. Install it: pip install -U yt-dlp'));
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
  // keep last meaningful line
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

// ---------- API: video info ----------
app.get('/api/info', async (req, res) => {
  const url = (req.query.url || '').trim();
  if (!isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Enter a valid YouTube URL (watch, youtu.be, shorts, music).' });
  }
  try {
    const { stdout } = await runYtDlp(
      ['--dump-single-json', '--no-playlist', '--no-warnings', '--no-check-certificate', '--socket-timeout', '15', url],
      { timeoutMs: 45000 }
    );
    let data;
    try { data = JSON.parse(stdout); }
    catch { return res.status(502).json({ error: 'Could not parse video info. Try again.' }); }

    if (data._type === 'playlist') {
      return res.status(400).json({ error: 'Playlist links are not supported. Open a single video.' });
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

    // Curated MP4 merged options: one best entry per height (progressive if exists, else note merge)
    const bestAudio = formats.filter(f => !f.has_video && f.has_audio).slice(0, 12);
    const videoOnly = formats.filter(f => f.has_video && !f.has_audio).slice(0, 24);
    const progressive = formats.filter(f => f.has_video && f.has_audio);

    // group downloadable MP4 ladders
    const seenHeights = new Set();
    const mp4Ladder = [];
    const topAudioBytes = (bestAudio.find(f => f.size_bytes != null) || {}).size_bytes || null;
    for (const f of formats) {
      if (!f.has_video || !f.height) continue;
      if (seenHeights.has(f.height)) continue;
      // prefer mp4 progressive, else any video+audio-capable pick
      const sameHeight = formats.filter(x => x.height === f.height && x.has_video);
      const prog = sameHeight.find(x => x.has_video && x.has_audio && x.ext === 'mp4')
        || sameHeight.find(x => x.has_video && x.has_audio)
        || sameHeight.find(x => x.ext === 'mp4')
        || sameHeight[0];
      if (!prog) continue;
      seenHeights.add(f.height);
      let entry = prog;
      // Estimate merged (video+audio) disk size when the video-only entry has no size
      if (entry.size_bytes == null) {
        const vBytes = sameHeight.map(x => x.size_bytes).find(n => n != null);
        if (vBytes != null && topAudioBytes != null) {
          entry = {
            ...prog,
            size_bytes: vBytes + topAudioBytes,
            size_label: formatBytes(vBytes + topAudioBytes),
            format_note: (prog.format_note ? prog.format_note + ' ' : '') + '+ audio (est. merged)',
            has_audio: true, // will be merged with audio on download
          };
        }
      }
      mp4Ladder.push(entry);
      if (mp4Ladder.length >= 8) break;
    }

    const audioLadder = [...formats]
      .filter(f => f.has_audio && /m4a|webm|mp3|opus|mp4a/i.test((f.ext || '') + ' ' + (f.acodec || '')) )
      .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))
      .slice(0, 8);

    res.json({
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
    });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Failed to fetch video info.' });
  }
});

// ---------- API: download (mp4 / video / audio passthrough) ----------
// /api/download?url=...&format_id=22  -> streams original container
// /api/download?url=...&mode=mp4&height=720 -> merges best<=height to mp4
// /api/download?url=...&mode=mp3&quality=320 -> extracts mp3
app.get('/api/download', async (req, res) => {
  const url = (req.query.url || '').trim();
  const mode = (req.query.mode || 'raw').toString(); // raw | mp4 | mp3 | best
  const formatId = (req.query.format_id || req.query.format || '').toString();
  const height = parseInt(req.query.height || '0', 10);
  const mp3Quality = (req.query.quality || '192').toString();

  if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid YouTube URL.' });

  // Need a safe filename — fetch title quickly? Use id fallback, sanitize client-provided title
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
    let headersSent = true;
    let stderrTail = '';

    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-3000); });
    child.on('error', () => {
      try { if (!res.headersSent) res.status(500).json({ error: 'yt-dlp not found on server.' }); else res.end(); }
      catch { /* noop */ }
    });
    child.on('close', (code) => {
      if (code !== 0 && !res.writableEnded) {
        // If nothing was streamed, turn into an error (can't JSON after streaming started)
        if (res.bytesWritten === 0) {
          try { res.end(); } catch { /* noop */ }
        } else res.end();
      } else if (!res.writableEnded) res.end();
    });

    child.stdout.pipe(res);
    req.on('close', () => { try { child.kill('SIGKILL'); } catch { /* noop */ } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- API: health ----------
app.get('/api/health', async (req, res) => {
  try {
    const { stdout } = await runYtDlp(['--version'], { timeoutMs: 10000 });
    res.json({ ok: true, ytdlp: stdout.trim() });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  ▶ PluckTube running at http://localhost:${PORT}`);
  console.log(`  ▶ Health check: http://localhost:${PORT}/api/health\n`);
});
