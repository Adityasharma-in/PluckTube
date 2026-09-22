// PluckTube compat engine — pure-JS YouTube metadata + progressive download.
// Used when yt-dlp is NOT available (e.g. Vercel serverless, which has no
// yt-dlp binary, no ffmpeg, and can't spawn child processes).
// Powered by youtubei.js (Innertube). No binary, no child_process, works on Vercel.
//
// LIMITATIONS (be honest in UI): without YouTube's PO token, only the
// progressive 360p MP4 (itag 18) reliably deciphers. DASH video-only /
// audio-only URLs fail. So compat mode = metadata + 360p MP4. Full quality
// (4K merge, true MP3) needs the yt-dlp backend (see Dockerfile / README).
const vm = require('vm');
const { Platform, Innertube, Log } = require('youtubei.js');

try { Log.setLevel(Log.LogLevel.ERROR); } catch { /* older/newer API */ }

// youtubei.js v18+ ships without a JS evaluator (security). Provide a minimal
// Node `vm` evaluator so signature deciphering works server-side.
if (Platform?.shim && typeof Platform.shim.eval === 'function') {
  const needsPatch = /must provide your own JavaScript evaluator/i.test(Platform.shim.eval.toString());
  if (needsPatch) {
    Platform.shim.eval = async (data) => {
      // The extracted player script expects browser-ish globals (URL,
      // encodeURIComponent, window/self/globalThis...). Provide them or
      // decipher randomly fails depending on which player code path runs.
      const sandbox = {
        URL, URLSearchParams, TextEncoder, TextDecoder,
        encodeURIComponent, decodeURIComponent, escape, unescape,
        console, Math, Object, Array, String, Number, Boolean, BigInt,
        RegExp, JSON, Error, TypeError, RangeError, Map, Set, WeakMap,
        ArrayBuffer, Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array,
        Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array,
        DataView, Promise, Symbol, Reflect, Proxy, parseInt, parseFloat,
        isNaN, isFinite, NaN, Infinity, undefined,
      };
      sandbox.globalThis = sandbox;
      sandbox.window = sandbox;
      sandbox.self = sandbox;
      sandbox.global = sandbox;
      vm.createContext(sandbox);
      return vm.runInContext(`(function(){ ${data.output} })()`, sandbox);
    };
  }
}

let innertubePromise = null;
function getClient(fresh = false) {
  if (fresh || !innertubePromise) innertubePromise = Innertube.create();
  return innertubePromise;
}

