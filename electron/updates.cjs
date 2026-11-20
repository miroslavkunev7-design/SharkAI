const fs = require('node:fs');
const path = require('node:path');

const project = 'miroslavkunev7-design';
const repository = 'SharkAI';
const interval = 4 * 60 * 60 * 1000;

function trustedFeed(config) {
  const names = Array.isArray(config?.publisherName) ? config.publisherName : [config?.publisherName];
  return config?.provider === 'github' && config.owner === project && config.repo === repository
    && config.verifyUpdateCodeSignature !== false && names.length > 0
    && names.every((value) => typeof value === 'string' && value.trim().length > 0);
}

function watchWindowsUpdates(window, app, dialog) {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  let config;
  try {
    const yaml = require('js-yaml');
    config = yaml.load(fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8'));
  } catch {
    return;
  }
  if (!trustedFeed(config)) return;

  const { autoUpdater } = require('electron-updater');
  configureUpdater(window, dialog, autoUpdater);
}

function configureUpdater(window, dialog, autoUpdater) {
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  let lastCheck = 0;
  let checking = false;
  let pending = false;

  function check() {
    if (checking || pending || Date.now() - lastCheck < interval) return;
    lastCheck = Date.now();
    checking = true;
    void autoUpdater.checkForUpdates().then((result) => result?.downloadPromise)
      .catch(() => {}).finally(() => { checking = false; });
  }

  async function ready(info) {
    if (pending || window.isDestroyed()) return;
    pending = true;
    try {
      const { response } = await dialog.showMessageBox(window, {
        type: 'info', title: 'Обновяване на SharkAI',
        message: `SharkAI ${info.version} е готова за инсталиране.`,
        detail: 'Запази започнатата работа преди рестартиране.',
        buttons: ['По-късно', 'При затваряне', 'Рестартирай сега'], defaultId: 0, cancelId: 0,
      });
      if (response === 2 && !window.isDestroyed()) autoUpdater.quitAndInstall(false, true);
      if (response === 1 && !window.isDestroyed()) {
        window.once('closed', () => autoUpdater.quitAndInstall(true, false));
      }
      if (response === 0) {
        lastCheck = Date.now();
        pending = false;
      }
    } catch {
      pending = false;
    }
  }

  const handleError = () => {}; // Offline startup or an unavailable feed must not interrupt the app.
  autoUpdater.on('error', handleError);
  autoUpdater.on('update-downloaded', ready);
  window.on('focus', check);
  const timer = setInterval(check, interval);
  timer.unref();
  window.once('closed', () => {
    clearInterval(timer);
    autoUpdater.removeListener('update-downloaded', ready);
    // Downloads may complete after the window closes. Keep the harmless error listener until exit.
  });
  check();
}

module.exports = { configureUpdater, trustedFeed, watchWindowsUpdates };
