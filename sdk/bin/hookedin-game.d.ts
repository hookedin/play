// What hookedin-game.js exports, for a game's TypeScript: the command runs as JavaScript, without a build.
import type { Server } from 'node:http';

/** Build the game in `root` (its src/) into `dist`, `root`/dist by default. */
export function buildGame(root?: string, dist?: string): Promise<void>;
/** Serve the built directory `dir` the way its static host does, building it again with `build` before every page load
 * and reloading every open page when `watched` changes, when given. */
export function createStaticServer(dir: string, build?: () => Promise<unknown>, watched?: string): Server;
/** Serve the game in `root` beside the local wallet, at http://localhost:<port>/; resolves once it listens. */
export function serveGame(root: string, port: number): Promise<Server>;
