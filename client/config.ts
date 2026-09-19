import type { Deployment } from '../protocol/types.ts';
export interface ClientConfig {
  network: string;
  casino: string;
  games: string;
  deployment?: Deployment;
}
const config: ClientConfig = { network: 'sepolia', casino: 'http://127.0.0.1:4183', games: 'http://127.0.0.1:4185' };
export default config;
