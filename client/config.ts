import type { Deployment } from '../protocol/types.ts';
import production from '../config/production.json' with { type: 'json' };
/** What config.js holds: the network, the casino, and the deployment the wallet checks the casino against. A launcher
 * serves its own; a build ships production's. */
export interface ClientConfig {
  network: string;
  casino: string;
  deployment: Deployment;
}
const config: ClientConfig = production;
export default config;
