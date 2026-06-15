const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3847';
const logoPath = path.join(__dirname, '..', 'public', 'logo.png');

async function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(logoPath)], { type: 'image/png' }), 'logo.png');

  const uploadRes = await fetch(`${BASE}/api/upload`, { method: 'POST', body: form });
  if (!uploadRes.ok) throw new Error('Upload failed: ' + uploadRes.status);
  const { uploadId } = await uploadRes.json();
  console.log('uploadId:', uploadId);

  const projRes = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Test Screenshot Build',
      description: 'Възпроизведи 1:1 от screenshot',
      type: 'website',
      inputType: 'screenshot',
      uploadId,
    }),
  });
  if (!projRes.ok) throw new Error('Project create failed: ' + projRes.status);
  const { project } = await projRes.json();
  console.log('project:', project.id);

  for (let i = 0; i < 60; i++) {
    await wait(1000);
    const statusRes = await fetch(`${BASE}/api/projects/${project.id}`);
    const data = await statusRes.json();
    console.log(`[${i + 1}s]`, data.project.status, data.fileCount || 0, 'files');
    if (data.project.status === 'COMPLETED') {
      const dl = await fetch(`${BASE}/api/projects/${project.id}/download`);
      const buf = Buffer.from(await dl.arrayBuffer());
      console.log('ZIP size:', buf.length, 'bytes');
      console.log('Files:', data.files?.join(', '));
      console.log('OK');
      return;
    }
    if (data.project.status === 'FAILED') throw new Error('Build failed');
  }
  throw new Error('Timeout');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
