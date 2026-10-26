import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Controller, Get } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { applyHttpDefaults } from './client-static';

//helmet and the built client on a real nest express app, applied by the same function main.ts calls, no database. a
//real vite build has the same shape as the fixture: index.html, hashed files in /assets, a worker and a manifest at the
//root. one api route stands for the router, to see that /api still reaches it and that nest's json 404 answers the rest

const INDEX = '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/index-AbC123.js"></script></body></html>';
const SCRIPT = 'console.log("app");';

@Controller('/api')
class PingController {
  @Get('ping')
  ping() {
    return { pong: true };
  }
}

async function boot(dist: string | null) {
  const moduleRef = await Test.createTestingModule({ controllers: [PingController] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  applyHttpDefaults(app, dist);
  await app.init();
  return app;
}

describe('applyHttpDefaults', () => {
  let tmp: string;
  let dist: string;
  let app: NestExpressApplication;
  let bare: NestExpressApplication;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'client-static-'));
    dist = path.join(tmp, 'dist');
    fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), INDEX);
    fs.writeFileSync(path.join(dist, 'assets', 'index-AbC123.js'), SCRIPT);
    fs.writeFileSync(path.join(dist, 'sw.js'), 'self.addEventListener("install", () => {});');
    fs.writeFileSync(path.join(dist, 'site.webmanifest'), '{"name":"x"}');
    fs.writeFileSync(path.join(dist, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    fs.writeFileSync(path.join(dist, '.secret'), 'dotfile-secret');
    fs.writeFileSync(path.join(tmp, 'outside.txt'), 'outside-secret');
    app = await boot(dist);
    //CLIENT_DIST unset, as on a laptop
    bare = await boot(null);
  });

  afterAll(async () => {
    await app.close();
    await bare.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('a client route answers index.html with no-cache, the root and a trailing slash and a query string included', async () => {
    for (const url of ['/', '/courier', '/courier/tasks/12', '/manager/issuances/', '/courier/reports/0b9f-77?from=sync']) {
      const res = await request(app.getHttpServer()).get(url);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.text).toBe(INDEX);
    }
  });

  it('a HEAD of a client route is answered too, without a body', async () => {
    const res = await request(app.getHttpServer()).head('/courier');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.text ?? '').toBe('');
  });

  it('a hashed file under /assets is served as it is, immutable for a year', async () => {
    const res = await request(app.getHttpServer()).get('/assets/index-AbC123.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.text).toBe(SCRIPT);
  });

  it('a missing file is the 404 of the router, never index.html: under /assets, with an extension, and a missing /assets path without one', async () => {
    for (const url of ['/assets/missing-123.js', '/assets/missing-123.css', '/assets/', '/assets/missing', '/courier.html', '/nothing.js', '/sourcemap.js.map']) {
      const res = await request(app.getHttpServer()).get(url);
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body.statusCode).toBe(404);
      expect(res.text).not.toContain('<!doctype');
    }
  });

  it('the worker, the manifest and every other file outside /assets are served with no-cache, so a new build is picked up', async () => {
    for (const [url, type] of [['/sw.js', /javascript/], ['/site.webmanifest', /json|manifest/], ['/icon.svg', /svg/], ['/index.html', /html/]] as [string, RegExp][]) {
      const res = await request(app.getHttpServer()).get(url);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(type);
      expect(res.headers['cache-control']).toBe('no-cache');
    }
    expect((await request(app.getHttpServer()).get('/sw.js')).text).toBe('self.addEventListener("install", () => {});');
    expect((await request(app.getHttpServer()).get('/site.webmanifest')).text).toBe('{"name":"x"}');
  });

  it('an api path is the router\'s, never index.html: the route itself, a path nothing answers, in any letter case and with a doubled slash', async () => {
    for (const url of ['/api/ping', '/API/ping']) {
      const res = await request(app.getHttpServer()).get(url);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ pong: true });
    }
    for (const url of ['/api/nothing', '/api', '/api/', '/API/nothing', '/api/auth/mode/more', '/api/nothing?x=1', '//api/ping', '//api/nothing', '///API/nothing']) {
      const res = await request(app.getHttpServer()).get(url);
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.text).not.toContain('<!doctype');
    }
    const head = await request(app.getHttpServer()).head('/api/nothing');
    expect(head.status).toBe(404);
  });

  it('only GET and HEAD get the app: a POST, PUT or DELETE of a client route is the router\'s 404', async () => {
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      for (const url of ['/courier', '/']) {
        const res = await request(app.getHttpServer())[method](url);
        expect(res.status).toBe(404);
        expect(res.headers['content-type']).toMatch(/json/);
      }
    }
    expect((await request(app.getHttpServer()).post('/api/ping')).status).toBe(404);
  });

  it('does not serve a dotfile or a file above the folder', async () => {
    const dot = await request(app.getHttpServer()).get('/.secret');
    expect(dot.text).not.toContain('dotfile-secret');
    for (const url of ['/..%2foutside.txt', '/%2e%2e/outside.txt', '/assets/..%2f..%2foutside.txt', '/../outside.txt']) {
      const res = await request(app.getHttpServer()).get(url);
      expect(res.status).not.toBe(200);
      expect(res.text).not.toContain('outside-secret');
    }
  });

  it('takes a folder relative to the working directory', async () => {
    const relative = await boot(path.relative(process.cwd(), dist));
    try {
      const res = await request(relative.getHttpServer()).get('/courier');
      expect(res.status).toBe(200);
      expect(res.text).toBe(INDEX);
    } finally {
      await relative.close();
    }
  });

  it('helmet is in front of the html and of the router, with the one worker-src exception for the qr decoder', async () => {
    for (const url of ['/courier', '/assets/index-AbC123.js', '/api/ping', '/api/nothing']) {
      const res = await request(app.getHttpServer()).get(url);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      const csp = res.headers['content-security-policy'];
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("worker-src 'self' blob:");
      expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    }
  });

  it('CLIENT_DIST unset: the page urls are as 404 as before, and the csp keeps helmet\'s defaults with no blob: worker', async () => {
    for (const url of ['/', '/courier', '/sw.js']) {
      const off = await request(bare.getHttpServer()).get(url);
      expect(off.status).toBe(404);
      expect(off.text).not.toContain('<!doctype');
    }
    const api = await request(bare.getHttpServer()).get('/api/ping');
    expect(api.status).toBe(200);
    expect(api.headers['x-content-type-options']).toBe('nosniff');
    expect(api.headers['content-security-policy']).toContain("default-src 'self'");
    expect(api.headers['content-security-policy']).not.toContain('blob:');
  });
});
