const { app, BrowserWindow, desktopCapturer, dialog, shell } = require('electron');
const path = require('node:path');

const origin = app.isPackaged
  ? require('./service.json').origin
  : 'http://localhost:3847';
const landingURL = new URL('/', origin).href;
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
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 480,
    minHeight: 540,
    title: 'SharkAI',
    icon: path.join(__dirname, app.isPackaged ? 'assets/logo-icon.png' : '../public/logo-icon.png'),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    autoHideMenuBar: true,
    backgroundColor: '#080b15',
  });
  mainWindow = window;
  window.on('closed', () => { mainWindow = undefined; });

  const { webContents } = window;
  configureMedia(window);
  webContents.on('will-navigate', (event, url) => {
    if (!isServiceURL(url)) {
      event.preventDefault();
      openInBrowser(url);
    }
  });
  webContents.on('will-redirect', (event, url) => {
    if (!isServiceURL(url)) event.preventDefault();
  });
  webContents.setWindowOpenHandler(({ url }) => {
    if (isServiceURL(url)) void window.loadURL(url).catch(showOffline);
    else openInBrowser(url);
    return { action: 'deny' };
  });
  webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && isServiceURL(url)) showOffline();
  });
  webContents.on('did-navigate', (_event, url, httpResponseCode) => {
    if (isServiceURL(url) && httpResponseCode >= 500) showOffline();
  });
  void window.loadURL(landingURL).catch(() => {}); // did-fail-load handles main-frame network errors.

  function showOffline() {
    if (window.isDestroyed()) return;
    void window.loadFile(path.join(__dirname, 'offline.html'), { query: { origin } }).catch(console.error);
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
