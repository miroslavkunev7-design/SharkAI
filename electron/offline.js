const state = new URLSearchParams(window.location.search);
const origin = state.get('origin');
const reason = state.get('reason');
const message = document.getElementById('offline-message');
const retry = document.getElementById('retry');

if (reason === 'timeout') {
  message.textContent = 'SharkAI не отговори навреме. Опитай отново след малко.';
} else if (reason === 'service') {
  message.textContent = 'Услугата SharkAI е временно недостъпна. Опитай отново след малко.';
}

if (origin) {
  const home = new URL('/', origin);
  retry.href = home.href;
  try {
    const destination = new URL(state.get('destination') || '/', home);
    if (destination.origin === home.origin && !destination.username && !destination.password) retry.href = destination.href;
  } catch {
    // If the requested address is missing or invalid, Retry still opens SharkAI.
  }
  retry.addEventListener('click', () => {
    message.textContent = 'Свързваме се със SharkAI…';
  });
}
