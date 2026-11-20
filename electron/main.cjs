const { app, BrowserWindow, desktopCapturer, dialog, screen, shell } = require('electron');
const path = require('node:path');

const origin = app.isPackaged
  ? require('./service.json').origin
  : 'http://localhost:3847';
const landingURL = new URL('/', origin).href;
const serviceLoadTimeout = 15_000;
let mainWindow;

function isServiceURL(url) {
  try {
    const destination = new URL(url);
    return destination.origin === origin && !destination.username && !destination.password;
  } catch {
    return false;
  }
}

function openInBrowser(url) {
  try {
    const destination = new URL(url);
    if (destination.protocol === 'https:' && !destination.username && !destination.password) {
      void shell.openExternal(destination.href).catch(console.error);
    }
  } catch {
    // Electron can supply a malformed external URL.
  }
}

function configureMedia(window) {
  const { session } = window.webContents;
  const trusted = (contents, url) => contents === window.webContents && isServiceURL(url);
  const allowedDevices = new Set();
  const supported = (permission) => ['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen'].includes(permission);
  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    return trusted(contents, requestingOrigin)
      && supported(permission)
      && (permission !== 'media' || allowedDevices.has(details.mediaType))
      && (!details.embeddingOrigin || isServiceURL(details.embeddingOrigin));
  });
  session.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (!trusted(contents, details.requestingUrl) || !details.isMainFrame || !supported(permission)) {
      callback(false);
      return;
    }
    if (permission !== 'media') {
      callback(true); // Screen sharing also requires approval in the source picker below.
      return;
    }
    try {
      const mediaTypes = (details.mediaTypes || []).filter((type) => type === 'audio' || type === 'video');
      if (mediaTypes.length === 0) {
        callback(false);
        return;
      }
      const devices = mediaTypes.map((type) => type === 'audio' ? 'микрофона' : 'камерата');
      const { response } = await dialog.showMessageBox(window, {
        type: 'question',
        message: `Разрешаваш ли на SharkAI достъп до ${devices.join(' и ')}?`,
        buttons: ['Отказ', 'Разреши'],
        cancelId: 0,
        defaultId: 0,
      });
      const allowed = response === 1 && !window.isDestroyed() && isServiceURL(contents.getURL());
      if (allowed) mediaTypes.forEach((type) => allowedDevices.add(type));
      callback(allowed);
    } catch {
      callback(false);
    }
  });
  session.setDisplayMediaRequestHandler(async (request, callback) => {
    if (request.frame !== window.webContents.mainFrame || !isServiceURL(request.securityOrigin) || !request.userGesture) {
      callback({});
      return;
    }
    try {
      const screens = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      if (screens.length === 0) {
        callback({});
        return;
      }
      const { response } = await dialog.showMessageBox(window, {
        type: 'question',
        message: 'Кой екран искаш да споделиш с SharkAI?',
        buttons: ['Отказ', ...screens.map((screen, index) => screen.name || `Екран ${index + 1}`)],
        cancelId: 0,
        defaultId: 0,
      });
      const source = screens[response - 1];
      callback(source && !window.isDestroyed() && isServiceURL(window.webContents.getURL()) ? { video: source } : {});
    } catch {
      callback({});
    }
  });
}

function createWindow() {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = Math.min(1440, workArea.width);
  const height = Math.min(900, workArea.height);
  const window = new BrowserWindow({
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    width,
    height,
    minWidth: Math.min(480, width),
    minHeight: Math.min(540, height),
    title: 'SharkAI',
    icon: path.join(__dirname, app.isPackaged ? 'assets/logo-icon.png' : '../public/logo-icon.png'),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    autoHideMenuBar: true,
    backgroundColor: '#080b15',
  });
  mainWindow = window;
  let serviceLoadTimer;
  let showingOffline = false;
  window.on('closed', () => {
    clearServiceLoadTimer();
    mainWindow = undefined;
  });

  const { webContents } = window;
  configureMedia(window);
  webContents.on('will-navigate', (event, url) => {
    if (!isServiceURL(url)) {
      event.preventDefault();
      openInBrowser(url);
    } else if (showingOffline) {
      event.preventDefault();
      if (!serviceLoadTimer) loadService(url);
    }
  });
  webContents.on('will-redirect', (event, url) => {
    if (!isServiceURL(url)) event.preventDefault();
  });
  webContents.setWindowOpenHandler(({ url }) => {
    if (isServiceURL(url)) loadService(url);
    else openInBrowser(url);
    return { action: 'deny' };
  });
  webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) showOffline(url);
  });
  webContents.on('did-navigate', (_event, url, httpResponseCode) => {
    if (!isServiceURL(url)) return;
    if (httpResponseCode >= 500) showOffline(url, 'service');
    else showingOffline = false;
  });
  webContents.on('dom-ready', () => {
    if (isServiceURL(webContents.getURL())) clearServiceLoadTimer();
  });
  loadService(landingURL);
  require('./updates.cjs').watchWindowsUpdates(window, app, dialog);

  function clearServiceLoadTimer() {
    clearTimeout(serviceLoadTimer);
    serviceLoadTimer = undefined;
  }

  function loadService(url) {
    clearServiceLoadTimer();
    const timer = setTimeout(() => showOffline(url, 'timeout'), serviceLoadTimeout);
    serviceLoadTimer = timer;
    void window.loadURL(url).catch((error) => {
      if (serviceLoadTimer === timer && error.code !== 'ERR_ABORTED') showOffline(url);
    }).finally(() => {
      if (serviceLoadTimer === timer) clearServiceLoadTimer();
    });
  }

  function showOffline(destination, reason = 'network') {
    if (!isServiceURL(destination) || window.isDestroyed() || (showingOffline && !serviceLoadTimer)) return;
    clearServiceLoadTimer();
    showingOffline = true;
    void window.loadFile(path.join(__dirname, 'offline.html'), { query: { origin, reason, destination } }).catch((error) => {
      if (!window.isDestroyed() && error.code !== 'ERR_ABORTED') console.error('SharkAI offline screen failed:', error.code);
    });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.sharkai.platform');
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(createWindow);
}
