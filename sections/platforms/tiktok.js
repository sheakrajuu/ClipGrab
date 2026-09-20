window.clipgrabSections = window.clipgrabSections || {};
window.clipgrabSections.TikTok = {
  title: 'Download TikTok videos and images',
  sub: 'Paste a public link and save the media in its original quality.',
  placeholder: 'Paste a TikTok link here',
  steps: [
    'Open the app, tap <b>Share</b>, then <b>Copy Link</b> on the video you want.',
    'Come back here, paste the link into the box above, and select <b>Find media</b>.',
    'Choose <b>MP4</b> or <b>MP3</b> and save it straight to your device.'
  ],
  downloadTarget(item, format, height) {
    const target = height ? item.downloads?.video + '&height=' + encodeURIComponent(height) : item.downloads?.[format || 'video'];
    return target || '';
  },
  extension(item, format) { return format === 'audio' ? 'mp3' : item.type === 'image' ? 'jpg' : 'mp4'; }
};
