/**
 * Serve the built web map (`web/dist`) from the API process, so a single `node dist/index.js`
 * is a complete deployment (no nginx, no Docker). Mirrors what `web/nginx.conf` does:
 * security headers, immutable caching of hashed assets, SPA fallback to index.html.
 */
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Same headers as web/nginx-headers.conf (the map's origin is the only script source). */
export const WEB_SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(self), camera=(), microphone=(), payment=()',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "connect-src 'self' https://tiles.openfreemap.org; worker-src 'self' blob:; child-src blob:; font-src 'self'; " +
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};

export function webBuildExists(dir: string): boolean {
  return existsSync(join(dir, 'index.html'));
}

/**
 * Register static serving of `dir`. Sets the not-found handler: unknown non-API GET paths
 * get index.html (client-side routing), everything else a JSON 404.
 */
export async function registerWeb(app: FastifyInstance, dir: string): Promise<void> {
  if (!webBuildExists(dir)) {
    throw new Error(`web build not found in ${dir} (run "pnpm --filter @myciti/web build" or set WEB_DIST=off)`);
  }
  await app.register(fastifyStatic, {
    root: dir,
    // hashed bundles never change; index.html must be re-validated
    setHeaders(reply, path) {
      if (path.includes(`${join(dir, 'assets')}/`)) reply.header('cache-control', 'public, max-age=31536000, immutable');
    },
  });
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/')) return;
    for (const [k, v] of Object.entries(WEB_SECURITY_HEADERS)) reply.header(k, v);
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.code(200).sendFile('index.html');
    return reply.code(404).send({ error: 'not found' });
  });
}
