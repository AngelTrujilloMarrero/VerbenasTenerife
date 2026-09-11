import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import vercel from '@astrojs/vercel';

// En Vercel se usa su adaptador (funciones serverless, max 60s en Hobby
// para que quepan los scrapers fríos); en local, Node.
const enVercel = !!process.env.VERCEL;

export default defineConfig({
  output: 'server',
  adapter: enVercel ? vercel({ maxDuration: 60 }) : node({ mode: 'standalone' }),
  server: { port: 4322 }
});
