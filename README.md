# near-agent-escrow-market

A minimal agent-to-agent **hire marketplace with escrow**, implemented twice on purpose:

1. `market.js` — a dependency-free JavaScript state machine (`register / listService / hire / deliver / accept / dispute / verify`) that models the exact same rules as the on-chain contract, used for simulation + the 7-test suite.
2. `near/` — a single NEAR smart contract (Rust, near-sdk 5.30) that implements the **FT standard (ft-1.0.0)** and the **same escrow state machine** in one account, deployed and fully exercised on **NEAR testnet** with cited, RPC-verifiable transaction hashes (`near/evidence.json`, `near/verify_market.js`).

Token: **AEDT** (Agent Escrow Demo Token, 18 decimals). A hire is a synchronous ledger move: buyer → contract vault at intent time, then vault → seller on accept, or vault → buyer (100%) on dispute. No cross-contract callbacks.

## Quickstart (no install needed for the simulation)

```bash
node demo.js          # scripted happy-path + dispute scenario, exits 0
node test_market.js   # 7 unit tests over the escrow state machine (pure node, no deps)
```

On-chain scripts (testnet, needs `cd near && npm install`):

```bash
node deploy_market.js   # deploy market.wasm to mkt.<account>.testnet + init (0.1 NEAR attach)
node flow_market.js     # full hire->lock->deliver->accept + dispute->refund run, writes evidence.json
node verify_market.js   # keyless: re-resolves every cited tx + live state on public RPCs
```

## Contract API (`near/contract/market/src/lib.rs`)

| Method | Who | Attach | Effect |
|---|---|---|---|
| `new(owner_id, vault_id, total_supply)` | init (payable) | 0.1 NEAR exactly | registers owner (minted supply) + vault entry |
| `storage_deposit(account_id?)` | anyone | ≥ 0.1 NEAR | register a ledger entry (excess refunded) |
| `list_service(service_id, title, price)` | seller | – | list a fixed-price service |
| `hire(order_id, service_id)` | buyer | 1 yocto | price moves buyer → contract vault (**locked at intent time**) |
| `deliver(order_id)` | seller | 1 yocto | escrowed → delivered |
| `accept(order_id)` | buyer | 1 yocto | delivered → released, vault → seller payout |
| `dispute(order_id)` | buyer | 1 yocto | delivered → refunded, vault → buyer (100%) |
| `ft_metadata / ft_total_supply / ft_balance_of` | view | – | FT-1.0.0 standard views |
| `verify_locked` | view | – | Σ(open locks) — the engine's invariant, on-chain half |

## Testnet evidence (NEAR testnet, live-resolvable)

Contract: `mkt.dspaid-bounty452.testnet`. Every hash below resolves on a public RPC (`EXPERIMENTAL_tx_status`) with a success receipt and the event log shown; explorer view: `https://testnet.nearblocks.io/txns/<hash>`.

| Step | Tx hash | Event log |
|---|---|---|
| init (mint 1000 AEDT to buyer) | `7mbWzHWKgpxeZMoKam4nmg6jRecxCNNSds9cYfd2CqZh` | `register` / minted 1000 |
| seller storage_deposit (0.1 NEAR) | `HYLpAfL1mh7GaTbEKZ5mEy19CXreMc9o2HvPptsVeosu` | `register` agent |
| list svc_1 @ 30 AEDT | `DMKnF5ZPGXzQRMQudqkmXW9kne5sbidrDyoQ2JsE4eB2` | `list_service` |
| **hire ord_1 (lock 30)** | `EeBrR9DgteKs8i5rbWx4cJGA9Jux79jLCWgkw1w5JNpL` | `escrow_lock` |
| deliver ord_1 | `VbVNFgsM68ihwEnnXpkKqfp99wVDceizEwd9ZDDickB` | `delivered` |
| **accept ord_1 (release → seller +30)** | `7a5sEzyCADCjmeTYKGbC1U3SEQupAmKvd95UQiiRGLiE` | `escrow_release` |
| hire ord_2 (lock 30) | `C9KAVm3ELSbzrKtvvQ6S66rwkvKbwvJGiYUYoWUajeu8` | `escrow_lock` |
| deliver ord_2 | `GhiYH7KsXWYjm5qYNC6pJL6XRqpFgFejNQ7gN3ed4hKB` | `delivered` |
| **dispute ord_2 (100% refund → buyer)** | `2NftXho4VsjD5aFWP7iiTGNkFByB61UhGZgRKivQvBHs` | `refund` |

Final on-chain state (verified by `verify_market.js`): total supply 1000 AEDT unchanged, buyer 970, seller **30**, contract vault **0**, `verify_locked == 0`, ord_1 `released`, ord_2 `refunded`.

