// Vercel serverless: GET /api/download?url=...&mode=mp4&height=360 | &format_id=18
// Compat mode: 302-redirect to the deciphered progressive stream (no proxy,
// so Vercel's response-size/timeout limits don't apply).
const { resolveDownload } = require('../lib/compat');

const YT_URL_RE = /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com\/(watch|shorts|live|embed|v\/)|youtu\.be\/)[\w\-?&=;+/%#:.@!$,~'()*[\]]+$/;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const url = ((req.query && req.query.url) || '').trim();
  if (!url || url.length > 2048 || !YT_URL_RE.test(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL.' });
  }
  const mode = String((req.query && req.query.mode) || 'raw');
  const formatId = String((req.query && (req.query.format_id || req.query.format)) || '');
  const height = parseInt((req.query && req.query.height) || '0', 10);
  try {
    const dl = await resolveDownload(url, { mode, formatId, height });
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(dl.filename)}`);
    return res.redirect(302, dl.redirectUrl);
  } catch (e) {
    return res.status(502).json({ error: (e && e.message) || 'Download failed.' });
  }
};
