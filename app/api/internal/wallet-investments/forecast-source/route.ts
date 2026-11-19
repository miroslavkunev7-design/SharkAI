import { ingestBrokerForecastSource } from '@/lib/investments/forecast-source.server';

export const runtime = 'nodejs';

export function POST(request: Request) {
  return ingestBrokerForecastSource(request);
}
