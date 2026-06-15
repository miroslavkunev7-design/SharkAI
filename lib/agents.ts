export interface Agent {
  id: string;
  name: string;
  role: string;
  description: string;
  icon: string;
}

export const SUPREME_BRAIN = {
  id: 'supreme-brain',
  name: 'Supreme Brain',
  role: 'Master Reasoning Engine',
  description: 'Controls all agents and makes final decisions',
};

export const AGENTS: Agent[] = [
  { id: 'agent-1', name: 'Visual Intelligence', role: 'Vision AI', description: 'Analyzes screenshots, videos and designs', icon: 'eye' },
  { id: 'agent-2', name: 'Frontend Architect', role: 'UI/UX', description: 'Builds responsive modern interfaces', icon: 'layout' },
  { id: 'agent-3', name: 'Backend Architect', role: 'Server', description: 'Designs APIs and server architecture', icon: 'server' },
  { id: 'agent-4', name: 'Database Engineer', role: 'Data', description: 'Schemas, migrations and queries', icon: 'database' },
  { id: 'agent-5', name: 'DevOps Engineer', role: 'Infrastructure', description: 'CI/CD, Docker and cloud setup', icon: 'cloud' },
  { id: 'agent-6', name: 'Security Engineer', role: 'Security', description: 'Audits and hardens applications', icon: 'shield' },
  { id: 'agent-7', name: 'Performance Optimizer', role: 'Speed', description: 'Optimizes load times and resources', icon: 'zap' },
  { id: 'agent-8', name: 'QA Tester', role: 'Testing', description: 'Automated test generation and execution', icon: 'check' },
  { id: 'agent-9', name: 'Bug Hunter', role: 'Debug', description: 'Finds and reports defects', icon: 'bug' },
  { id: 'agent-10', name: 'Auto Repair Agent', role: 'Repair', description: 'Automatically fixes detected issues', icon: 'wrench' },
  { id: 'agent-11', name: 'Deployment Agent', role: 'Deploy', description: 'Deploys to Vercel, AWS, Cloudflare', icon: 'rocket' },
  { id: 'agent-12', name: 'Business Logic Agent', role: 'Logic', description: 'Implements business rules and workflows', icon: 'brain' },
  { id: 'agent-13', name: 'Product Designer', role: 'Design', description: 'Creates premium UI/UX designs', icon: 'palette' },
  { id: 'agent-14', name: 'AI Research Agent', role: 'Research', description: 'Researches best practices and patterns', icon: 'search' },
  { id: 'agent-15', name: 'Code Refactor Agent', role: 'Refactor', description: 'Improves code quality and structure', icon: 'code' },
];

export const AUTONOMOUS_LOOP = [
  { step: 'analyze', label: 'Analyze', description: 'Parse input and plan architecture' },
  { step: 'build', label: 'Build', description: 'Generate code across all layers' },
  { step: 'run', label: 'Run', description: 'Execute and validate runtime' },
  { step: 'test', label: 'Test', description: 'Run automated test suites' },
  { step: 'compare', label: 'Compare', description: 'Compare against quality targets' },
  { step: 'fix', label: 'Fix', description: 'Auto-repair detected issues' },
  { step: 'improve', label: 'Improve', description: 'Optimize and enhance output' },
  { step: 'deploy', label: 'Deploy', description: 'Deploy to production infrastructure' },
];

export interface Feature {
  id: string;
  title: string;
  icon: string;
  projectType: string;
  inputType: string;
  uploadKinds: Array<'image' | 'video' | 'pdf' | 'figma' | 'none'>;
  subtitle: string;
}

