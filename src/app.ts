import './env.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import { authRouter } from './routes/auth.js';
import { organisationsRouter } from './routes/organisations.js';
import { usersRouter, organisationUsersRouter } from './routes/users.js';
import { projectsRouter } from './routes/projects.js';
import { issuesRouter } from './routes/issues.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const app = express();

app.use(requestLogger);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const openapiDocument = YAML.load(path.join(__dirname, '..', 'docs', 'openapi.yaml'));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiDocument));

app.use('/api/auth', authRouter);
app.use('/api/organisations/:orgId/users', organisationUsersRouter);
app.use('/api/organisations', organisationsRouter);
app.use('/api/users', usersRouter);
app.use('/api/projects/:projectId/issues', issuesRouter);
app.use('/api/projects', projectsRouter);

app.use((_req, res) => {
  res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
});

app.use(errorHandler);
