const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFile, writeFile } = require('node:fs/promises');
const { createServer } = require('node:net');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { version } = require('../package.json');

const prompt = 'What is the capital of Bulgaria? Reply in one short sentence.';
const digest = (value) => createHash('sha256').update(value).digest('hex');

async function listen(port) {
  const server = createServer();
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function inspect(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
  return response.json();
}

async function until(check, description, milliseconds = 30_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(350);
  }
  throw new Error(description);
}

async function connect(url) {
  assert.match(url, /^ws:\/\/127\.0\.0\.1:\d+\/(?:devtools\/page|devtools\/browser)\//);
  const socket = new WebSocket(url);
  await Promise.race([once(socket, 'open'), delay(5000, undefined, { ref: false }).then(() => {
    throw new Error('Desktop inspection did not connect.');
  })]);
  let commandId = 0;
  const requests = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    const request = requests.get(message.id);
    if (!request) return;
    requests.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(`Desktop command failed: ${request.method}`));
    else request.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const request of requests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Desktop inspection ended.'));
    }
    requests.clear();
  });
  return {
    send(method, params = {}) {
      const id = ++commandId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          requests.delete(id);
          reject(new Error(`Desktop command timed out: ${method}`));
        }, 15_000);
        requests.set(id, { method, resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    closeApp() { socket.send(JSON.stringify({ id: ++commandId, method: 'Browser.close' })); },
    close() { socket.close(); },
  };
}

async function evaluate(page, expression) {
  const result = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error('The installed SharkAI page operation failed.');
  return result.result.value;
}

async function waitExpression(page, expression, description, timeout) {
  return until(async () => evaluate(page, expression).catch(() => false), description, timeout);
}

async function enterText(page, selector, value) {
  const path = JSON.stringify(selector);
  await waitExpression(page, `!!document.querySelector(${path}) && !document.querySelector(${path}).disabled`, 'Expected form input is unavailable.');
  await evaluate(page, `document.querySelector(${path}).focus()`);
  await page.send('Input.insertText', { text: value });
}

async function openAndClose(executable, mode, check, origin) {
  const reserved = await listen(0);
  const port = reserved.address().port;
  await new Promise((resolve) => reserved.close(resolve));
  const debuggerURL = `http://127.0.0.1:${port}`;
  const args = [`--remote-debugging-port=${port}`];
  if (mode === 'offline') args.push('--proxy-server=http://127.0.0.1:9');
  const child = spawn(executable, args, { stdio: 'ignore' });
  const exited = once(child, 'exit').catch(() => [null]);
  let browser;
  let page;
  try {
    assert.ok(child.pid, 'The installed SharkAI executable could not start.');
    const { info, tab } = await until(async () => {
      if (child.exitCode !== null) throw new Error(`Desktop process exited early (${child.exitCode}).`);
      const [tabs, info] = await Promise.all([
        inspect(`${debuggerURL}/json/list`).catch(() => []),
        inspect(`${debuggerURL}/json/version`).catch(() => null),
      ]);
      const tab = tabs.find((item) => {
        if (item.type !== 'page') return false;
        if (mode === 'offline') return item.title === 'SharkAI — Няма връзка' && item.url.includes('/offline.html');
        const url = new URL(item.url);
        return url.origin === origin && ['/chat', '/login'].includes(url.pathname);
      });
      return tab?.webSocketDebuggerUrl && info?.webSocketDebuggerUrl ? { tab, info } : null;
    }, mode === 'offline' ? 'The bundled SharkAI offline page did not load.' : 'The installed app did not open the approved SharkAI staging chat.');
    browser = await connect(info.webSocketDebuggerUrl);
    page = await connect(tab.webSocketDebuggerUrl);
    await check(page);
    browser.closeApp();
    const [code] = await Promise.race([exited, delay(7000, undefined, { ref: false }).then(() => [null])]);
    assert.equal(code, 0, 'SharkAI did not close cleanly.');
  } finally {
    page?.close();
    browser?.close();
    if (child.exitCode === null) {
      child.kill();
      await exited.catch(() => {});
    }
  }
}

async function offline(executable) {
  const legacyPort = await listen(3847);
  try {
    await openAndClose(executable, 'offline', async (page) => {
      await waitExpression(page, `document.querySelector('#retry')?.textContent?.trim() === 'Опитай отново'`, 'Offline retry control did not load.');
      const duplicate = spawn(executable, { stdio: 'ignore' });
      const [code] = await Promise.race([once(duplicate, 'exit'), delay(5000, undefined, { ref: false }).then(() => [null])]);
      if (code !== 0) {
        duplicate.kill();
        throw new Error('A second SharkAI instance did not return control to the first.');
      }
    });
    await openAndClose(executable, 'offline', async () => {});
    console.log('Bundled offline screen, occupied legacy port, second instance, clean shutdown and restart passed.');
  } finally {
    legacyPort.close();
  }
}

