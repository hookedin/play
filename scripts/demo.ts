import { buildVectors } from './vectors.ts';
import { roundId } from '../protocol/protocol.ts';

const v = buildVectors(),
  {
    bankroll,
    bet: { stake, chance, prize },
    risk,
  } = v.cases[1],
  [casinoBet] = v.operations;
const decimal = (value: bigint) => `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, '0')}`;
console.log('Dice as one casino bet (illustrative units with six decimals; no transactions sent).');
console.log(
  `Bankroll ${decimal(bankroll)}; stake ${decimal(stake)}; a prize of ${decimal(prize)} on ${chance} of 2^64 outcomes; target edge 2%.`,
);
console.log(`Commission ${decimal(risk.fee)}, split equally between the developer and the casino.`);
console.log(`Maximum bankroll loss ${decimal(risk.liability)}.`);
console.log(`The casino bet names round ${casinoBet.operation.round}`);
console.log(`Its revealed secret verifies: ${roundId(casinoBet.secret) === casinoBet.operation.round}`);
console.log(
  `Deterministic fixture outcome ${v.outcome.value} pays ${decimal(v.outcome.payout)} on the bet on red. Production client and server seeds must be private random bytes.`,
);
