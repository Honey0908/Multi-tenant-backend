import './env.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import { authRouter } from './routes/auth.js';
import { organisationsRouter } from './routes/organisations.js';
import { organisationRouter } from './routes/organisation.js';
import { usersRouter, organisationUsersRouter } from './routes/users.js';
import { projectsRouter } from './routes/projects.js';
import { projectMembersRouter } from './routes/projectMembers.js';
import { issuesRouter } from './routes/issues.js';
import { attachmentsRouter } from './routes/attachments.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const app = express();

// The browser blocks a cross-origin XHR unless the server opts in, and the
// SPA is served from a different origin in development (Vite on :5173) and
// usually in production too. Origins are an explicit allow-list from
// FRONTEND_URL (comma-separated) rather than a wildcard: `credentials` and
// `*` are mutually exclusive per the CORS spec, and an allow-list keeps the
// door open for a future cookie-based session without a rewrite.
const allowedOrigins = (process.env.FRONTEND_URL ?? 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

app.use(requestLogger);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const openapiDocument = YAML.load(path.join(__dirname, '..', 'docs', 'openapi.yaml'));

// The machine-readable contract, for generating a typed API client (see
// docs/FRONTEND.md). The frontend lives in its own repository, so it syncs
// the spec from a running server rather than keeping a copy that silently
// goes stale. `no-store` because a cached spec is exactly the staleness
// this endpoint exists to avoid.
//
// Registered before the Swagger UI mount on purpose: swaggerUi.setup()
// answers *any* path under /docs with the HTML page, so without this a
// generator pointed at /docs/openapi.json would get 200 text/html and fail
// confusingly rather than cleanly. Both spellings return the same JSON.
const serveOpenApiDocument: express.RequestHandler = (_req, res) => {
  res.set('Cache-Control', 'no-store').json(openapiDocument);
};

app.get('/openapi.json', serveOpenApiDocument);
app.get('/docs/openapi.json', serveOpenApiDocument);

app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiDocument));

app.use('/api/auth', authRouter);
app.use('/api/organisation', organisationRouter);
app.use('/api/organisations/:orgId/users', organisationUsersRouter);
app.use('/api/organisations', organisationsRouter);
app.use('/api/users', usersRouter);
app.use('/api/projects/:projectId/issues/:issueId/attachments', attachmentsRouter);
app.use('/api/projects/:projectId/issues', issuesRouter);
app.use('/api/projects/:projectId/members', projectMembersRouter);
app.use('/api/projects', projectsRouter);

app.use((_req, res) => {
  res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
});

app.use(errorHandler);
