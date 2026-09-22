// Vercel serverless: GET /api/info?url=...
// Pure-JS compat engine (no yt-dlp binary on Vercel).
const { getVideoInfo } = require('../lib/compat');

const YT_URL_RE = /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com\/(watch|shorts|live|embed|v\/)|youtu\.be\/)[\w\-?&=;+/%#:.@!$,~'()*[\]]+$/;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const url = ((req.query && req.query.url) || '').trim();
  if (!url || url.length > 2048 || !YT_URL_RE.test(url)) {
    return res.status(400).json({ error: 'Enter a valid YouTube URL (watch, youtu.be, shorts, music).' });
  }
  try {
    const payload = await getVideoInfo(url);
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(502).json({ error: (e && e.message) || 'Failed to fetch video info.' });
  }
};
