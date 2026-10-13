import type { Deployment, Json } from '../protocol/types.ts';
import production from '../config/production.json' with { type: 'json' };
/** What config.js holds: the network, the casino, and the deployment the wallet checks the casino against. A launcher
 * serves its own; a build ships production's. It holds the JSON form, which page.ts reads. */
export interface ClientConfig {
  network: string;
  casino: string;
  deployment: Deployment;
}
const config: Json<ClientConfig> = production;
export default config;