function extractVideoId(u) {
  if (typeof u !== 'string') return null;
  const m = u.trim().match(
    /(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/|music\.youtube\.com\/watch\?[^#]*v=)([A-Za-z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

function formatBytes(n) {
  if (n == null || isNaN(n)) return null;
  if (n === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2)} ${u[i]}`;
}

function extFromMime(mime) {
  const m = /video\/(\w+)|audio\/(\w+)/.exec(mime || '');
  return m ? (m[1] || m[2] || '').toLowerCase() : '';
}

function bestThumbnail(thumbs) {
  if (!Array.isArray(thumbs) || !thumbs.length) return '';
  return [...thumbs].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || '';
}

function cleanError(e) {
  const msg = (e && e.message ? String(e.message) : 'Failed to fetch video info.');
  if (/unavailable/i.test(msg)) return 'Video is unavailable, deleted, or region-blocked.';
  if (/private/i.test(msg)) return 'This video is private or requires login.';
  if (/age/i.test(msg)) return 'Age-restricted video — cannot fetch without login.';
  if (/login|sign in/i.test(msg)) return 'This video requires login.';
  if (/live/i.test(msg) && /stream/i.test(msg)) return 'Live streams are not supported for download.';
  return msg.slice(0, 300);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || 'Request'} timed out. Try again.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Fetch fresh info + decipher every format. Returns { info, playable[] }
// where playable = [{ itag, ext, width, height, fps, contentLength, mimeType,
// hasVideo, hasAudio, qualityLabel, url }]
async function fetchPlayable(url, attempt = 1) {
  const id = extractVideoId(url);
  if (!id) throw new Error('Enter a valid YouTube URL (watch, youtu.be, shorts, music).');
  const yt = await withTimeout(getClient(attempt > 1), 30000, 'YouTube client init');
  const info = await withTimeout(yt.getInfo(id), 40000, 'Video info');
  const b = info.basic_info || {};
  const raw = [...(info.streaming_data?.formats || []), ...(info.streaming_data?.adaptive_formats || [])];
  const playable = [];
  let lastErr = '';
  for (const f of raw) {
    try {
      const streamUrl = await f.decipher(yt.session.player);
      if (!streamUrl || streamUrl.length < 100) continue;
      const cl = f.content_length ? parseInt(f.content_length, 10) : null;
      playable.push({
        itag: f.itag,
        ext: extFromMime(f.mime_type),
        mimeType: f.mime_type || '',
        width: f.width || null,
        height: f.height || null,
        fps: f.fps || null,
        bitrate: f.bitrate || f.average_bitrate || null,
        contentLength: Number.isFinite(cl) ? cl : null,
        hasVideo: !!f.has_video,
        hasAudio: !!f.has_audio,
        qualityLabel: f.quality_label || f.audio_quality || '',
        url: streamUrl,
      });
    } catch (e) { lastErr = (e && e.message ? e.message : String(e)).slice(0, 120); }
  }
  if (!playable.length && raw.length && attempt < 2) {
    // Transient decipher/bot-check failure — retry once with a fresh client.
    await new Promise((r) => setTimeout(r, 1500));
    return fetchPlayable(url, attempt + 1);
  }
  if (!playable.length && raw.length) {
    console.warn(`[compat] 0/${raw.length} formats deciphered for ${id}. Last error: ${lastErr}`);
  }
  if (!raw.length) {
    const status = info.playability_status?.status;
    const reason = (info.playability_status?.reason || '').slice(0, 200);
    console.warn(`[compat] no streaming data for ${id}. playability=${status} reason=${reason}`);
    throw new Error(
      reason || 'YouTube rate-limited this request (bot-check). Wait a minute and try again — or deploy the full backend, see README.'
    );
  }
  return { info, basic: b, playable };
}

function toRow(p) {
  const size = p.contentLength;
  return {
    format_id: String(p.itag),
    ext: p.ext || '',
    resolution: p.width ? `${p.width}x${p.height}` : 'audio only',
    width: p.width,
    height: p.height,
    fps: p.fps,
    vcodec: p.hasVideo ? (p.mimeType.split('codecs=')[1] || '').replace(/["\]]/g, '').split(',')[0].trim() || null : 'none',
    acodec: p.hasAudio ? 'mp4a.40.2' : 'none',
    abr: null,
    vbr: null,
    tbr: p.bitrate ? Math.round(p.bitrate / 1000) : null,
    asr: null,
    filesize: size,
    filesize_approx: null,
    size_bytes: size,
    size_label: formatBytes(size),
    format_note: p.qualityLabel || '',
    quality: null,
    protocol: 'https',
    has_video: p.hasVideo,
    has_audio: p.hasAudio,
  };
}

async function getVideoInfo(url) {
  const { info, basic, playable } = await fetchPlayable(url).catch((e) => { throw new Error(cleanError(e)); });
  if (!playable.length) {
    throw new Error('YouTube did not return a playable stream (bot-check). Deploy the full backend — see README.');
  }
  const rows = playable
    .map(toRow)
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0));

  const progressive = rows.filter((f) => f.has_video && f.has_audio);
  const videoOnly = rows.filter((f) => f.has_video && !f.has_audio);
  const audioOnly = rows.filter((f) => !f.has_video && f.has_audio);

  return {
    engine: 'compat',
    compat_note: 'Compatibility mode (Vercel): 360p MP4 only. Deploy the yt-dlp backend for 4K + true MP3 — see README.',
    id: basic.id,
    title: basic.title || 'Untitled',
    uploader: basic.channel?.name || basic.author || 'Unknown channel',
    channel_id: basic.channel?.id || basic.channel_id || null,
    duration: basic.duration ?? null,
    duration_string: null,
    view_count: basic.view_count ?? null,
    like_count: basic.like_count ?? null,
    upload_date: null,
    published_text: info.primary_info?.published?.text || null,
    description: (basic.short_description || '').slice(0, 2000),
    thumbnail: bestThumbnail(basic.thumbnail),
    webpage_url: `https://www.youtube.com/watch?v=${basic.id}`,
    is_live: !!basic.is_live,
    was_live: false,
    age_limit: 0,
    categories: basic.category ? [basic.category] : [],
    tags: Array.isArray(basic.tags) ? basic.tags.slice(0, 20) : [],
    subtitles: [],
    automatic_captions: [],
    format_count: rows.length,
    formats: rows.slice(0, 60),
    mp4_ladder: progressive.slice(0, 8),
    progressive,
    video_only: videoOnly.slice(0, 24),
    audio_only: audioOnly.slice(0, 12),
    audio_ladder: audioOnly.slice(0, 8),
  };
}

function sanitizeTitle(t) {
  return (t || 'youtube-video').toString().slice(0, 120)
    .replace(/[\\/:*?"<>|#%&{}$!'@+=`~]/g, '').replace(/\s+/g, ' ').trim() || 'youtube-video';
}

// Resolve a download: returns { redirectUrl, filename, contentType }.
// Compat mode can only serve decipherable progressive streams (360p MP4).
async function resolveDownload(url, { mode = 'raw', formatId = '', height = 0 } = {}) {
  const { basic, playable } = await fetchPlayable(url).catch((e) => { throw new Error(cleanError(e)); });
  const title = sanitizeTitle(basic.title);
  const progressive = playable.filter((p) => p.hasVideo && p.hasAudio)
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  let pick = null;
  if (formatId) {
    pick = playable.find((p) => String(p.itag) === String(formatId));
    if (!pick) throw new Error(`Quality ${formatId} is not available in compatibility mode (360p only). Deploy the full backend for all qualities.`);
  } else if (mode === 'mp3') {
    throw new Error('MP3 conversion needs the full backend (ffmpeg). In compatibility mode, download the 360p MP4 instead — see README.');
  } else if (mode === 'mp4' && height > 0) {
    const h = Math.min(Math.max(parseInt(height, 10) || 0, 144), 4320);
    pick = progressive.filter((p) => (p.height || 0) <= h).sort((a, b) => b.height - a.height)[0]
      || progressive[progressive.length - 1] || null;
  } else {
    // raw without itag / best → highest progressive
    pick = progressive[0] || null;
  }
  if (!pick) throw new Error('No playable stream in compatibility mode. Deploy the full backend — see README.');

  const isAudio = !pick.hasVideo && pick.hasAudio;
  const ext = isAudio ? (pick.ext || 'm4a') : 'mp4';
  const label = pick.height ? `${pick.height}p` : pick.itag;
  return {
    redirectUrl: pick.url,
    filename: `${title} [${label}].${ext}`,
    contentType: isAudio ? 'audio/mp4' : 'video/mp4',
  };
}

module.exports = { getVideoInfo, resolveDownload, extractVideoId };
