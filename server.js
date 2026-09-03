const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { spawn } = require('node:child_process');
const dns = require('node:dns').promises;
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const ffmpegPath = require('ffmpeg-static');

const app = express();
const port = Number(process.env.PORT) || 3000;
const maxUrlLength = 2048;
const allowedProtocols = new Set(['http:', 'https:']);
const metadataCache = new Map();
const metadataCacheTtl = 5 * 60 * 1000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
});
app.use(express.static(__dirname));

function parseUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxUrlLength) {
    throw new Error('Enter a valid URL.');
  }
  const parsed = new URL(value);
  if (!allowedProtocols.has(parsed.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported.');
  return parsed;
}

async function rejectPrivateHost(parsed) {
  const addresses = await dns.lookup(parsed.hostname, { all: true });
  if (addresses.some(({ address }) => /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.|::1$|fc|fd)/i.test(address))) {
    throw new Error('Private network URLs are not allowed.');
  }
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? 'py' : 'python3';
    const commandArgs = ['-m', 'yt_dlp', ...args];
    const child = spawn(command, commandArgs, { windowsHide: true });
    let output = '';
    let error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', () => reject(new Error('yt-dlp is not installed or is not available on PATH.')));
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(error.trim() || 'The source could not be resolved.')));
  });
}

function runYtDlpToFile(args, outputPath) {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? 'py' : 'python3';
    const child = spawn(command, ['-m', 'yt_dlp', '--ffmpeg-location', ffmpegPath, ...args, '-o', outputPath], { windowsHide: true });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', () => reject(new Error('The download engine is unavailable.')));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(error.trim() || 'The media could not be downloaded.')));
  });
}

function extractorArgs(sourceUrl) {
  return ['--dump-single-json', '--yes-playlist', '--no-warnings', '--socket-timeout', '20', '--retries', '2', '--fragment-retries', '2', '--concurrent-fragments', '4', sourceUrl];
}

function downloadUrl(sourceUrl, format, index, height) {
  const params = new URLSearchParams({ url: sourceUrl, format });
  if (index) params.set('index', String(index));
  if (height) params.set('height', String(height));
  return '/api/download?' + params.toString();
}

function itemFromInfo(info, sourceUrl, index) {
  const heights = [...new Set((info.formats || []).map(format => format.height).filter(height => Number.isInteger(height)))].sort((a, b) => b - a);
  const image = /image|photo/i.test(info.ext || '') || (!heights.length && info.thumbnail);
  return {
    index,
    title: info.title || `Media ${index}`,
    thumbnail: info.thumbnail || '',
    type: image ? 'image' : 'video',
    resolutions: heights.length ? heights : [],
    downloads: {
      video: downloadUrl(sourceUrl, 'video', index),
      image: downloadUrl(sourceUrl, 'image', index)
    }
  };
}

