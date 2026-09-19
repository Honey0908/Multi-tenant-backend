import './env.js';

import express from 'express';
import { logger } from './lib/logger.js';
import { organisationsRouter } from './routes/organisations.js';
import { usersRouter, organisationUsersRouter } from './routes/users.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();
const port = process.env.PORT ?? 3000;

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/organisations/:orgId/users', organisationUsersRouter);
app.use('/api/organisations', organisationsRouter);
app.use('/api/users', usersRouter);

app.use((_req, res) => {
  res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
});

app.use(errorHandler);

app.listen(port, () => {
  logger.info(`TaskFlow API listening on port ${port}`);
});
