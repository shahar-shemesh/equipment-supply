import * as path from 'path';

import { NestExpressApplication } from '@nestjs/platform-express';
import type { RequestHandler } from 'express';
import helmet from 'helmet';

//helmet and the built client (client/dist) on the express app, the way main.ts needs them and the spec can run them.
//dist is clientDist() of env.ts: null is the json only server of a laptop, a folder is the docker image
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

//helmet's default headers (nosniff, frame-ancestors, hsts, a strict csp, no x-powered-by). first in the chain so the
//cors preflight and the 404s carry the headers too. the api alone needs no exception: json only, no swagger.
//with the client mounted the defaults still fit the built app: index.html has no inline script, the modules, the css
//and the rubik font files all come from the assets folder, nothing is cross origin. that matters for the worker: a
//fetch from inside sw.js runs under the csp of sw.js, which has no connect-src, so a cross origin asset the worker
//intercepted would be refused (google fonts was, until the font was bundled). one exception, worker-src: qr-scanner's
//fallback decoder (browsers without BarcodeDetector, the ipad's safari) starts its worker from a blob: url
export function applyHttpDefaults(app: NestExpressApplication, dist: string | null) {
  app.use(helmet(dist ? { contentSecurityPolicy: { directives: { 'worker-src': ["'self'", 'blob:'] } } } : {}));
  //after helmet so the html carries the headers, before nest's router so a page url is not a 404
  if (dist) mountClient(app, dist);
}

/*──────────────────────────────────────────────────────────────────────────*/

//the same process and origin as the api, the client calls a relative /api. mounted before nest's router, so it has to
//step aside for everything that is not the app: /api, a missing file, every method but GET and HEAD. static assets go
//through nest's own useStaticAssets: express is not a dependency of this package, it only comes with the platform
function mountClient(app: NestExpressApplication, dir: string) {
  const root = path.resolve(dir);

  //vite names everything under /assets after its content, so a year and immutable is safe there. everything else keeps
  //its name from one build to the next: index.html, sw.js (a stale worker is never replaced), site.webmanifest, the icons,
  //workbox-*.js. no-cache is not "do not store", the browser revalidates by etag and gets a 304
  //index false: "/" goes to the fallback below, which sets the same no-cache on the html
  app.useStaticAssets(root, {
    index: false,
    setHeaders: (res, file) => {
      const first = path.relative(root, file).split(path.sep)[0];
      res.setHeader('Cache-Control', first === 'assets' ? IMMUTABLE : REVALIDATE);
    },
  });
  app.use(spaFallback(root));
}

/*──────────────────────────────────────────────────────────────────────────*/

//the client router owns paths like /courier/tasks/12, the server has no file for them: answer index.html. only for a
//GET or HEAD of a path with no extension, and never for /api or /assets. a missing /assets/x.js, a typo in /api/x or a
//POST must stay a 404 (nest's json one), an index.html behind a script url is a syntax error on the screen
//the checks are on the lower case path with doubled slashes collapsed: express matches routes case blind, so an
//upper case /API/auth/mode reaches the api, and a doubled slash before api is no route of it, it must be the json 404
function spaFallback(root: string): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const p = req.path.toLowerCase().replace(/\/{2,}/g, '/');
    if (p === '/api' || p.startsWith('/api/') || p.startsWith('/assets/') || path.extname(p)) return next();
    res.sendFile('index.html', { root, headers: { 'Cache-Control': REVALIDATE } }, (err) => {
      //a client that hung up half way is an error too, but the response is gone by then
      if (err && !res.headersSent) next(err);
    });
  };
}
