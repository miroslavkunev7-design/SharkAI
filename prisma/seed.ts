import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL?.trim();
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required to bootstrap an administrator.');
  }

  const passwordHash = await bcrypt.hash(adminPassword, 12);
  const created = await prisma.user.createMany({
    data: [{
      email: adminEmail,
      passwordHash,
      name: 'SharkAI Admin',
      role: 'ADMIN',
      plan: 'ULTRA',
      tokensLimit: 999999999,
    }],
    skipDuplicates: true,
  });
  console.log(created.count ? 'Bootstrap administrator created.' : 'Bootstrap account already exists.');
}

main().catch((error: unknown) => {
  console.error('Administrator bootstrap failed:', error instanceof Error ? error.name : 'UnknownError');
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
