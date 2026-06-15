const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

let mainWindow = null;
let nextProcess = null;
const PORT = 3847;
const isDev = !app.isPackaged;

function waitForServer(port, maxAttempts = 60) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}`, (res) => {
        resolve();
      });
      req.on('error', () => {
        attempts++;
        if (attempts >= maxAttempts) reject(new Error('Server timeout'));
        else setTimeout(check, 500);
      });
      req.end();
    };
    check();
  });
}

function startNextServer() {
  if (isDev) return Promise.resolve();

  const appData = path.join(app.getPath('userData'));
  const dbPath = path.join(appData, 'sharkai.db');
  const fs = require('fs');
  fs.mkdirSync(appData, { recursive: true });

  if (!fs.existsSync(dbPath)) {
    const seedDb = path.join(__dirname, '..', 'prisma', 'dev.db');
    const packagedSeed = path.join(process.resourcesPath, 'app', 'prisma', 'dev.db');
    const source = fs.existsSync(packagedSeed) ? packagedSeed : seedDb;
    if (fs.existsSync(source)) fs.copyFileSync(source, dbPath);
  }

  const standalonePath = path.join(process.resourcesPath, 'app');
  const serverPath = path.join(standalonePath, 'server.js');

  const serverFile = require('fs').existsSync(serverPath)
    ? serverPath
    : path.join(__dirname, '..', '.next', 'standalone', 'server.js');

  return new Promise((resolve) => {
    nextProcess = spawn(process.execPath, [serverFile], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: String(PORT),
        HOSTNAME: '127.0.0.1',
        DATABASE_URL: `file:${dbPath}`,
      },
      cwd: path.dirname(serverFile),
      stdio: 'pipe',
    });

    nextProcess.stdout?.on('data', (d) => console.log('[Next]', d.toString()));
    nextProcess.stderr?.on('data', (d) => console.error('[Next]', d.toString()));

    waitForServer(PORT).then(resolve).catch(resolve);
  });
}

function createWindow() {
  const fs = require('fs');
  const iconIco = path.join(__dirname, '../public/icon.ico');
  const iconPng = path.join(__dirname, '../public/logo-icon.png');
  const icon = fs.existsSync(iconIco) ? iconIco : iconPng;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'SharkAI',
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
    autoHideMenuBar: true,
    backgroundColor: '#000000',
  });

  const url = `http://127.0.0.1:${PORT}`;
  mainWindow.loadURL(url);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

ipcMain.handle('get-app-info', () => ({
  name: 'SharkAI',
  version: app.getVersion(),
  platform: process.platform,
}));

ipcMain.handle('check-updates', async () => {
  return { available: false, version: app.getVersion() };
});

app.whenReady().then(async () => {
  if (!isDev) await startNextServer();
  else await waitForServer(PORT).catch(() => {});
  createWindow();
});

app.on('window-all-closed', () => {
  if (nextProcess) nextProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  if (nextProcess) nextProcess.kill();
});
