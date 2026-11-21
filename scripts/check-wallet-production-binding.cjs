// Compare inside the Vercel build. Never print connection strings, credentials or hostnames.
const candidate = 'bxtxygakafwusstpptkg';
function projectOf(value, kind) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (kind === 'api' && url.protocol === 'https:') {
      return /^([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname)?.[1] ?? null;
    }
    if (kind === 'postgres' && ['postgresql:', 'postgres:'].includes(url.protocol)) {
      const direct = /^db\.([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname);
      if (direct) return direct[1];
      if (/\.pooler\.supabase\.com$/.test(url.hostname)) {
        return /\.([a-z0-9]{20})$/.exec(decodeURIComponent(url.username))?.[1] ?? null;
      }
    }
  } catch { /* An unparsable value provides no evidence of a binding. */ }
  return null;
}

function walletBinding(env) {
  const state = (key, kind) => {
    if (!env[key]) return 'unset';
    const ref = projectOf(env[key], kind);
    return !ref ? 'unrecognized' : ref === candidate ? 'match' : 'different';
  };
  return {
    NEXT_PUBLIC_SUPABASE_URL: state('NEXT_PUBLIC_SUPABASE_URL','api'),
    SUPABASE_URL: state('SUPABASE_URL','api'),
    POSTGRES_PRISMA_URL: state('POSTGRES_PRISMA_URL','postgres'),
    POSTGRES_URL_NON_POOLING: state('POSTGRES_URL_NON_POOLING','postgres'),
    DATABASE_URL: state('DATABASE_URL','postgres'),
  };
}
if (require.main === module && process.env.VERCEL_ENV === 'production') {
  console.info('Wallet production binding:', JSON.stringify(walletBinding(process.env)));
}
module.exports = {walletBinding};
