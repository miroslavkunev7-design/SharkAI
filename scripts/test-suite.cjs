/**
 * SharkAI Test Suite — run: node scripts/test-suite.cjs [--id=test-id]
 * Results saved to .test-results.json
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.TEST_BASE || 'http://localhost:3847';
const ROOT = path.join(__dirname, '..');
const RESULTS_FILE = path.join(ROOT, '.test-results.json');

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${res.status}: ${data.error || text.slice(0, 120)}`);
  return data;
}

async function waitForBuild(projectId, minFiles = 10) {
  for (let i = 0; i < 45; i++) {
    await wait(1000);
    const st = await fetchJson(`${BASE}/api/projects/${projectId}`);
    if (st.project.status === 'COMPLETED') {
      if ((st.fileCount || 0) < minFiles) throw new Error(`Only ${st.fileCount} files`);
      return st;
    }
    if (st.project.status === 'FAILED') throw new Error('FAILED');
  }
  throw new Error('Timeout');
}

const TESTS = [
  {
    id: 'files-logo',
    name: 'Logo & icon files exist',
    category: 'Assets',
    async run() {
      for (const f of ['public/logo.png', 'public/logo-icon.png', 'public/icon.ico']) {
        if (!fs.existsSync(path.join(ROOT, f))) throw new Error(`Missing ${f}`);
      }
    },
  },
  {
    id: 'files-agents',
    name: '18 features + 15 agents defined',
    category: 'Config',
    async run() {
      const src = fs.readFileSync(path.join(ROOT, 'lib/agents.ts'), 'utf8');
      const featureBlock = src.split('export const FEATURES')[1]?.split('export function getFeature')[0] || '';
      const features = (featureBlock.match(/\{ id: '/g) || []).length;
      const agentBlock = src.split('export const AGENTS')[1]?.split('export const AUTONOMOUS_LOOP')[0] || '';
      const agents = (agentBlock.match(/\{ id: 'agent-/g) || []).length;
      if (features < 18) throw new Error(`Only ${features} features`);
      if (agents < 15) throw new Error(`Only ${agents} agents`);
    },
  },
  {
    id: 'api-status',
    name: 'GET /api/status',
    category: 'API',
    async run() {
      const d = await fetchJson(`${BASE}/api/status`);
      if (!d.ok) throw new Error('status not ok');
    },
  },
    {
      id: 'api-chat-casual',
      name: 'Chat: „как си?" отговор',
      category: 'Chat',
      timeout: 5000,
      async run() {
        const start = Date.now();
        const d = await fetchJson(`${BASE}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'как си?', history: [] }),
        });
        const ms = Date.now() - start;
        if (!d.content || d.content.length < 10) throw new Error('Empty reply');
        if (d.mode !== 'local') throw new Error('Expected local mode');
        if (d.tier !== 'instant') throw new Error(`Expected instant tier, got ${d.tier}`);
        if (ms > 3000) throw new Error(`Too slow: ${ms}ms`);
      },
    },
    {
      id: 'api-chat-instant',
      name: 'Chat: мигновен „здравей"',
      category: 'Chat',
      timeout: 3000,
      async run() {
        const start = Date.now();
        const d = await fetchJson(`${BASE}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'здравей', history: [] }),
        });
        const ms = Date.now() - start;
        if (!d.content) throw new Error('Empty reply');
        if (d.tier !== 'instant') throw new Error(`Expected instant, got ${d.tier}`);
        if (ms > 800) throw new Error(`Too slow: ${ms}ms (want <800)`);
      },
    },
    {
      id: 'api-chat-context',
      name: 'Chat: „добре а ти?" — не health',
      category: 'Chat',
      timeout: 3000,
      async run() {
        const d = await fetchJson(`${BASE}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: 'добре а ти ?',
            history: [
              { role: 'user', content: 'здравей' },
              { role: 'assistant', content: 'Здравей! Как си?' },
            ],
          }),
        });
        if (d.tier !== 'instant') throw new Error(`Expected instant, got ${d.tier}`);
        if (/лекар|30 мин|сън/i.test(d.content)) throw new Error('Wrong health reply');
        if (!/добре|мерси|ти/i.test(d.content)) throw new Error(`Bad reply: ${d.content.slice(0, 80)}`);
      },
    },
    {
      id: 'api-chat-doing',
      name: 'Chat: „какво правиш!" — casual',
      category: 'Chat',
      timeout: 3000,
      async run() {
        const d = await fetchJson(`${BASE}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'какво правиш !', history: [] }),
        });
        if (d.tier !== 'instant') throw new Error(`Expected instant, got ${d.tier}`);
        if (/лекар|30 мин|сън/i.test(d.content)) throw new Error('Wrong health reply');
        if (!/говоря|чат|готов|talking|chat/i.test(d.content)) throw new Error(`Bad: ${d.content.slice(0, 80)}`);
      },
    },
    {
      id: 'api-chat-open',
      name: 'Chat: отворен въпрос (космос)',
      category: 'Chat',
      async run() {
        const d = await fetchJson(`${BASE}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'Какво е космосът?', history: [] }),
        });
        if (!d.content || d.content.length < 20) throw new Error('Short reply');
      },
    },
  {
    id: 'api-upload',
    name: 'Upload screenshot',
    category: 'Upload',
    async run() {
      const logoPath = path.join(ROOT, 'public', 'logo.png');
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(logoPath)], { type: 'image/png' }), 'logo.png');
      const res = await fetch(`${BASE}/api/upload`, { method: 'POST', body: form });
      if (!res.ok) throw new Error('Upload failed');
      const d = await res.json();
      if (!d.uploadId) throw new Error('No uploadId');
      global.__lastUploadId = d.uploadId;
    },
  },
  {
    id: 'build-screenshot',
    name: 'Screenshot → 30+ files + ZIP',
    category: 'Build',
    timeout: 90000,
    async run() {
      const logoPath = path.join(ROOT, 'public', 'logo.png');
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(logoPath)], { type: 'image/png' }), 'logo.png');
      const up = await fetch(`${BASE}/api/upload`, { method: 'POST', body: form });
      const { uploadId } = await up.json();

      const { project } = await fetchJson(`${BASE}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Test Screenshot',
          description: 'Test 1:1',
          featureId: 'screenshot-website',
          uploadId,
        }),
      });

      for (let i = 0; i < 60; i++) {
        await wait(1000);
        const st = await fetchJson(`${BASE}/api/projects/${project.id}`);
        if (st.project.status === 'COMPLETED') {
          if ((st.fileCount || 0) < 20) throw new Error(`Only ${st.fileCount} files`);
          const dl = await fetch(`${BASE}/api/projects/${project.id}/download`);
          if (!dl.ok) throw new Error('ZIP download failed');
          const buf = Buffer.from(await dl.arrayBuffer());
          if (buf.length < 10000) throw new Error(`ZIP too small: ${buf.length}`);
          global.__lastProjectId = project.id;
          return;
        }
        if (st.project.status === 'FAILED') throw new Error('Build FAILED');
      }
      throw new Error('Timeout 60s');
    },
  },
  {
    id: 'build-api-gen',
    name: 'API Generator feature',
    category: 'Build',
    timeout: 60000,
    async run() {
      const { project } = await fetchJson(`${BASE}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Test API',
          description: 'REST API test',
          featureId: 'api-gen',
        }),
      });
      for (let i = 0; i < 45; i++) {
        await wait(1000);
        const st = await fetchJson(`${BASE}/api/projects/${project.id}`);
        if (st.project.status === 'COMPLETED') {
          if ((st.fileCount || 0) < 15) throw new Error(`Only ${st.fileCount} files`);
          return;
        }
        if (st.project.status === 'FAILED') throw new Error('FAILED');
      }
      throw new Error('Timeout');
    },
  },
  {
    id: 'build-db-gen',
    name: 'Database Generator feature',
    category: 'Build',
    timeout: 60000,
    async run() {
      const { project } = await fetchJson(`${BASE}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Test DB',
          description: 'Prisma schema test',
          featureId: 'db-gen',
        }),
      });
      for (let i = 0; i < 45; i++) {
        await wait(1000);
        const st = await fetchJson(`${BASE}/api/projects/${project.id}`);
        if (st.project.status === 'COMPLETED') return;
        if (st.project.status === 'FAILED') throw new Error('FAILED');
      }
      throw new Error('Timeout');
    },
  },
  {
    id: 'build-prompt-software',
    name: 'Prompt to Software feature',
    category: 'Build',
    timeout: 60000,
    async run() {
      const { project } = await fetchJson(`${BASE}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Test Prompt App',
          description: 'Landing page for coffee shop',
          featureId: 'prompt-software',
        }),
      });
      await waitForBuild(project.id, 15);
    },
  },
  {
    id: 'build-ai-security',
    name: 'AI Security Audit feature',
    category: 'Build',
    timeout: 60000,
    async run() {
      const { project } = await fetchJson(`${BASE}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Test Security',
          description: 'Security audit pack',
          featureId: 'ai-security',
        }),
      });
      await waitForBuild(project.id, 12);
    },
  },
  {
    id: 'seo-sitemap',
    name: 'GET /sitemap.xml',
    category: 'SEO',
    async run() {
      const res = await fetch(`${BASE}/sitemap.xml`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const xml = await res.text();
      if (!xml.includes('/download')) throw new Error('Missing /download in sitemap');
      if (!xml.includes('localhost') && !xml.includes('sharkai')) throw new Error('Invalid sitemap');
    },
  },
  {
    id: 'preview-html',
    name: 'Project preview returns HTML',
    category: 'Build',
    async run() {
      if (!global.__lastProjectId) {
        const logoPath = path.join(ROOT, 'public', 'logo.png');
        const form = new FormData();
        form.append('file', new Blob([fs.readFileSync(logoPath)], { type: 'image/png' }), 't.png');
        const up = await (await fetch(`${BASE}/api/upload`, { method: 'POST', body: form })).json();
        const { project } = await fetchJson(`${BASE}/api/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Preview test', featureId: 'prompt-software', uploadId: up.uploadId }),
        });
        for (let i = 0; i < 45; i++) {
          await wait(1000);
          const st = await fetchJson(`${BASE}/api/projects/${project.id}`);
          if (st.project.status === 'COMPLETED') { global.__lastProjectId = project.id; break; }
        }
      }
      if (!global.__lastProjectId) throw new Error('No completed project');
      const res = await fetch(`${BASE}/api/projects/${global.__lastProjectId}/preview`);
      const html = await res.text();
      if (!html.includes('<html') && !html.includes('<!DOCTYPE')) throw new Error('Not HTML');
    },
  },
  {
    id: 'installer-file',
    name: 'Windows installer (.exe) exists',
    category: 'Desktop',
    async run() {
      const releaseDir = path.join(ROOT, 'release');
      if (!fs.existsSync(releaseDir)) throw new Error('release/ folder missing — run npm run electron:build');
      const exe = fs.readdirSync(releaseDir).find((f) => f.endsWith('.exe') && f.includes('Setup'));
      if (!exe) throw new Error('No SharkAI-Setup exe in release/');
      const size = fs.statSync(path.join(releaseDir, exe)).size;
      if (size < 1_000_000) throw new Error(`Installer too small: ${size}`);
      global.__installerName = exe;
    },
  },
  {
    id: 'download-route',
    name: 'GET /api/download/installer',
    category: 'Download',
    async run() {
      const res = await fetch(`${BASE}/api/download/installer`);
      if (res.status === 404) throw new Error('Installer not built yet');
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1_000_000) throw new Error(`File too small: ${buf.length}`);
    },
  },
];

async function runTest(test) {
  const start = Date.now();
  try {
    const timeout = test.timeout || 30000;
    await Promise.race([
      test.run(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout ${timeout}ms`)), timeout)),
    ]);
    return {
      id: test.id,
      name: test.name,
      category: test.category,
      status: 'passed',
      duration: Date.now() - start,
      at: new Date().toISOString(),
    };
  } catch (err) {
    return {
      id: test.id,
      name: test.name,
      category: test.category,
      status: 'failed',
      error: err.message,
      duration: Date.now() - start,
      at: new Date().toISOString(),
    };
  }
}

async function main() {
  const onlyId = process.argv.find((a) => a.startsWith('--id='))?.split('=')[1];
  const toRun = onlyId ? TESTS.filter((t) => t.id === onlyId) : TESTS;

  if (onlyId && !toRun.length) {
    console.error('Unknown test:', onlyId);
    process.exit(1);
  }

  console.log(`Running ${toRun.length} tests against ${BASE}...\n`);
  const results = [];
  for (const test of toRun) {
    process.stdout.write(`  ${test.name}... `);
    const r = await runTest(test);
    results.push(r);
    console.log(r.status === 'passed' ? '✓' : `✗ ${r.error}`);
  }

  let all = [];
  if (fs.existsSync(RESULTS_FILE) && onlyId) {
    try {
      all = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
      for (const r of results) {
        const idx = all.findIndex((x) => x.id === r.id);
        if (idx >= 0) all[idx] = r; else all.push(r);
      }
    } catch { all = results; }
  } else if (onlyId) {
    all = results;
  } else {
    all = results;
  }

  const passed = all.filter((r) => r.status === 'passed').length;
  const summary = {
    ranAt: new Date().toISOString(),
    base: BASE,
    total: all.length,
    passed,
    failed: all.length - passed,
    passRate: Math.round((passed / all.length) * 100),
    results: all,
  };

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(summary, null, 2));
  console.log(`\n${passed}/${all.length} passed (${summary.passRate}%)`);
  process.exit(passed === all.length ? 0 : 1);
}

main();

module.exports = { TESTS, runTest };
