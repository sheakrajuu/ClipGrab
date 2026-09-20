window.clipgrabSections = window.clipgrabSections || {};
window.clipgrabSections.Instagram = {
  title: 'Download Instagram photos and videos',
  sub: 'Save photos, videos, reels and public posts in one tap.',
  placeholder: 'Paste Instagram link here',
  steps: [
    'Tap the ... menu on the post, then <b>Copy Link</b>.',
    'Paste the link into the box above and select <b>Find media</b>.',
    'Choose <b>Photo</b> or <b>Video</b> to save it to your device.'
  ],
  downloadTarget(item, format, height) {
    const target = height ? item.downloads?.video + '&height=' + encodeURIComponent(height) : item.downloads?.[format || 'video'];
    return target || '';
  },
  extension(item, format) { return format === 'audio' ? 'mp3' : item.type === 'image' ? 'jpg' : 'mp4'; }
};
