// prisma7.config.ts
/// <reference types="node" />
import { defineConfig } from 'prisma/config';

try {
  process.loadEnvFile();
} catch {
  // .env is optional — CI/production environments provide DATABASE_URL directly
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
