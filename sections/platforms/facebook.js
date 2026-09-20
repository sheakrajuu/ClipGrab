window.clipgrabSections = window.clipgrabSections || {};
window.clipgrabSections.Facebook = {
  title: 'Download Facebook videos and images',
  sub: 'Save public Facebook media in high quality.',
  placeholder: 'Paste Facebook video link here',
  steps: [
    'Tap the ... menu on the video, then <b>Copy Link</b>.',
    'Paste the link into the box above and select <b>Find media</b>.',
    'Pick <b>MP4</b> or <b>MP3</b> and wait for it to save.'
  ],
  downloadTarget(item, format, height) {
    const target = height ? item.downloads?.video + '&height=' + encodeURIComponent(height) : item.downloads?.[format || 'video'];
    return target || '';
  },
  extension(item, format) { return format === 'audio' ? 'mp3' : item.type === 'image' ? 'jpg' : 'mp4'; }
};
