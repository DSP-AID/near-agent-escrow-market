// Shared config for the NEAR testnet demo scripts (DAiL bnty_0522).
const near = require('near-api-js');

// Public testnet RPC providers (rpc.testnet.near.org is deprecated + heavily rate-limited,
// so it stays late in the failover list). Override with NEAR_RPC=<url> to pin one provider.
const RPCS = [process.env.NEAR_RPC].filter(Boolean).concat([
  'https://test.rpc.fastnear.com',
  'https://near-testnet.drpc.org',
  'https://testnet-rpc.intea.rs',
  'https://archival-rpc.testnet.near.org',
  'https://rpc.testnet.near.org',
]);

function provider() {
  return new near.FailoverRpcProvider(RPCS.map((url) => new near.JsonRpcProvider({ url })));
}

const MAIN = process.env.NEAR_ACCOUNT || 'dspaid-bounty452.testnet'; // buyer/deployer (funded by faucet)
const MKT = `mkt.${MAIN}`;     // the single merged FT+escrow market contract
const SELLER = `agent.${MAIN}`; // seller wallet

const GAS = 30_000_000_000_000n; // 30 TGas per function call
const ONE_YOCTO = 1n;            // required attach for hire/deliver/accept/dispute/ft_transfer
const STORAGE_DEPOSIT = 100_000_000_000_000_000_000_000n; // 0.1 NEAR

// Testnet-only disposable keypair (funded by the NEAR testnet faucet), shared by all
// demo sub-accounts. Override with NEAR_SECRET_HEX=<64-hex> to run your own instance.
const SECRET_HEX = process.env.NEAR_SECRET_HEX ||
  '339eb72aaeebe94856f8396604f6fd04e9b7cdcc155c843a67d29e86427ebf6c';
const SECRET = 'ed25519:' + near.baseEncode(new Uint8Array(Buffer.from(SECRET_HEX, 'hex')));

function account(id = MAIN) {
  return new near.Account(id, provider(), SECRET);
}

// All tx/receipt hashes of an RpcTransactionResponse (for explorer links).
function txHashes(res) {
  const out = [];
  if (res.transaction?.hash) out.push(res.transaction.hash);
  if (res.transaction_outcome?.id) out.push(res.transaction_outcome.id);
  for (const r of res.receipts_outcome || []) if (r.id) out.push(r.id);
  return [...new Set(out)];
}

// FT token units: 18 decimals -> 1 token = 1e18 raw yocto-tokens.
const t = (n) => (BigInt(n) * 1_000_000_000_000_000_000n).toString();

module.exports = { near, RPCS, provider, MAIN, MKT, SELLER, GAS, ONE_YOCTO, STORAGE_DEPOSIT, SECRET, account, txHashes, t };
