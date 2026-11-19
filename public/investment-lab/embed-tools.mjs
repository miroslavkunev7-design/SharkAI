const embedded = new URLSearchParams(location.search).get('embed') === '1';
const livePage = !location.pathname.endsWith('/simulator.html');

if (embedded) {
  document.documentElement.classList.add('embed');
  for (const link of document.querySelectorAll('a[data-embed-link]')) {
    const url = new URL(link.href);
    url.searchParams.set('embed', '1');
    link.href = url.href;
  }
  if (parent !== window) {
    let previous = 0;
    function reportHeight() {
      const height = Math.ceil(document.body.getBoundingClientRect().height);
      if (height > 0 && height !== previous) {
        previous = height;
        parent.postMessage({ type: 'sharkai-investments-resize', height }, location.origin);
      }
    }
    new ResizeObserver(reportHeight).observe(document.body);
    window.addEventListener('load', reportHeight);
    document.fonts?.ready.then(reportHeight);
    reportHeight();
  }
}

// Preserve bookmarks to the original seven-day simulation.
if (livePage && location.hash === '#weekly') {
  const simulator = new URL('./simulator.html', location.href);
  simulator.search = location.search;
  simulator.hash = 'weekly';
  location.replace(simulator);
}
