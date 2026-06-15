const BASE = 'http://localhost:3847';

const FEATURES = [
  'screenshot-website',
  'api-gen',
  'ai-security',
  'db-gen',
];

async function testFeature(featureId) {
  const res = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `Test ${featureId}`,
      description: 'Тестов проект от multi-agent системата',
      featureId,
      type: 'website',
      inputType: 'prompt',
    }),
  });
  if (!res.ok) throw new Error(`${featureId} create failed`);
  const { project } = await res.json();

  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const st = await fetch(`${BASE}/api/projects/${project.id}`);
    const data = await st.json();
    if (data.project.status === 'COMPLETED') {
      console.log(`✓ ${featureId}: ${data.fileCount} files, ${data.agents?.length || 0} agents`);
      return;
    }
    if (data.project.status === 'FAILED') throw new Error(`${featureId} failed`);
  }
  throw new Error(`${featureId} timeout`);
}

async function main() {
  for (const f of FEATURES) {
    await testFeature(f);
  }
  console.log('ALL OK');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