app.post('/api/media', async (req, res) => {
  try {
    const parsed = parseUrl(req.body.url);
    await rejectPrivateHost(parsed);
    const cacheKey = parsed.toString();
    const cached = metadataCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return res.json(cached.data);
    metadataCache.delete(cacheKey);
    try {
      const raw = await runYtDlp(extractorArgs(cacheKey));
      const info = JSON.parse(raw);
      const entries = (info.entries || []).filter(Boolean);
      const items = entries.length ? entries.map((entry, position) => itemFromInfo(entry, parsed.toString(), position + 1)) : [itemFromInfo(info, parsed.toString(), 1)];
      const data = { title: info.title || items[0].title, thumbnail: info.thumbnail || items[0].thumbnail, source: 'extractor', count: items.length, items };
      metadataCache.set(cacheKey, { data, expiresAt: Date.now() + metadataCacheTtl });
      return res.json(data);
    } catch (extractorError) {
      if (!/\.(mp4|webm|mov|m4v|jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(parsed.pathname)) throw extractorError;
      const isImage = /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(parsed.pathname);
      const data = { title: path.basename(parsed.pathname) || 'Direct media', source: 'direct', count: 1, items: [{ index: 1, title: path.basename(parsed.pathname), thumbnail: isImage ? parsed.toString() : '', type: isImage ? 'image' : 'video', resolutions: [], downloads: { video: downloadUrl(parsed.toString(), 'video', 1), image: downloadUrl(parsed.toString(), 'image', 1) } }] };
      metadataCache.set(cacheKey, { data, expiresAt: Date.now() + metadataCacheTtl });
      return res.json(data);
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/download', async (req, res) => {
  try {
    const parsed = parseUrl(req.query.url);
    await rejectPrivateHost(parsed);
    const directMedia = /\.(mp4|webm|mov|m4v|jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(parsed.pathname);
    if (directMedia) {
      const upstream = await fetch(parsed);
      if (!upstream.ok || !upstream.body) throw new Error('The media file could not be fetched.');
      const extension = path.extname(parsed.pathname).slice(1).toLowerCase() || 'bin';
      res.setHeader('Content-Disposition', `attachment; filename="clipgrab-media.${extension}"`);
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
      const contentLength = upstream.headers.get('content-length');
      if (contentLength) res.setHeader('Content-Length', contentLength);
      res.on('close', () => { if (!res.writableEnded) upstream.body.cancel().catch(() => {}); });
      try {
        await pipeline(Readable.fromWeb(upstream.body), res);
      } catch (error) {
        if (!res.destroyed) throw error;
      }
      return;
    }
    const format = req.query.format === 'audio' ? 'audio' : 'video';
    const itemIndex = Number.parseInt(req.query.index, 10);
    const height = Number.parseInt(req.query.height, 10);
    const playlistArgs = Number.isInteger(itemIndex) && itemIndex > 0 ? ['--playlist-items', String(itemIndex)] : ['--no-playlist'];
    const quality = Number.isInteger(height) && height > 0 ? `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${height}][ext=mp4]/best` : 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
    const args = format === 'audio' ? ['-f', 'bestaudio[ext=m4a]/bestaudio', ...playlistArgs, '--socket-timeout', '20', '--retries', '3', '--fragment-retries', '3', '--concurrent-fragments', '4', '--no-part', parsed.toString()] : ['-f', quality, ...playlistArgs, '--socket-timeout', '20', '--retries', '3', '--fragment-retries', '3', '--concurrent-fragments', '4', '--merge-output-format', 'mp4', parsed.toString()];
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clipgrab-'));
    const outputPath = path.join(tempDir, format === 'audio' ? 'clipgrab-audio.m4a' : 'clipgrab-video.mp4');
    try {
      try {
        await runYtDlpToFile(args, outputPath);
      } catch (error) {
        if (format !== 'video') throw error;
      }
      let outputExists = false;
      try { outputExists = (await fsp.stat(outputPath)).size > 0; } catch {}
      if (!outputExists && format === 'video') {
        await runYtDlpToFile(['-f', 'best', ...playlistArgs, '--socket-timeout', '20', '--retries', '3', '--fragment-retries', '3', '--concurrent-fragments', '4', parsed.toString()], outputPath);
      }
      const stats = await fsp.stat(outputPath);
      res.setHeader('Content-Disposition', `attachment; filename="clipgrab-${format}.${format === 'audio' ? 'm4a' : 'mp4'}"`);
      res.setHeader('Content-Type', format === 'audio' ? 'audio/mp4' : 'video/mp4');
      res.setHeader('Content-Length', stats.size);
      await pipeline(fs.createReadStream(outputPath), res);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (!res.headersSent) res.status(400).json({ error: error.message });
  }
});

app.get(['/about', '/terms', '/privacy'], (req, res) => res.sendFile(path.join(__dirname, 'legal.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'clipgrab.html')));
app.listen(port, () => console.log(`ClipGrab running at http://localhost:${port}`));
