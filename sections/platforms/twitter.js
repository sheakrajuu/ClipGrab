window.clipgrabSections = window.clipgrabSections || {};
window.clipgrabSections.Twitter = {
  title: 'Download videos, images and GIFs from X',
  sub: 'Grab public media from any X post.',
  placeholder: 'Paste Twitter / X link here',
  steps: [
    'Tap <b>Share</b> on the post, then <b>Copy Link</b>.',
    'Paste the link into the box above and select <b>Find media</b>.',
    'Choose <b>MP4</b> or <b>MP3</b> to finish saving.'
  ],
  downloadTarget(item, format, height) {
    const target = height ? item.downloads?.video + '&height=' + encodeURIComponent(height) : item.downloads?.[format || 'video'];
    return target || '';
  },
  extension(item, format) { return format === 'audio' ? 'mp3' : item.type === 'image' ? 'jpg' : 'mp4'; }
};
