import express from 'express';
import { identifyRouter } from './routes/identify';

const app = express();

// Don't reveal the underlying framework/version in responses — a small
// piece of "security through obscurity" that costs nothing and denies
// casual reconnaissance an easy fingerprint (real headers still get
// checked; this just removes one free hint).
app.disable('x-powered-by');

app.use(express.json());

// express.json() throws a SyntaxError for malformed JSON bodies *before*
// our route handlers ever run. Left uncaught, Express's default handler
// would return the raw parser error (including exact byte offsets of the
// bad JSON) — useful to an attacker probing the parser, not to a
// legitimate client. We catch it here and return a deliberately generic
// message instead.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  return next(err);
});

// Container/orchestrator health check.
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

app.use(identifyRouter);

// Fallback 404 — identical for a genuinely missing route and anything else
// unmatched, so probing for valid-vs-invalid paths doesn't leak the API's
// real shape.
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Final safety net: any error that reaches here is unexpected. Log the
// real detail server-side for debugging, but never forward stack traces,
// SQL fragments, or internal file paths to the client.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = Number(process.env.PORT) || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`identity-reconciliation service listening on port ${PORT}`);
  });
}

export default app;