function approvedOrigin() {
  const url = new URL(process.env.SHARKAI_WINDOWS_TEST_ORIGIN || 'https://invalid.invalid');
  assert.ok(url.protocol === 'https:' && url.href === `${url.origin}/` && url.hostname !== 'invalid.invalid', 'An approved HTTPS staging origin is required.');
  assert.notEqual(url.hostname, 'mm-auto-nadq-jeleva-s-projects.vercel.app', 'Online verification requires a staging server.');
  return url.origin;
}

const sessionExpression = `(async () => {
  const response = await fetch('/api/chat', { cache: 'no-store' });
  if (!response.ok) return null;
  const state = await response.json();
  return state.user;
})()`;

async function conversation(page, id) {
  return evaluate(page, `(async () => {
    const response = await fetch('/api/chat?conversationId=' + encodeURIComponent(${JSON.stringify(id)}), { cache: 'no-store' });
    return response.ok ? response.json() : null;
  })()`);
}

function assertSession(account) {
  assert.ok(account?.plan === 'ULTRA' && account.email === process.env.SHARKAI_WINDOWS_TEST_EMAIL, 'Staging session does not belong to the supplied ULTRA test account.');
}

async function online(executable, mode, statePath) {
  assert.ok(statePath && process.env.SHARKAI_WINDOWS_TEST_EMAIL, 'Authorized staging test account and temporary state path are required.');
  const origin = approvedOrigin();
  await openAndClose(executable, mode, async (page) => {
    await waitExpression(page, `location.origin === ${JSON.stringify(origin)} && ['/chat', '/login'].includes(location.pathname) && document.readyState === 'complete'`, 'The approved staging page did not finish loading.');
    const activeVersion = await evaluate(page, `fetch('/api/status', {cache:'no-store'}).then(r => r.ok ? r.json() : null)`);
    assert.ok(activeVersion?.ok && activeVersion.version === version, 'Staging does not serve the installed SharkAI version.');
    if (mode === 'online-new') {
      const password = process.env.SHARKAI_WINDOWS_TEST_PASSWORD;
      assert.ok(password, 'Authorized staging test password is required.');
      assert.equal(await evaluate(page, sessionExpression), null, 'A clean Windows installation was already signed in.');
      await evaluate(page, `location.assign('/login?next=%2Fchat')`);
      await waitExpression(page, `location.origin === ${JSON.stringify(origin)} && location.pathname === '/login' && document.readyState === 'complete'`, 'SharkAI login page did not load.');
      await enterText(page, 'input[type=email]', process.env.SHARKAI_WINDOWS_TEST_EMAIL);
      await enterText(page, 'input[type=password]', password);
      await evaluate(page, `document.querySelector('form button[type=submit]').click()`);
      await waitExpression(page, `location.pathname === '/chat'`, 'Signing in through the Windows login form did not open Chat.');
      assertSession(await evaluate(page, sessionExpression));
      await waitExpression(page, `!!document.querySelector('.shark-chat-new')`, 'Chat navigation did not load.');
      await evaluate(page, `document.querySelector('.shark-chat-new').click()`);
      await enterText(page, '#chat-input', prompt);
      await waitExpression(page, `document.querySelector('button[aria-label="Изпрати"]')?.disabled === false`, 'Send was unavailable.');
      await evaluate(page, `document.querySelector('button[aria-label="Изпрати"]').click()`);
      const id = await waitExpression(page, `new URL(location.href).searchParams.get('conversationId')`, 'A new Chat conversation was not opened.', 120_000);
      const state = await until(async () => {
        const snapshot = await conversation(page, id);
        const messages = snapshot?.messages ?? [];
        return messages.at(-2)?.content === prompt && messages.at(-1)?.role === 'assistant' ? snapshot : null;
      }, 'The installed client did not persist a real assistant answer.', 120_000);
      const answer = state.messages.at(-1);
      assert.match(answer.content, /sofia|софия/iu, 'Assistant answer did not contain the expected result.');
      assert.equal(answer.toolResult, null, 'The smoke request unexpectedly used a tool.');
      await writeFile(statePath, JSON.stringify({ id, answerHash: digest(answer.content) }), { mode: 0o600 });
      console.log('Installed client login form, server ULTRA entitlement and real Chat reply passed.');
    } else {
      assertSession(await evaluate(page, sessionExpression));
      const { id, answerHash } = JSON.parse(await readFile(statePath, 'utf8'));
      const state = await conversation(page, id);
      assert.ok(state, 'The saved Chat conversation did not reopen.');
      assert.equal(digest(state.messages.at(-1).content), answerHash, 'Saved Chat reply changed.');
      console.log('The installed client retained its ULTRA session and saved Chat reply.');
    }
  }, origin);
}

const [executable, mode = 'offline', statePath] = process.argv.slice(2);
(async () => {
  assert.ok(executable, 'Supply the executable installed by the NSIS setup.');
  assert.ok(['offline', 'online-new', 'online-resume'].includes(mode), 'Unknown Windows test mode.');
  if (mode === 'offline') await offline(executable);
  else await online(executable, mode, statePath);
})().catch((error) => {
  // Keep browser responses and supplied credentials out of workflow logs.
  console.error(error.message.split('\n')[0]);
  process.exitCode = 1;
});
