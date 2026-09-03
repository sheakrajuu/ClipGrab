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
const cheerio = require('cheerio');

const app = express();
const port = Number(process.env.PORT) || 3000;
const maxUrlLength = 2048;
const allowedProtocols = new Set(['http:', 'https:']);
const metadataCache = new Map();
const metadataCacheTtl = 5 * 60 * 1000;
const socialMediaHosts = new Set(['tiktok.com', 'instagram.com', 'facebook.com', 'fb.watch', 'x.com', 'twitter.com', 'youtube.com', 'youtu.be', 'pinterest.com', 'reddit.com']);
const socialVideoLimitSeconds = 10 * 60;
const webVideoLimitSeconds = 15 * 60;
const upstreamTimeoutMs = 120000;
const metadataTimeoutMs = 30000;

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

function logStage(stage, parsed, details = '') {
  const target = parsed ? `${parsed.origin}${parsed.pathname}` : 'unknown URL';
  console.info(`[clipgrab] ${stage} ${target}${details ? ` - ${details}` : ''}`);
}

function isSocialMediaUrl(parsed) {
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  return [...socialMediaHosts].some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
}

function durationLimitForUrl(parsed) {
  return isSocialMediaUrl(parsed) ? socialVideoLimitSeconds : webVideoLimitSeconds;
}

function assertDurationAllowed(info, parsed) {
  const duration = Number(info && info.duration);
  if (Number.isFinite(duration) && duration > durationLimitForUrl(parsed)) {
    const limitMinutes = durationLimitForUrl(parsed) / 60;
    throw new Error(`Videos longer than ${limitMinutes} minutes cannot be downloaded.`);
  }
}

async function rejectPrivateHost(parsed) {
  const addresses = await dns.lookup(parsed.hostname, { all: true });
  if (addresses.some(({ address }) => /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.|::1$|fc|fd)/i.test(address))) {
    throw new Error('Private network URLs are not allowed.');
  }
}

function runCommand(command, commandArgs, unavailableMessage) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { windowsHide: true });
    let output = '';
    let error = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('The source took too long to respond.'));
    }, upstreamTimeoutMs);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', () => { clearTimeout(timeout); reject(new Error(unavailableMessage)); });
    child.on('close', code => { clearTimeout(timeout); code === 0 ? resolve(output) : reject(new Error(error.trim() || 'The source could not be resolved.')); });
  });
}

function ytDlpCommands(args) {
  if (process.platform === 'win32') return [['yt-dlp', args], ['py', ['-m', 'yt_dlp', ...args]]];
  return [['yt-dlp', args], ['python3', ['-m', 'yt_dlp', ...args]]];
}

async function runYtDlp(args) {
  let lastError;
  for (const [command, commandArgs] of ytDlpCommands(args)) {
    try { return await runCommand(command, commandArgs, 'The download engine is unavailable.'); } catch (error) { lastError = error; }
  }
  throw lastError;
}

