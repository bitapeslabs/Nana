require("dotenv").config();

const GENESIS_BLOCK = parseInt(process.env.GENESIS_BLOCK ?? 840_000);
const TAPROOT_ANNEX_PREFIX = 0x50;
const UNLOCK_INTERVAL = 17500; //https://docs.ordinals.com/runes/specification.html -> Etching the runestone
const COMMIT_CONFIRMATIONS = 6;
const INITIAL_AVAILABLE = 13; //https://docs.ordinals.com/runes/specification.html -> Etching the runestone
const TAPROOT_SCRIPT_PUBKEY_TYPE = "witness_v1_taproot";
const MAX_SIGNED_128_BIT_INT = 0x7fffffffffffffffffffffffffffffffn + 1n;

const GENESIS_RUNESTONE = {
  etching: {
    rune: "UNCOMMONGOODS",
    spacers: 128,
    symbol: "⧉",
    turbo: true,
    terms: {
      amount: 1n,
      cap: 0xffffffffffffffffffffffffffffffffn,
      height: [840000, 1050000],
      offset: [null, null],
    },
  },
  cenotaph: false,
};

module.exports = {
  GENESIS_RUNESTONE,
  GENESIS_BLOCK,
  UNLOCK_INTERVAL,
  INITIAL_AVAILABLE,
  TAPROOT_ANNEX_PREFIX,
  COMMIT_CONFIRMATIONS,
  TAPROOT_SCRIPT_PUBKEY_TYPE,
  MAX_SIGNED_128_BIT_INT,
};
