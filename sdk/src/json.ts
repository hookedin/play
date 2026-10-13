/** The JSON layer, for a game's own JSON: what its page saves in its storage, and what its server stores and sends.
 * JSON holds every whole number as a decimal string: `json` writes a bigint as one, `plain` is a value as JSON holds
 * it, and `read`'s readers take each value back in its one form, every whole number a bigint, or throw. */
export { json, plain } from '../../protocol/protocol.ts';
export * as read from '../../protocol/read.ts';
