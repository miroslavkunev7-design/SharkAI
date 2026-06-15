const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const iconIco = path.join(root, 'public', 'icon.ico');
const iconPng = path.join(root, 'public', 'logo-icon.png');
const desktop = path.join(process.env.USERPROFILE || '', 'Desktop');
const shortcutPath = path.join(desktop, 'SharkAI.lnk');

const installedExe = path.join(
  process.env.LOCALAPPDATA || '',
  'Programs',
  'sharkai',
  'SharkAI.exe'
);

const devLauncher = path.join(root, 'SharkAI-Dev.bat');

function escapePs(p) {
  return p.replace(/'/g, "''");
}

function main() {
  if (!fs.existsSync(iconIco) && !fs.existsSync(iconPng)) {
    console.error('Run: npm run logo:process');
    process.exit(1);
  }

  const iconFile = fs.existsSync(iconIco) ? iconIco : iconPng;
  let target = installedExe;
  let workingDir = path.dirname(installedExe);

  if (!fs.existsSync(target)) {
    const bat = `@echo off\r\ntitle SharkAI\r\ncd /d "${root.replace(/\\/g, '\\\\')}"\r\nstart "" cmd /c "npm run dev"\r\ntimeout /t 4 /nobreak >nul\r\nstart http://localhost:3847\r\n`;
    fs.writeFileSync(devLauncher, bat, 'utf8');
    target = devLauncher;
    workingDir = root;
    console.log('Installed app not found — shortcut opens local dev server.');
  }

  const ps = `
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut('${escapePs(shortcutPath)}')
$s.TargetPath = '${escapePs(target)}'
$s.WorkingDirectory = '${escapePs(workingDir)}'
$s.IconLocation = '${escapePs(iconFile)},0'
$s.Description = 'SharkAI — Autonomous AI Platform'
$s.Save()
`;

  execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"').replace(/\r?\n/g, '; ')}"`, {
    stdio: 'inherit',
    shell: true,
  });

  console.log(`Desktop shortcut updated: ${shortcutPath}`);
  console.log(`Icon: ${iconFile}`);
}

main();
