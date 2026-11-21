export const quickChatEvent = 'sharkai:open-chat';

declare global {
  interface Window { sharkQuickChatRequestedAt?: string }
}

export function requestQuickChat() {
  window.sharkQuickChatRequestedAt = location.href;
  window.dispatchEvent(new Event(quickChatEvent));
}

export function takeQuickChatRequest() {
  const pending = window.sharkQuickChatRequestedAt;
  delete window.sharkQuickChatRequestedAt;
  return pending === location.href;
}

// The ZIP's launchers are native buttons in server-rendered HTML. Capture their
// first click even before the client bundle has registered the dialog listener.
export const earlyQuickChatScript = `
document.addEventListener('click', function (event) {
  if (!(event.target instanceof Element)) return;
  if (!event.target.closest('button[data-shark-chat-launcher], button.original-chat-launch')) return;
  event.stopPropagation();
  window.sharkQuickChatRequestedAt = location.href;
  window.dispatchEvent(new Event('${quickChatEvent}'));
}, true);`;
