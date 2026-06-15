import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    ok: true,
    version: '1.0.0',
    mode: 'local',
    ai: false,
    features: {
      supremeBrain: true,
      screenshotVision: true,
      codeGeneration: true,
      autonomousLoop: true,
      zipDownload: true,
      payments: !!process.env.STRIPE_SECRET_KEY,
    },
  });
}
