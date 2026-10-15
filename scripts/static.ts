import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../sdk/bin/hookedin-game.js';

// `npm run dev`: the built wallet, served as its host serves it.
const dir = fileURLToPath(new URL('../dist', import.meta.url)),
  port = Number(process.env.PORT ?? 4184);
createStaticServer(dir).listen(port, '127.0.0.1', () => console.log(`Serving ${dir}: http://127.0.0.1:${port}`));