async function runYtDlpToFile(args, outputPath) {
  let lastError;
  const fullArgs = ['--ffmpeg-location', ffmpegPath, ...args, '-o', outputPath];
  for (const [command, commandArgs] of ytDlpCommands(fullArgs)) {
    try { await runCommand(command, commandArgs, 'The download engine is unavailable.'); return; } catch (error) { lastError = error; }
  }
  throw lastError;
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

function previewUrl(sourceUrl) {
  return '/api/preview?url=' + encodeURIComponent(sourceUrl);
}

async function directMediaType(parsed) {
  if (/\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(parsed.pathname)) return 'video';
  if (/\.(jpg|jpeg|png|gif|webp|avif)(\?.*)?$/i.test(parsed.pathname)) return 'image';
  try {
    const response = await fetch(parsed, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(metadataTimeoutMs), headers: { 'User-Agent': 'ClipGrab/1.0' } });
    const contentType = response.headers.get('content-type') || '';
    if (/^image\//i.test(contentType)) return 'image';
    if (/^video\//i.test(contentType)) return 'video';
  } catch {}
  return null;
}

async function isDirectMedia(parsed) {
  return Boolean(await directMediaType(parsed));
}

function itemFromInfo(info, sourceUrl, index) {
  const heights = [...new Set((info.formats || []).map(format => format.height).filter(height => Number.isInteger(height)))].sort((a, b) => b - a);
  const image = /^(jpg|jpeg|png|gif|webp|avif)$/i.test(info.ext || '') || (!heights.length && info.thumbnail);
  const originalImageUrl = image && /^https?:/i.test(info.url || '') ? info.url : sourceUrl;
  const downloads = {
    video: downloadUrl(sourceUrl, 'video', index),
    image: downloadUrl(originalImageUrl, 'image', index)
  };
  return {
    index,
    title: info.title || `Media ${index}`,
    thumbnail: info.thumbnail ? previewUrl(info.thumbnail) : '',
    type: image ? 'image' : 'video',
    duration: Number.isFinite(Number(info.duration)) ? Number(info.duration) : null,
    maxDuration: durationLimitForUrl(new URL(sourceUrl)),
    resolutions: heights.length ? heights : [],
    downloads
  };
}

function flattenEntries(info) {
  if (!info) return [];
  if (!Array.isArray(info.entries)) return [info];
  return info.entries.filter(Boolean).flatMap(entry => Array.isArray(entry.entries) ? flattenEntries(entry) : [entry]);
}

function publicSourceError(error) {
  const message = String(error && error.message || '');
  if (/cloudflare|anti-bot|captcha|http error 403|forbidden/i.test(message)) {
    return new Error('The source website blocked server access. Try opening the link in a browser or use the alternative downloader.');
  }
  return error;
}

function isInstagramResizedPreview(value) {
  try {
    const parsed = new URL(value);
    return /(^|\.)instagram\.com$/i.test(parsed.hostname) || /(^|\.)cdninstagram\.com$/i.test(parsed.hostname)
      ? /(?:^|[_-])s\d+x\d+(?:[_-]|$)/i.test(parsed.search) || /(?:^|&)stp=[^&]*s\d+x\d+/i.test(parsed.search)
      : false;
  } catch {
    return false;
  }
}

async function extractPageImages(parsed) {
  const response = await fetch(parsed, { signal: AbortSignal.timeout(metadataTimeoutMs), headers: { 'User-Agent': 'ClipGrab/1.0' } });
  if (!response.ok) return [];
  const html = await response.text();
  const $ = cheerio.load(html);
  const candidates = [];
  const addSourceSet = sourceSet => {
    if (!sourceSet) return;
    const sources = sourceSet.split(',').map(source => {
      const parts = source.trim().split(/\s+/);
      const descriptor = parts[1] || '';
      const value = Number.parseFloat(descriptor);
      return { url: parts[0], score: descriptor.endsWith('w') ? value : descriptor.endsWith('x') ? value * 100000 : 0 };
    }).filter(source => source.url).sort((a, b) => b.score - a.score);
    if (sources[0]) candidates.push(sources[0].url);
  };
  $('meta[property="og:image"], meta[property="og:image:url"], meta[name="twitter:image"], meta[name="twitter:image:src"]').each((_, element) => candidates.push($(element).attr('content')));
  $('picture source, img').each((_, element) => {
    addSourceSet($(element).attr('srcset') || $(element).attr('data-srcset'));
    for (const attribute of ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-original-src', 'data-url', 'data-image']) candidates.push($(element).attr(attribute));
  });
  return [...new Set(candidates.filter(Boolean).map(value => { try { return new URL(value, parsed).toString(); } catch { return null; } }).filter(value => value && /^https?:/i.test(value)))].slice(0, 30);
}

async function extractPageVideos(parsed) {
  const response = await fetch(parsed, { signal: AbortSignal.timeout(metadataTimeoutMs), headers: { 'User-Agent': 'ClipGrab/1.0' } });
  if (!response.ok) return [];
  const $ = cheerio.load(await response.text());
  const candidates = [];
  $('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]').each((_, element) => candidates.push($(element).attr('content')));
  $('video, video source, source').each((_, element) => {
    for (const attribute of ['src', 'data-src', 'data-video', 'data-url']) candidates.push($(element).attr(attribute));
  });
  return [...new Set(candidates.filter(Boolean).map(value => { try { return new URL(value, parsed).toString(); } catch { return null; } }).filter(value => value && /^https?:/i.test(value)))].slice(0, 10);
}

app.post('/api/media', async (req, res) => {
  try {
    const parsed = parseUrl(req.body.url);
    logStage('media request', parsed);
    await rejectPrivateHost(parsed);
    const cacheKey = parsed.toString();
    const cached = metadataCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return res.json(cached.data);
    metadataCache.delete(cacheKey);
    const directType = await directMediaType(parsed);
    if (directType === 'image') {
      const data = { title: path.basename(parsed.pathname) || 'Direct image', source: 'direct', count: 1, items: [{ index: 1, title: path.basename(parsed.pathname) || 'Image', thumbnail: previewUrl(parsed.toString()), type: 'image', resolutions: [], downloads: { image: downloadUrl(parsed.toString(), 'image', 1) } }] };
      metadataCache.set(cacheKey, { data, expiresAt: Date.now() + metadataCacheTtl });
      return res.json(data);
    }
    try {
      const raw = await runYtDlp(extractorArgs(cacheKey));
      const info = JSON.parse(raw);
      assertDurationAllowed(info, parsed);
      const entries = flattenEntries(info);
      entries.forEach(entry => assertDurationAllowed(entry, parsed));
      const items = entries.length > 1 ? entries.map((entry, position) => itemFromInfo(entry, parsed.toString(), position + 1)) : [itemFromInfo(entries[0] || info, parsed.toString(), 1)];
      const data = { title: info.title || items[0].title, thumbnail: info.thumbnail || items[0].thumbnail, source: 'extractor', count: items.length, items };
      metadataCache.set(cacheKey, { data, expiresAt: Date.now() + metadataCacheTtl });
      return res.json(data);
    } catch (extractorError) {
      if (!await isDirectMedia(parsed)) {
        const imageUrls = await extractPageImages(parsed).catch(() => []);
        if (imageUrls.length) {
          logStage('image extraction succeeded', parsed, `${imageUrls.length} candidates`);
          const data = { title: 'Images found', source: 'web-images', count: imageUrls.length, items: imageUrls.map((imageUrl, position) => ({ index: position + 1, title: `Image ${position + 1}`, thumbnail: previewUrl(imageUrl), type: 'image', resolutions: [], downloads: { image: isInstagramResizedPreview(imageUrl) ? '' : downloadUrl(imageUrl, 'image') } })) };
          metadataCache.set(cacheKey, { data, expiresAt: Date.now() + metadataCacheTtl });
          return res.json(data);
        }
        const videoUrls = await extractPageVideos(parsed).catch(() => []);
        if (videoUrls.length) {
          logStage('video extraction succeeded', parsed, `${videoUrls.length} candidates`);
          const data = { title: 'Videos found', source: 'web-videos', count: videoUrls.length, items: videoUrls.map((videoUrl, position) => ({ index: position + 1, title: `Video ${position + 1}`, thumbnail: '', type: 'video', duration: null, maxDuration: durationLimitForUrl(parsed), resolutions: [], downloads: { video: downloadUrl(videoUrl, 'video') } })) };
          metadataCache.set(cacheKey, { data, expiresAt: Date.now() + metadataCacheTtl });
          return res.json(data);
        }
        if (extractorError.message.includes('No video formats found') || extractorError.message.includes('Unsupported URL')) {
          throw new Error('No downloadable media was found at this URL.');
        }
        throw publicSourceError(extractorError);
      }
      const isImage = await directMediaType(parsed) === 'image';
      const data = { title: path.basename(parsed.pathname) || 'Direct media', source: 'direct', count: 1, items: [{ index: 1, title: path.basename(parsed.pathname), thumbnail: isImage ? previewUrl(parsed.toString()) : '', type: isImage ? 'image' : 'video', resolutions: [], downloads: { video: downloadUrl(parsed.toString(), 'video', 1), image: downloadUrl(parsed.toString(), 'image', 1) } }] };
      metadataCache.set(cacheKey, { data, expiresAt: Date.now() + metadataCacheTtl });
      return res.json(data);
    }
  } catch (error) {
    console.warn(`[clipgrab] media failed - ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/download', async (req, res) => {
  try {
    const parsed = parseUrl(req.query.url);
    await rejectPrivateHost(parsed);
    const format = ['audio', 'image', 'video'].includes(req.query.format) ? req.query.format : 'video';
    logStage('download request', parsed, format);
    const directMedia = await isDirectMedia(parsed);
    if (directMedia && format === 'video' && /\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(parsed.pathname)) {
      try {
        const metadata = JSON.parse(await runYtDlp(['--dump-single-json', '--no-warnings', '--no-playlist', '--socket-timeout', '20', '--retries', '2', parsed.toString()]));
        assertDurationAllowed(metadata, parsed);
      } catch (error) {
        if (error.message.startsWith('Videos longer than')) throw error;
      }
    }
    if (directMedia) {
      const upstream = await fetch(parsed, { redirect: 'follow', signal: AbortSignal.timeout(upstreamTimeoutMs), headers: { 'User-Agent': 'ClipGrab/1.0' } });
      if (!upstream.ok || !upstream.body) throw new Error('The media file could not be fetched.');
      const contentType = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!(format === 'image' ? /^image\// : /^video\//).test(contentType)) throw new Error('The source did not return a valid media file.');
      const extension = contentType.startsWith('image/') ? contentType.split('/')[1].split(';')[0].replace('jpeg', 'jpg') : path.extname(parsed.pathname).slice(1).toLowerCase() || 'mp4';
      res.setHeader('Content-Disposition', `attachment; filename="clipgrab-media.${extension}"`);
      res.setHeader('Content-Type', contentType);
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
    const itemIndex = Number.parseInt(req.query.index, 10);
    const height = Number.parseInt(req.query.height, 10);
    const playlistArgs = Number.isInteger(itemIndex) && itemIndex > 0 ? ['--playlist-items', String(itemIndex)] : ['--no-playlist'];
    if (format === 'video') {
      const metadata = JSON.parse(await runYtDlp(['--dump-single-json', '--no-warnings', ...playlistArgs, '--socket-timeout', '20', '--retries', '2', parsed.toString()]));
      assertDurationAllowed(metadata, parsed);
      flattenEntries(metadata).forEach(entry => assertDurationAllowed(entry, parsed));
    }
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
      const disposition = req.query.preview === '1' ? 'inline' : 'attachment';
      res.setHeader('Content-Disposition', `${disposition}; filename="clipgrab-${format}.${format === 'audio' ? 'm4a' : 'mp4'}"`);
      res.setHeader('Content-Type', format === 'audio' ? 'audio/mp4' : 'video/mp4');
      res.setHeader('Content-Length', stats.size);
      await pipeline(fs.createReadStream(outputPath), res);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    console.warn(`[clipgrab] download failed - ${error.message}`);
    if (!res.headersSent) {
      res.status(error.message === 'The download engine is unavailable.' ? 502 : 400);
      res.setHeader('Content-Disposition', 'inline');
      res.type('text/plain').send(error.message);
    }
  }
});

app.get('/api/preview', async (req, res) => {
  try {
    const parsed = parseUrl(req.query.url);
    await rejectPrivateHost(parsed);
    const upstream = await fetch(parsed, { redirect: 'follow', signal: AbortSignal.timeout(metadataTimeoutMs), headers: { 'User-Agent': 'ClipGrab/1.0' } });
    if (!upstream.ok || !upstream.body) throw new Error('Preview unavailable.');
    const contentType = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\//.test(contentType)) throw new Error('Preview is not an image.');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=300');
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (error) {
    if (!res.headersSent) res.status(404).type('text/plain').send(error.message);
  }
});

app.get(['/about', '/terms', '/privacy'], (req, res) => res.sendFile(path.join(__dirname, 'legal.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'clipgrab.html')));
app.listen(port, () => console.log(`ClipGrab running at http://localhost:${port}`));
