# ClipGrab

A small Express web downloader for public media URLs and social pages. The homepage is assembled by the Express server from `clipgrab.html` and the files in `sections/`.

## Page structure

The reusable page sections live in separate files:

- `sections/header.html`
- `sections/hero.html`
- `sections/web-tools.html`
- `sections/cross-links.html`
- `sections/content.html`
- `sections/footer.html`

`server.js` combines those partials when serving `/` or `/clipgrab.html`. Keep the section marker names in `clipgrab.html` synchronized with the files in `sections/`.

## Render deployment

Render runs the Node/Express server, so the page partials and `/api/media` backend work together in production. GitHub can store and version all of these files; GitHub Pages alone cannot run the Node backend.

## Run locally

1. Install Node.js 18 or newer.
2. Install the media extraction engine:

```powershell
winget install yt-dlp.yt-dlp
py -m pip install curl-cffi
```

Restart the terminal after installation so `yt-dlp` is available on `PATH`.

3. Install dependencies and start the app:

```powershell
npm.cmd install
npm.cmd start
```

Open http://localhost:3000.

The app supports browser installation through its web app manifest and service worker. On supported mobile browsers, use the `Install ClipGrab` control. The `Share ClipGrab` control uses the device share sheet when available.

Run the smoke tests with:

```powershell
npm.cmd test
```

Recent links, saved URLs, result state, and hidden gallery items are stored locally in the browser. Downloaded media is streamed through the server and is not kept as a permanent file.

## API

- `GET /health` returns the service health status used by Render.

- `POST /api/media` with `{ "url": "https://..." }` returns media metadata and download format URLs.
- `GET /api/download?url=...&format=video` streams a video download.