Supporting funding/deploy txs (testnet economics, see disclosures): deploy `5nzRhjzhVKLVaudRYQXn8XgpmGUWNWgZkBBVg7nB1b2W`, delete-code `4J3hwbXtXd39BZ3uvwFUyi85kCFyzNXQrnyRrPPoVeZ8`, mkt→buyer 0.2 NEAR `8zevQwxSt9qEcNe6RRMFb4hxU2nRUsoi2DNxEvpr56Yq`, escrow_old→buyer 0.09 NEAR `6CMhx19FFuawoXvYvvpcdmecut8s3TickskbGXFxDhE2`.

## Simulated vs deployed — disclosure table

| Capability | JS simulation (`market.js`) | Deployed contract (testnet) |
|---|---|---|
| register / storage deposit | ✓ simulated | ✓ tx `HYLpAfL…` (0.1 NEAR attach enforced on-chain) |
| listService | ✓ | ✓ `DMKnF5Z…` |
| hire = lock at intent time | ✓ | ✓ `EeBrR9D…` + view proved vault balance 30 while locked |
| deliver | ✓ | ✓ `VbVNFgs…` |
| accept → release to seller | ✓ | ✓ `7a5sEzy…` (seller +30 AEDT verified by FT view) |
| dispute → 100% refund | ✓ | ✓ `2NftXho…` (buyer made whole on ord_2) |
| double-spend / bad-state rejections | ✓ (tests 3–5) | enforced by asserts; positive paths cited, negative paths not separately tx-proved |
| `verify_locked == vault FT balance` invariant | ✓ | ✓ both views == 0 at the end (mid-flow lock equality also verified live) |
| FT standard surface (ft-1.0.0) | n/a | ✓ `ft_metadata/ft_total_supply/ft_balance_of` return JSON; `ft_transfer` implemented, not exercised on-chain in this run |
| Settlement asset | abstract units | AEDT demo token (no real value) |

## Honest disclosures

- **Single merged contract.** The original design was a token+escrow pair (`ft.*` + `mkt.*`). NEAR testnet charges ~9.6e18 yocto/byte of *consumed* balance per deployed byte, and the funds ran out with two contracts; the merge into one FT+escrow account keeps hire synchronous (an internal ledger debit) and removes all callback complexity. `ft.dspaid-bounty452.testnet` is a dead artifact of that iteration.
- **`decimals` is a JSON string.** A raw numeric literal in `json!` pulls serde_json's `to_value::<i64>` path, whose `i64.load32_s` (signext) instruction this testnet VM refuses to execute (`unreachable` trap). Confirmed by opcode-level diff against a known-good binary.
- **Panic logs are silent on this VM.** Rust panics surface as bare `WebAssembly trap: unreachable` with empty logs even though near-sdk installs a panic hook — diagnostics had to come from gas profiles and A/B controls instead of panic text.
- **`new()` is `#[init(ignore_state)]`** and the market account was reused from an A/B control experiment; init overwrites the STATE key, and collection prefixes (`a2/s2/o2`) avoid stale keys from earlier iterations. It is externally callable (near-sdk 5.x imposes no self-only restriction) — the buyer signed init with the 0.1 NEAR attach because the contract account's balance sits below its consumed code-storage reserve.
- **Code storage on testnet is a sunk cost.** Each full deploy of ~366 KB consumes ~3.5 NEAR of balance permanently; deleting the code releases the balance *check* but not the tokens. That drove the one-shot redeploy discipline (build gates: zero signext loads, zero `current_account_id` imports) and the delete→transfer→redeploy unlock used mid-run.
- **Shared testnet keypair.** All demo sub-accounts use one disposable faucet-funded keypair (hex in `near/lib.js`, overridable via `NEAR_SECRET_HEX`). Testnet-only; never use on mainnet.
- **Gas / attach conventions:** 30 TGas per call; exactly 1 yoctoNEAR for state-changing calls; ≥0.1 NEAR for `storage_deposit` (excess refunded via promise batch).

## Layout

```
market.js / demo.js / test_market.js   engine + demo + 7 tests (pure node)
near/market.wasm                       deployed binary (sha256 prefix 026125f4, near-sdk 5.30, no wasm-opt)
near/contract/market/src/lib.rs        contract source (~220 lines)
near/{deploy,flow,verify}_market.js    deploy / full-flow-with-evidence / keyless verifier
near/evidence.json                     machine-readable evidence (txs, logs, final state)
screenshots/                           demo capture
```

## Build the wasm

```bash
cd near/contract && cargo build --release --target wasm32-unknown-unknown -p market
# do NOT run wasm-opt: v117/v133 --signext-lowering is a no-op while the target-features
# section advertises signext, and their -O/-Oz outputs additionally poison this VM.
```

License: MIT — see [LICENSE](LICENSE).
