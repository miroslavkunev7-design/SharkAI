const origin = new URLSearchParams(window.location.search).get('origin');
if (origin) document.getElementById('retry').href = new URL('/chat', origin).href;
