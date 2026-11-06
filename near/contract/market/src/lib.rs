//! Single-account FT escrow market — merged ft_token + ft_escrow for the DAiL bnty_0522
//! testnet proof. One contract implements the FT standard (ft-1.0.0) AND the escrow state
//! machine of market.js, so a hire is a synchronous ledger move (no cross-contract round trip):
//!   register      -> storage_deposit
//!   listService   -> list_service
//!   hire (lock)   -> hire (buyer -> contract ledger entry, funds locked at intent time)
//!   deliver       -> deliver
//!   accept        -> accept (contract -> seller payout)
//!   dispute       -> dispute (100% refund to buyer)
//!   verify        -> verify_locked (sum of open locks == contract's own FT balance)
//! Kept deliberately lean (LookupMap, no json! hot paths) to fit NEAR testnet's pay-as-you-go
//! code-storage charge.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{LookupMap, UnorderedMap};
use near_sdk::{env, near, AccountId, NearToken, PanicOnDefault};

const STORAGE_DEPOSIT_YOCTO: u128 = 100_000_000_000_000_000_000_000; // fixed 0.1 NEAR
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

fn log_line(s: &str) {
    env::log_str(s);
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
#[borsh(crate = "near_sdk::borsh")]
pub struct AccountInfo {
    pub balance: u128,
    pub storage_deposit_yocto: u128,
}

#[derive(near_sdk::serde::Serialize, near_sdk::serde::Deserialize, BorshSerialize, BorshDeserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub struct Service {
    pub seller: AccountId,
    pub title: String,
    pub price: U128,
}

#[derive(near_sdk::serde::Serialize, near_sdk::serde::Deserialize, BorshSerialize, BorshDeserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub struct Order {
    pub buyer: AccountId,
    pub seller: AccountId,
    pub amount: U128,
    /// escrowed | delivered | released | refunded (same state machine as market.js)
    pub state: String,
    pub service: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Market {
    accounts: LookupMap<AccountId, AccountInfo>,
    services: LookupMap<String, Service>,
    orders: UnorderedMap<String, Order>,
    total_supply: u128,
    /// The contract's own account id, captured as an init arg (this testnet VM build cannot
    /// rely on the current_account_id host import; see README disclosure).
    vault: AccountId,
}

#[near]
impl Market {
    /// Registers `owner_id` (the buyer, minted `total_supply`) and `vault_id` (the contract's own
    /// account, holds locked escrow). The deploy transaction attaches exactly 0.1 NEAR as the
    /// owner's storage deposit; `#[payable]` is required because a non-payable init rejects any
    /// non-zero attached deposit.
    #[payable]
    // ignore_state: this demo account was reused from an A/B control experiment whose contract
    // left a stale STATE key; init fully overwrites it with the Market layout.
    #[init(ignore_state)]
    pub fn new(owner_id: AccountId, vault_id: AccountId, total_supply: U128) -> Self {
        assert_eq!(env::attached_deposit().as_yoctonear(), STORAGE_DEPOSIT_YOCTO, "Attach exactly 0.1 NEAR for the owner storage deposit");
        let mut accounts = LookupMap::new(b"a2".to_vec());
        accounts.insert(owner_id.clone(), AccountInfo { balance: total_supply.0, storage_deposit_yocto: STORAGE_DEPOSIT_YOCTO });
        accounts.insert(vault_id.clone(), AccountInfo { balance: 0, storage_deposit_yocto: 0 });
        log_line(&format!("{{\"event\":\"register\",\"agent\":\"{owner_id}\",\"minted\":\"{}\"}}", total_supply.0));
        Self { accounts, services: LookupMap::new(b"s2".to_vec()), orders: UnorderedMap::new(b"o2".to_vec()), total_supply: total_supply.0, vault: vault_id }
    }

