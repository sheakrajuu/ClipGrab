window.clipgrabSections = window.clipgrabSections || {};
window.clipgrabSections.Reddit = {
  title: 'Reddit media',
  sub: 'Use the Web scanner for public Reddit media. Some posts may not resolve.',
  placeholder: 'Paste a Reddit post link here',
  steps: [
    'Open the post, tap Share, then Copy Link.',
    'Paste the link into the box above and hit Find media.',
    'Switch to <b>Web</b> mode and try the public post link.'
  ],
  downloadTarget() { return ''; },
  extension() { return 'mp4'; }
};