export const FEATURES: Feature[] = [
  { id: 'screenshot-website', title: 'Screenshot to Website', icon: 'monitor', projectType: 'website', inputType: 'screenshot', uploadKinds: ['image'], subtitle: 'HTML/CSS/JS 1:1 from design' },
  { id: 'screenshot-mobile', title: 'Screenshot to Mobile App', icon: 'smartphone', projectType: 'mobile', inputType: 'screenshot', uploadKinds: ['image'], subtitle: 'Flutter app from UI shot' },
  { id: 'screenshot-desktop', title: 'Screenshot to Desktop Software', icon: 'laptop', projectType: 'desktop', inputType: 'screenshot', uploadKinds: ['image'], subtitle: 'Electron desktop app' },
  { id: 'screenshot-saas', title: 'Screenshot to SaaS', icon: 'cloud', projectType: 'saas', inputType: 'screenshot', uploadKinds: ['image'], subtitle: 'Dashboard + billing UI' },
  { id: 'screenshot-game', title: 'Screenshot to Game UI', icon: 'gamepad', projectType: 'game', inputType: 'screenshot', uploadKinds: ['image'], subtitle: 'Canvas game UI shell' },
  { id: 'prompt-software', title: 'Prompt to Software', icon: 'message', projectType: 'website', inputType: 'prompt', uploadKinds: ['none'], subtitle: 'Full stack from text' },
  { id: 'voice-software', title: 'Voice to Software', icon: 'mic', projectType: 'website', inputType: 'voice', uploadKinds: ['none'], subtitle: 'Speak your idea → code' },
  { id: 'video-software', title: 'Video to Software', icon: 'video', projectType: 'website', inputType: 'video', uploadKinds: ['video'], subtitle: 'UI from screen recording' },
  { id: 'figma-code', title: 'Figma to Code', icon: 'figma', projectType: 'website', inputType: 'figma', uploadKinds: ['figma', 'image'], subtitle: 'Figma JSON or export → code' },
  { id: 'pdf-app', title: 'PDF to Application', icon: 'file', projectType: 'website', inputType: 'pdf', uploadKinds: ['pdf'], subtitle: 'PDF spec → web app' },
  { id: 'db-gen', title: 'Database Generator', icon: 'database', projectType: 'database', inputType: 'prompt', uploadKinds: ['none'], subtitle: 'Prisma schema + seeds' },
  { id: 'api-gen', title: 'API Generator', icon: 'api', projectType: 'api', inputType: 'prompt', uploadKinds: ['none'], subtitle: 'REST API + OpenAPI' },
  { id: 'ai-debug', title: 'AI Debugger', icon: 'bug', projectType: 'debug', inputType: 'prompt', uploadKinds: ['none'], subtitle: 'Scan + fix report' },
  { id: 'ai-refactor', title: 'AI Refactor', icon: 'code', projectType: 'refactor', inputType: 'prompt', uploadKinds: ['none'], subtitle: 'Clean architecture plan' },
  { id: 'ai-deploy', title: 'AI Deployment', icon: 'rocket', projectType: 'deploy', inputType: 'prompt', uploadKinds: ['none'], subtitle: 'Vercel/AWS/Cloudflare configs' },
  { id: 'ai-docs', title: 'AI Documentation', icon: 'book', projectType: 'docs', inputType: 'prompt', uploadKinds: ['none'], subtitle: 'Full project docs' },
  { id: 'ai-test', title: 'AI Testing', icon: 'check', projectType: 'test', inputType: 'prompt', uploadKinds: ['none'], subtitle: 'Automated test suite' },
  { id: 'ai-security', title: 'AI Security Audit', icon: 'shield', projectType: 'security', inputType: 'prompt', uploadKinds: ['none'], subtitle: 'Security hardening pack' },
];

export function getFeature(id?: string): Feature {
  return FEATURES.find((f) => f.id === id) || FEATURES[0];
}

export const PLANS = {
  PRO: {
    name: 'PRO',
    price: 12,
    currency: 'EUR',
    features: [
      'Limited monthly tokens',
      'Standard AI speed',
      'Screenshot generation',
      'Website creation',
      'Mobile app creation',
      'Desktop app creation',
      'Code export',
      'Project history',
      'Email support',
    ],
  },
  ULTRA: {
    name: 'ULTRA',
    price: 28,
    currency: 'EUR',
    features: [
      'Unlimited usage',
      'Unlimited AI generations',
      'Maximum AI speed',
      'Full multi-agent system',
      'Priority infrastructure',
      'Unlimited exports',
      'Unlimited deployments',
      'Early access features',
      'Premium support',
      'Unlimited screenshot conversions',
    ],
    popular: true,
  },
};
