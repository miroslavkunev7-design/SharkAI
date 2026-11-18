const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

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

async function openAndClose(executable) {
  const reserved = await listen(0);
  const port = reserved.address().port;
  await new Promise((resolve) => reserved.close(resolve));
  const debuggerURL = `http://127.0.0.1:${port}`;
  const child = spawn(executable, [`--remote-debugging-port=${port}`, '--proxy-server=http://127.0.0.1:9']);
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  try {
    const deadline = Date.now() + 30_000;
    let browser;
    while (Date.now() < deadline) {
      const [tabs, info] = await Promise.all([
        inspect(`${debuggerURL}/json/list`).catch(() => []),
        inspect(`${debuggerURL}/json/version`).catch(() => null),
      ]);
      if (info?.webSocketDebuggerUrl && tabs.some((item) => item.title === 'SharkAI — Няма връзка' && item.url.includes('/offline.html'))) {
        browser = info;
        break;
      }
      if (child.exitCode !== null) throw new Error(`Desktop process exited early (${child.exitCode}).`);
      await delay(250);
    }
    if (!browser) throw new Error('The bundled SharkAI offline page did not load.');
    const duplicate = spawn(executable);
    const [duplicateCode] = await Promise.race([once(duplicate, 'exit'), delay(5000).then(() => [null])]);
    if (duplicateCode !== 0) {
      duplicate.kill();
      throw new Error('A second SharkAI instance did not return control to the first.');
    }
    const socket = new WebSocket(browser.webSocketDebuggerUrl);
    await once(socket, 'open');
    socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    if (await Promise.race([exited, delay(5000).then(() => null)]) !== 0) {
      throw new Error('SharkAI did not close cleanly.');
    }
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

(async () => {
  const legacyPort = await listen(3847);
  try {
    await openAndClose(process.argv[2]);
    await openAndClose(process.argv[2]);
    console.log('Bundled offline screen, occupied legacy port, second instance, clean shutdown and restart passed.');
  } finally {
    legacyPort.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
