# ClipGrab

A small Express web downloader for public media URLs and social pages. The homepage is served from `clipgrab.html`.

## Run locally

1. Install Node.js 18 or newer.
2. Install the media extraction engine:

```powershell
winget install yt-dlp.yt-dlp
```

Restart the terminal after installation so `yt-dlp` is available on `PATH`.

3. Install dependencies and start the app:

```powershell
npm.cmd install
npm.cmd start
```

Open http://localhost:3000.

## API

- `POST /api/media` with `{ "url": "https://..." }` returns media metadata and download format URLs.
- `GET /api/download?url=...&format=video` streams a video download.
- `GET /api/download?url=...&format=audio` streams an audio download when the source supports it.

The backend accepts public HTTP/HTTPS URLs, blocks private network targets, applies a request rate limit, and does not support private or restricted content. Only download content you own or are allowed to save.
