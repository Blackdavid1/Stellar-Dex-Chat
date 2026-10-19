use soroban_sdk::{contractclient, contracterror, contracttype, symbol_short, Address, Env, Symbol};

/// Interface that any price oracle contract must implement.
/// Returns the price of a token in USD with 7 decimal places
/// (i.e. 1 USD = 10_000_000).
#[contractclient(name = "OracleClient")]
pub trait PriceOracle {
    fn get_price(env: Env, token: Address) -> Option<i128>;
}

/// A price value tagged with the ledger sequence at which it was recorded.
/// Used by oracle staleness tests.
pub struct TimestampedPrice {
    /// Price in USD with 7 decimal places (e.g. 10_000_000 = $1.00).
    pub price: i128,
    /// The ledger sequence number at which this price was recorded.
    pub recorded_at: u32,
}

impl TimestampedPrice {
    /// Returns `true` if `current_ledger - recorded_at <= max_age_ledgers`.
    /// Saturates to 0 if `current_ledger < recorded_at` (clock skew guard).
    pub fn is_fresh(&self, current_ledger: u32, max_age_ledgers: u32) -> bool {
        let age = current_ledger.saturating_sub(self.recorded_at);
        age <= max_age_ledgers
    }
}

/// Per-oracle freshness and confidence configuration.
///
/// `max_age_ledgers` is the maximum number of ledgers an observation may lag
/// behind the current ledger before it is considered stale.
/// `min_confidence` is the minimum confidence (in the oracle's own scale) an
/// observation must report to be accepted.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleConfig {
    pub max_age_ledgers: u32,
    pub min_confidence: i128,
}

impl OracleConfig {
    /// Conservative default: observations must be at most 5 ledgers old and
    /// report a confidence of at least 1.
    pub const fn default() -> Self {
        Self {
            max_age_ledgers: 5,
            min_confidence: 1,
        }
    }
}

/// A single price observation returned by an oracle.
///
/// The `price` payload is untrusted and must never be persisted or emitted in
/// diagnostic events; only the oracle identity and observed ledger are safe to
/// surface.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleObservation {
    /// Price in USD with 7 decimal places (e.g. 10_000_000 = $1.00).
    pub price: i128,
    /// The ledger sequence number at which this observation was recorded.
    pub recorded_at: u32,
    /// Confidence reported by the oracle, in the oracle's own scale.
    pub confidence: i128,
}

/// Distinct errors for invalid oracle observations.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OracleError {
    /// No observation was returned by the oracle.
    OracleMissing = 1,
    /// The observation is older than the configured maximum age.
    OracleStale = 2,
    /// The observation is dated in the future relative to the current ledger.
    OracleFutureDated = 3,
    /// The observation's confidence is below the configured threshold.
    OracleLowConfidence = 4,
}

/// Topic used for oracle diagnostic events.
const ORACLE_DIAG_TOPIC: Symbol = symbol_short!("oracle_diag");

/// Validates an oracle observation against the supplied configuration.
///
/// Classifies, in order:
/// - a missing observation (`None`) as [`OracleError::OracleMissing`],
/// - a future-dated observation (`recorded_at > current_ledger`) as
///   [`OracleError::OracleFutureDated`],
/// - a stale observation (`age > max_age_ledgers`) as
///   [`OracleError::OracleStale`],
/// - a below-confidence observation (`confidence < min_confidence`) as
///   [`OracleError::OracleLowConfidence`].
///
/// On success, emits a diagnostic event carrying only the oracle identity, the
/// observed ledger, and the current ledger. The untrusted price payload is
/// never emitted or stored.
pub fn validate_observation(
    env: &Env,
    oracle_id: &Address,
    observation: Option<OracleObservation>,
    config: &OracleConfig,
    current_ledger: u32,
) -> Result<OracleObservation, OracleError> {
    let observation = match observation {
        Some(obs) => obs,
        None => {
            emit_diagnostic(env, oracle_id, None, current_ledger);
            return Err(OracleError::OracleMissing);
        }
    };

    // Future-dated observations are rejected before staleness so that clock
    // skew cannot be masked by saturating subtraction.
    if observation.recorded_at > current_ledger {
        emit_diagnostic(env, oracle_id, Some(observation.recorded_at), current_ledger);
        return Err(OracleError::OracleFutureDated);
    }

    let age = current_ledger.saturating_sub(observation.recorded_at);
    if age > config.max_age_ledgers {
        emit_diagnostic(env, oracle_id, Some(observation.recorded_at), current_ledger);
        return Err(OracleError::OracleStale);
    }

    if observation.confidence < config.min_confidence {
        emit_diagnostic(env, oracle_id, Some(observation.recorded_at), current_ledger);
        return Err(OracleError::OracleLowConfidence);
    }

    emit_diagnostic(env, oracle_id, Some(observation.recorded_at), current_ledger);
    Ok(observation)
}

/// Emits a diagnostic event with only safe metadata: the oracle identity, the
/// observed ledger (if any), and the current ledger. Never includes the price
/// payload.
fn emit_diagnostic(
    env: &Env,
    oracle_id: &Address,
    observed_at: Option<u32>,
    current_ledger: u32,
) {
    let observed = observed_at.unwrap_or(0);
    env.events().publish(
        (ORACLE_DIAG_TOPIC, oracle_id.clone()),
        (observed, current_ledger),
    );
}