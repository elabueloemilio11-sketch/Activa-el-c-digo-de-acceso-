import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const assets = new Map([
  ['/assets/academy-music.js', ['public/assets/academy-music.js', 'text/javascript; charset=utf-8']],
  ['/assets/academy-music.css', ['public/assets/academy-music.css', 'text/css; charset=utf-8']],
  ['/assets/music/01-rainy-night-jazz.mp3', ['public/assets/music/01-rainy-night-jazz.mp3', 'audio/mpeg']],
  ['/assets/music/02-study-session.mp3', ['public/assets/music/02-study-session.mp3', 'audio/mpeg']],
  ['/assets/music/03-chillhop-jazz.mp3', ['public/assets/music/03-chillhop-jazz.mp3', 'audio/mpeg']],
  ['/assets/music/04-cosmic-focus.mp3', ['public/assets/music/04-cosmic-focus.mp3', 'audio/mpeg']]
]);

export async function musicAssetRoutes(app) {
  for (const [url, [relative, type]] of assets) {
    app.get(url, async (_request, reply) => {
      const data = await readFile(path.join(root, relative));
      return reply
        .header('cache-control', type === 'audio/mpeg' ? 'public, max-age=86400' : 'public, max-age=300')
        .type(type)
        .send(data);
    });
  }
}
