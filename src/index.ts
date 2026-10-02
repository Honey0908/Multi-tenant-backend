import { app } from './app.js';
import { logger } from './lib/logger.js';
import { ensureBucketExists } from './lib/s3.js';

const port = process.env.PORT ?? 3000;

async function main() {
  await ensureBucketExists();

  app.listen(port, () => {
    logger.info(`TaskFlow API listening on port ${port}`);
  });
}

main().catch((error) => {
  logger.error({ err: error }, 'failed to start TaskFlow API');
  process.exit(1);
});
