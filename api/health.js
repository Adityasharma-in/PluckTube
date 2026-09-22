// Vercel serverless: GET /api/health
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).json({
    ok: true,
    engine: 'compat',
    note: 'Vercel build: yt-dlp/ffmpeg unavailable — compatibility mode (metadata + 360p MP4). Deploy the Docker backend for full quality.',
  });
};
