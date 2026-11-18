const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFile, writeFile } = require('node:fs/promises');
const { createServer: createHTTPServer } = require('node:http');
const { createConnection, createServer } = require('node:net');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { version } = require('../package.json');

const prompt = 'What is the capital of Bulgaria? Reply in one short sentence.';
const desktopEntryPaths = ['/', '/chat', '/login'];
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

async function openAndClose(executable, mode, check, origin, restoreProxy) {
  const reserved = await listen(0);
  const port = reserved.address().port;
  await new Promise((resolve) => reserved.close(resolve));
  const debuggerURL = `http://127.0.0.1:${port}`;
  const args = [`--remote-debugging-port=${port}`];
  const offline = mode === 'offline' || mode === 'online-recover';
  if (offline) args.push(`--proxy-server=${restoreProxy || 'http://127.0.0.1:9'}`, '--proxy-bypass-list=<-loopback>');
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
        if (offline) return item.title === 'SharkAI — Няма връзка' && item.url.includes('/offline.html');
        if (!URL.canParse(item.url)) return false;
        const url = new URL(item.url);
        return url.origin === origin && desktopEntryPaths.includes(url.pathname);
      });
      return tab?.webSocketDebuggerUrl && info?.webSocketDebuggerUrl ? { tab, info } : null;
    }, offline ? 'The bundled SharkAI offline page did not load.' : 'The installed app did not open the approved SharkAI staging site.');
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
  assert.ok(!['mm-auto-green.vercel.app', 'mm-auto-nadq-jeleva-s-projects.vercel.app'].includes(url.hostname),
    'Online verification requires a staging server.');
  return url.origin;
}

async function recoveryProxy(origin) {
  const destination = new URL(origin);
  const port = Number(destination.port || 443);
  const authority = `${destination.hostname}:${port}`;
  const hostname = destination.hostname.replace(/^\[|\]$/g, '');
  const sockets = new Set();
  let open = false;
  const server = createHTTPServer((_request, response) => response.writeHead(403).end());

  function track(socket) {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
  }

  server.on('connection', track);
  server.on('connect', (request, client, firstBytes) => {
    if (!open || request.url !== authority) {
      client.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = createConnection({ host: hostname, port });
    track(upstream);
    upstream.setTimeout(30_000, () => upstream.destroy());
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (firstBytes.length) upstream.write(firstBytes);
      client.pipe(upstream).pipe(client);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    restore() { open = true; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
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

async function sessionHash(page, origin) {
  const result = await page.send('Network.getCookies', { urls: [origin + '/chat'] });
  const cookie = result.cookies.find(({ name, httpOnly, secure }) => name === 'sharkai_token' && httpOnly && secure);
  assert.ok(cookie?.value, 'A secure SharkAI authentication cookie was not saved in the desktop profile.');
  return digest(cookie.value);
}

async function assertStagedRevision(page, origin) {
  const commit = process.env.SHARKAI_WINDOWS_TEST_COMMIT;
  assert.ok(/^[0-9a-f]{40}$/.test(commit || ''), 'Supply the lowercase 40-character revision of the staged Web application.');
  await waitExpression(page, `location.origin === ${JSON.stringify(origin)} && ${JSON.stringify(desktopEntryPaths)}.includes(location.pathname) && document.readyState === 'complete'`, 'The approved staging page did not finish loading.');
  const activeVersion = await evaluate(page, `fetch('/api/status', {cache:'no-store'}).then(r => r.ok ? r.json() : null)`);
  assert.ok(activeVersion?.ok && activeVersion.version === version && activeVersion.commit === commit,
    'Staging does not serve the exact candidate version and revision under test.');
}

async function openSavedChat(page, origin, state) {
  assertSession(await evaluate(page, sessionExpression));
  assert.equal(await sessionHash(page, origin), state.sessionHash, 'The authenticated desktop session cookie changed.');
  const snapshot = await conversation(page, state.id);
  assert.ok(snapshot?.conversationMode === 'work', 'The saved conversation or its Work mode preference did not survive.');
  assert.ok(snapshot.messages.at(-2)?.content === prompt, 'The saved user message changed.');
  const answer = snapshot.messages.at(-1);
  assert.ok(answer?.role === 'assistant' && digest(answer.content) === state.answerHash, 'The saved Chat reply changed.');
  await evaluate(page, `location.assign('/chat?conversationId=' + encodeURIComponent(${JSON.stringify(state.id)}))`);
  await waitExpression(page, `document.querySelector('.shark-chat-workspace')?.dataset.mode === 'work' &&
    Array.from(document.querySelectorAll('.shark-chat-message-assistant .shark-chat-message-text')).at(-1)?.textContent === ${JSON.stringify(answer.content)}`,
  'The desktop did not display the same reply and saved Work mode.');
}

async function online(executable, mode, statePath) {
  assert.ok(statePath && process.env.SHARKAI_WINDOWS_TEST_EMAIL, 'Authorized staging test account and temporary state path are required.');
  const origin = approvedOrigin();
  const proxy = mode === 'online-recover' ? await recoveryProxy(origin) : null;
  try {
    await openAndClose(executable, mode, async (page) => {
      if (proxy) {
        const retryURL = JSON.stringify(new URL('/', origin).href);
        await waitExpression(page, `document.querySelector('#retry')?.href === ${retryURL}`, 'The offline screen did not offer a Retry link to the approved staging homepage.');
        proxy.restore();
        await evaluate(page, `document.querySelector('#retry').click()`);
        await waitExpression(page, `location.href === ${retryURL}`, 'Retry did not return to the approved staging homepage.');
      }
      await assertStagedRevision(page, origin);
      if (mode !== 'online-seed') {
        await openSavedChat(page, origin, JSON.parse(await readFile(statePath, 'utf8')));
        console.log(proxy ? 'Retry restored the connection and opened the saved ULTRA Chat.' : 'The desktop kept the existing ULTRA session, Work mode and Chat reply.');
        return;
      }

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
      const modeButton = `Array.from(document.querySelectorAll('.shark-chat-mode-switch button')).find(button => button.textContent.trim() === 'Работа')`;
      await waitExpression(page, `${modeButton}?.disabled === false`, 'The Work mode control was unavailable.');
      await evaluate(page, `${modeButton}.click()`);
      await until(async () => (await conversation(page, id))?.conversationMode === 'work', 'Work mode was not saved for the test conversation.');
      const existingSession = await sessionHash(page, origin);
      await writeFile(statePath, JSON.stringify({ id, answerHash: digest(answer.content), sessionHash: existingSession }), { mode: 0o600 });
      console.log('The staged baseline signed in, validated server ULTRA entitlement, saved a real Chat reply and switched that conversation to Work mode.');
    }, origin, proxy?.url);
  } finally {
    await proxy?.close();
  }
}

const [executable, mode = 'offline', statePath] = process.argv.slice(2);
(async () => {
  assert.ok(executable, 'Supply the executable installed by the NSIS setup.');
  assert.ok(['offline', 'online-seed', 'online-resume', 'online-recover'].includes(mode), 'Unknown Windows test mode.');
  if (mode === 'offline') await offline(executable);
  else await online(executable, mode, statePath);
})().catch((error) => {
  // Keep browser responses and supplied credentials out of workflow logs.
  console.error(error.message.split('\n')[0]);
  process.exitCode = 1;
});
