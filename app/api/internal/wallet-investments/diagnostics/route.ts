import { runModuleDiagnostics } from '@/lib/investments/module-diagnostics.server';

export const runtime='nodejs';
export const maxDuration=30;
export function POST(request:Request) {
  return runModuleDiagnostics(request);
}
