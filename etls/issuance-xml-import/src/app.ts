import { createHash, timingSafeEqual } from 'crypto';
import express, { NextFunction, Request, Response } from 'express';

import type { RunStatus } from './services/status';
import type { RunTrigger } from './types';
import type { Logger } from './utils/logger';

//the three routes, built from injected pieces so the spec runs them against a fake runner. GET /health is open and
//is what a load balancer or a container probe reads; GET /status and POST /run carry the operator's bearer token.
//no body parser: nothing here takes a body

export type AppDeps = {
  status: RunStatus;
  runner: { start(trigger: RunTrigger): ReturnType<RunStatus['tryStart']> };
  db: { ping(): Promise<boolean> };
  auth: { token: string | null }; //null only on LOCAL without ETL_ADMIN_TOKEN: the two routes are open then
  awaiting: () => Promise<number>;
  logger: Logger;
};

/*──────────────────────────────────────────────────────────────────────────*/

export function buildApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', async (_req, res) => {
    const up = await deps.db.ping();
    res.status(up ? 200 : 503).json({ status: up ? 'ok' : 'degraded', db: up ? 'up' : 'down', uptime_s: Math.round(process.uptime()) });
  });

  const guard = bearer(deps.auth);

  app.get('/status', guard, async (_req, res) => {
    res.json(deps.status.snapshot(await deps.awaiting()));
  });

  //the same pipeline as the scheduler's, run to the end before the answer; one at a time whoever started it
  app.post('/run', guard, async (_req, res) => {
    const started = deps.runner.start('manual');
    if (!started.started) {
      res.status(409).json({ code: 'run_in_progress', run_id: started.run_id });
      return;
    }
    res.json(await started.run);
  });

  app.use((_req, res) => {
    res.status(404).json({ code: 'not_found' });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    deps.logger.error('request failed', { error: err.message });
    res.status(500).json({ code: 'internal_error' });
  });

  return app;
}

/*──────────────────────────────────────────────────────────────────────────*/

//Authorization: Bearer <token>, compared in constant time through two digests so the length of a guess is not a
//signal either. 401 with no detail: the caller either holds the token or not
function bearer(auth: AppDeps['auth']) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (auth.token === null) return next();
    const match = /^Bearer (.+)$/.exec(req.get('authorization') ?? '');
    if (!match || !sameSecret(match[1], auth.token)) {
      res.status(401).json({ code: 'unauthorized' });
      return;
    }
    next();
  };
}

function sameSecret(given: string, expected: string) {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
