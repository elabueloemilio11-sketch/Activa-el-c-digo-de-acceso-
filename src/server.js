import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { directAccessRoutes } from './routes/direct-access.js';
import { musicAssetRoutes } from './routes/music-assets.js';

const config = loadConfig();
const app = await buildApp({ config });
await directAccessRoutes(app);
await musicAssetRoutes(app);

const shutdown = async (signal) => {
  app.log.info({ signal }, 'Graceful shutdown started');
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ error: error.message }, 'Graceful shutdown failed');
    process.exit(1);
  }
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: '0.0.0.0', port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
