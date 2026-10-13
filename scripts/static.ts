import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../sdk/bin/hookedin-game.js';

export { createStaticServer };

// `npm run dev`: the built wallet, served as its host serves it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] ?? fileURLToPath(new URL('../dist', import.meta.url)));
  const port = Number(process.env.PORT ?? 4184);
  createStaticServer(dir).listen(port, '127.0.0.1', () => console.log(`Serving ${dir}: http://127.0.0.1:${port}`));
}