    /// On-chain analogue of market.js `register()`: ledger entry backed by a 0.1 NEAR deposit.
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>) -> Value {
        let attach = env::attached_deposit().as_yoctonear();
        assert!(attach >= STORAGE_DEPOSIT_YOCTO, "Attach at least 0.1 NEAR for storage");
        let payer = env::predecessor_account_id();
        let owner = account_id.unwrap_or_else(|| payer.clone());
        if !self.accounts.contains_key(&owner) {
            self.accounts.insert(owner.clone(), AccountInfo { balance: 0, storage_deposit_yocto: STORAGE_DEPOSIT_YOCTO });
            log_line(&format!("{{\"event\":\"register\",\"agent\":\"{owner}\"}}"));
        }
        if attach > STORAGE_DEPOSIT_YOCTO {
            let promise = env::promise_batch_create(&payer);
            env::promise_batch_action_transfer(promise, NearToken::from_yoctonear(attach - STORAGE_DEPOSIT_YOCTO));
        }
        json!({ "registered": owner.to_string() })
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<U128> {
        self.accounts.get(&account_id).map(|a| U128(a.storage_deposit_yocto))
    }

    pub fn ft_metadata(&self) -> Value {
        // decimals is a STRING on purpose: a raw JSON number literal pulls serde_json's to_value(i64)
        // path, whose i64.load32_s (signext) instruction this testnet VM cannot execute.
        json!({ "spec": "ft-1.0.0", "name": "Agent Escrow Demo Token", "symbol": "AEDT", "decimals": "18", "version": "1.0.0" })
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.accounts.get(&account_id).expect("Account is not registered").balance)
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) -> Value {
        assert_eq!(env::attached_deposit().as_yoctonear(), 1, "Attach exactly 1 yoctoNEAR");
        let sender_id = env::predecessor_account_id();
        self.internal_transfer(&sender_id, &receiver_id, amount.0);
        log_line(&format!("{{\"event\":\"ft_transfer\",\"from\":\"{sender_id}\",\"to\":\"{receiver_id}\",\"amount\":\"{}\",\"memo\":\"{}\"}}", amount.0, memo.unwrap_or_default()));
        json!("true")
    }

    /// market.js `listService`: seller lists a service with a fixed price (in FT tokens).
    pub fn list_service(&mut self, service_id: String, title: String, price: U128) {
        let seller = env::predecessor_account_id();
        assert!(!self.services.contains_key(&service_id), "service id taken");
        self.services.insert(service_id.clone(), Service { seller: seller.clone(), title, price });
        log_line(&format!("{{\"event\":\"list_service\",\"seller\":\"{seller}\",\"serviceId\":\"{service_id}\"}}"));
    }

    /// market.js `hire`: buyer pays the listed price into the contract's own FT balance;
    /// tokens are locked at intent time (synchronous — no cross-contract callback needed).
    #[payable]
    pub fn hire(&mut self, order_id: String, service_id: String) {
        assert_eq!(env::attached_deposit(), ONE_YOCTO, "Attach exactly 1 yoctoNEAR");
        let buyer = env::predecessor_account_id();
        let svc = self.services.get(&service_id).expect("unknown service").clone();
        assert!(!self.orders.contains_key(&order_id), "duplicate order id");
        assert_ne!(buyer, svc.seller, "Buyer and seller must differ");
        let me = self.vault.clone();
        self.internal_transfer(&buyer, &me, svc.price.0);
        self.orders.insert(
            order_id.clone(),
            Order { buyer: buyer.clone(), seller: svc.seller.clone(), amount: svc.price.clone(), state: "escrowed".into(), service: service_id.clone() },
        );
        log_line(&format!("{{\"event\":\"escrow_lock\",\"orderId\":\"{order_id}\",\"buyer\":\"{buyer}\",\"seller\":\"{}\",\"amount\":\"{}\"}}", svc.seller, svc.price.0));
    }

    /// market.js `deliver`: only the assigned seller, escrowed -> delivered.
    #[payable]
    pub fn deliver(&mut self, order_id: String) {
        assert_eq!(env::attached_deposit(), ONE_YOCTO, "Attach exactly 1 yoctoNEAR");
        let mut order = self.orders.get(&order_id).expect("No such order").clone();
        assert_eq!(env::predecessor_account_id(), order.seller, "Only the seller can deliver");
        assert_eq!(order.state, "escrowed", "order not escrowed");
        order.state = "delivered".into();
        self.orders.insert(order_id.clone(), order);
        log_line(&format!("{{\"event\":\"delivered\",\"orderId\":\"{order_id}\"}}"));
    }

    /// market.js `accept`: buyer verifies -> escrow releases FT payment to the seller.
    #[payable]
    pub fn accept(&mut self, order_id: String) {
        assert_eq!(env::attached_deposit(), ONE_YOCTO, "Attach exactly 1 yoctoNEAR");
        let mut order = self.orders.get(&order_id).expect("No such order").clone();
        assert_eq!(env::predecessor_account_id(), order.buyer, "Only the buyer can accept");
        assert_eq!(order.state, "delivered", "order not delivered");
        order.state = "released".into();
        let (seller, amount) = (order.seller.clone(), order.amount.0);
        self.orders.insert(order_id.clone(), order);
        let me = self.vault.clone();
        self.internal_transfer(&me, &seller, amount);
        log_line(&format!("{{\"event\":\"escrow_release\",\"orderId\":\"{order_id}\",\"paidTo\":\"{seller}\",\"amount\":\"{amount}\"}}"));
    }

    /// market.js `dispute`: buyer disputes a delivered-but-bad order -> 100% refund.
    #[payable]
    pub fn dispute(&mut self, order_id: String) {
        assert_eq!(env::attached_deposit(), ONE_YOCTO, "Attach exactly 1 yoctoNEAR");
        let mut order = self.orders.get(&order_id).expect("No such order").clone();
        assert_eq!(env::predecessor_account_id(), order.buyer, "Only the buyer can dispute");
        assert_eq!(order.state, "delivered", "order not delivered");
        order.state = "refunded".into();
        let (buyer, amount) = (order.buyer.clone(), order.amount.0);
        self.orders.insert(order_id.clone(), order);
        let me = self.vault.clone();
        self.internal_transfer(&me, &buyer, amount);
        log_line(&format!("{{\"event\":\"refund\",\"orderId\":\"{order_id}\",\"refundedTo\":\"{buyer}\",\"amount\":\"{amount}\"}}"));
    }

    pub fn get_order(&self, order_id: String) -> Option<Order> {
        self.orders.get(&order_id).cloned()
    }

    pub fn list_orders(&self) -> Vec<(String, Order)> {
        self.orders.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    pub fn get_service(&self, service_id: String) -> Option<Service> {
        self.services.get(&service_id).cloned()
    }

    /// market.js `verify` invariant, on-chain half: total value locked in open orders.
    pub fn verify_locked(&self) -> U128 {
        U128(self.orders.values().filter(|o| o.state == "escrowed" || o.state == "delivered").map(|o| o.amount.0).sum())
    }

    fn internal_transfer(&mut self, sender: &AccountId, receiver: &AccountId, amount: u128) {
        assert_ne!(sender, receiver, "Send to a different account");
        assert!(amount > 0, "Transfer amount must be positive");
        let from = self.accounts.get_mut(sender).expect("Sender is not registered");
        assert!(from.balance >= amount, "Insufficient token balance");
        from.balance -= amount;
        let to = self.accounts.get_mut(receiver).expect("Receiver is not registered");
        to.balance += amount;
    }
}
