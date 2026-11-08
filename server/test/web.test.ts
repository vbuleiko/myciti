import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerWeb, webBuildExists } from '../src/web';

describe('registerWeb', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'myciti-web-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>map</title>');
    await writeFile(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function build() {
    const app = Fastify();
    app.get('/api/ping', async () => ({ ok: true }));
    await registerWeb(app, dir);
    await app.ready();
    return app;
  }

  it('refuses a directory without a build', async () => {
    expect(webBuildExists(dir)).toBe(true);
    expect(webBuildExists(join(dir, 'assets'))).toBe(false);
    const app = Fastify();
    await expect(registerWeb(app, join(dir, 'nope'))).rejects.toThrow(/web build not found/);
  });

  it('serves index.html at / and for unknown paths, with security headers', async () => {
    const app = await build();
    for (const url of ['/', '/some/client/route']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('<title>map</title>');
      expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
      expect(res.headers['x-frame-options']).toBe('DENY');
    }
    await app.close();
  });

  it('serves hashed assets as immutable and keeps API 404s as JSON', async () => {
    const app = await build();
    const asset = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const index = await app.inject({ method: 'GET', url: '/' });
    expect(index.headers['cache-control']).not.toMatch(/immutable/);

    const api = await app.inject({ method: 'GET', url: '/api/missing' });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: 'not found' });
    expect(api.headers['content-security-policy']).toBeUndefined();
    const ping = await app.inject({ method: 'GET', url: '/api/ping' });
    expect(ping.json()).toEqual({ ok: true });

    const post = await app.inject({ method: 'POST', url: '/anything' });
    expect(post.statusCode).toBe(404);
    await app.close();
  });
});
