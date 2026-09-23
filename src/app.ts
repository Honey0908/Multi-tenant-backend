import './env.js';

import express from 'express';
import { authRouter } from './routes/auth.js';
import { organisationsRouter } from './routes/organisations.js';
import { usersRouter, organisationUsersRouter } from './routes/users.js';
import { projectsRouter } from './routes/projects.js';
import { issuesRouter } from './routes/issues.js';
import { errorHandler } from './middleware/errorHandler.js';

export const app = express();

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

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
