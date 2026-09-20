window.clipgrabSections = window.clipgrabSections || {};
window.clipgrabSections.Web = {
  title: 'Find media on any public website',
  sub: 'Scan a public page for images, videos, and audio, then choose what to keep.',
  placeholder: 'Paste a public page or direct media URL',
  steps: [
    'Copy the address of a public page or direct media file.',
    'ClipGrab detects the available media automatically.',
    'Review the result and download the media you need.'
  ],
  downloadTarget(item, format, height) {
    const target = height ? item.downloads?.video + '&height=' + encodeURIComponent(height) : item.downloads?.[format || item.type];
    return target || '';
  },
  extension(item, format) { return format === 'audio' ? 'mp3' : item.type === 'image' ? 'jpg' : 'mp4'; }
};
