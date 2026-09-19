import { buildVectors } from './vectors.ts';
import { hashChainLink } from '../protocol/hash-chain.ts';

const v = buildVectors(),
  { bankroll, bets, risk } = v.cases[1],
  [{ stake, prizes }] = bets;
const decimal = (value: bigint) => `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, '0')}`;
console.log('Native dice example (illustrative units with six decimals; no transactions sent).');
console.log(
  `Bankroll ${decimal(bankroll)}; stake ${decimal(stake)}; one prize of ${decimal(prizes[0].payout)}; target edge 2%.`,
);
console.log(`Total commission ${decimal(risk.totalFee)}, split equally between the developer and the casino.`);
console.log(`Maximum bankroll loss ${decimal(risk.liability)}.`);
console.log(`Published chain root: ${v.chain.root}`);
console.log(`First opening verifies: ${hashChainLink(v.chain.preimages[0]) === v.chain.root}`);
console.log(
  `Deterministic fixture outcome ${v.outcome.value} pays ${decimal(v.outcome.payout)} on the overlapping-chips bet. Production client and server seeds must be private random bytes.`,
);
