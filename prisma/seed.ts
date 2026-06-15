import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL || 'mkunev77@abv.bg';
  const adminPassword = process.env.ADMIN_PASSWORD || 'Mirko0099!';

  const passwordHash = await bcrypt.hash(adminPassword, 12);

  const legacyAdminEmail = 'admin@sharkai.app';
  if (adminEmail !== legacyAdminEmail) {
    await prisma.user.deleteMany({ where: { email: legacyAdminEmail } });
  }

  await prisma.user.upsert({
    where: { email: adminEmail },
    create: {
      email: adminEmail,
      passwordHash,
      name: 'SharkAI Admin',
      role: 'ADMIN',
      plan: 'ULTRA',
      tokensLimit: 999999999,
    },
    update: {
      passwordHash,
      role: 'ADMIN',
      plan: 'ULTRA',
      tokensLimit: 999999999,
    },
  });

  console.log(`Admin seeded: ${adminEmail}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
