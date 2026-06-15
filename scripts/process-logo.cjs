const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const publicDir = path.join(__dirname, '..', 'public');
const iconsDir = path.join(publicDir, 'icons');
const inputPath = path.join(publicDir, 'logo-source.png');
const logoPath = path.join(publicDir, 'logo.png');

async function removeBlackBackground(input) {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const threshold = 35;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r <= threshold && g <= threshold && b <= threshold) {
      data[i + 3] = 0;
    }
  }

  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .trim({ threshold: 10 })
    .png({ quality: 100, compressionLevel: 9 });
}

async function main() {
  fs.mkdirSync(iconsDir, { recursive: true });

  if (!fs.existsSync(inputPath)) {
    fs.copyFileSync(logoPath, inputPath);
  }

  const transparent = await removeBlackBackground(inputPath);
  const meta = await transparent.clone().metadata();

  await transparent.clone().toFile(logoPath);
  console.log(`logo.png → ${meta.width}x${meta.height} (transparent)`);

  const processed = sharp(logoPath);
  const trimmed = await processed.metadata();
  const emblemHeight = Math.max(1, Math.round(trimmed.height * 0.58));

  await sharp(logoPath)
    .extract({ left: 0, top: 0, width: trimmed.width, height: emblemHeight })
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(publicDir, 'logo-icon.png'));

  await sharp(logoPath)
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(iconsDir, 'icon-512.png'));

  await sharp(logoPath)
    .resize(192, 192, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(iconsDir, 'icon-192.png'));

  const toIco = require('to-ico');
  const iconPng = path.join(publicDir, 'logo-icon.png');
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngBuffers = await Promise.all(
    sizes.map((size) =>
      sharp(iconPng)
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer()
    )
  );
  const ico = await toIco(pngBuffers);
  fs.writeFileSync(path.join(publicDir, 'icon.ico'), ico);

  console.log('Icons created: logo-icon.png, icon.ico, icon-192.png, icon-512.png');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
