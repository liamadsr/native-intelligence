//! The exit token, checked on this Mac before it connects anywhere (dial8-website
//! `src/lib/cloud-browser/viewer-token.ts`, audience `browser-exit`).
//!
//! The web page hands the app a token and the hub's URL. The page is not
//! trusted with where this Mac's connection goes: the token is signed by
//! Native Intelligence's server (Ed25519), names the hub it is for, and is checked here
//! with the server's public key, fetched from the app's own API origin. A page
//! can't point this Mac at another hub without a token the server signed for it.
//!
//! Format: base64url(JSON claims) "." base64url(signature over
//! "browser-exit.v1." + the first part).

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::Deserialize;

const AUDIENCE: &str = "browser-exit";
const DOMAIN: &str = "browser-exit.v1.";
/// An Ed25519 public key's SubjectPublicKeyInfo DER, before the 32 key bytes.
const SPKI_PREFIX: [u8; 12] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
/// The hub's path for the tunnel.
pub const EXIT_PATH: &str = "/exit";

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Claims {
    pub aud: String,
    pub user_id: String,
    pub workspace_id: String,
    pub sandbox: String,
    pub device_id: Option<String>,
    /// The hub's host (`<id>.vercel.run`): the only one this token opens.
    pub hub: String,
    /// Milliseconds since the epoch.
    pub exp: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TicketError {
    Malformed,
    BadKey,
    BadSignature,
    WrongAudience,
    Expired,
    /// The URL isn't the hub the token names, or isn't wss://<hub>/exit.
    WrongHub,
}

impl std::fmt::Display for TicketError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            TicketError::Malformed => "the exit token is malformed",
            TicketError::BadKey => "the server's key is malformed",
            TicketError::BadSignature => "the exit token isn't signed by Native Intelligence",
            TicketError::WrongAudience => "the token isn't an exit token",
            TicketError::Expired => "the exit token has expired",
            TicketError::WrongHub => "the token isn't for that browser",
        })
    }
}

/// The raw Ed25519 key from the server's public key (base64 SPKI DER).
pub fn public_key(spki_base64: &str) -> Result<[u8; 32], TicketError> {
    let der = STANDARD.decode(spki_base64.trim()).map_err(|_| TicketError::BadKey)?;
    if der.len() != SPKI_PREFIX.len() + 32 || der[..SPKI_PREFIX.len()] != SPKI_PREFIX {
        return Err(TicketError::BadKey);
    }
    der[SPKI_PREFIX.len()..].try_into().map_err(|_| TicketError::BadKey)
}

/// The token's claims, once its signature, audience, lifetime and hub check
/// out against `url`. `loopback_ok` lets `ws://127.0.0.1` through (tests and
/// a local hub in a debug build); otherwise only `wss://<claims.hub>/exit`.
pub fn verify(token: &str, url: &str, key: &[u8; 32], now_ms: u64, loopback_ok: bool) -> Result<Claims, TicketError> {
    let (payload, signature) = token.trim().split_once('.').ok_or(TicketError::Malformed)?;
    let signature = URL_SAFE_NO_PAD.decode(signature).map_err(|_| TicketError::Malformed)?;
    let message = [DOMAIN.as_bytes(), payload.as_bytes()].concat();
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
        .verify(&message, &signature)
        .map_err(|_| TicketError::BadSignature)?;
    let json = URL_SAFE_NO_PAD.decode(payload).map_err(|_| TicketError::Malformed)?;
    let claims: Claims = serde_json::from_slice(&json).map_err(|_| TicketError::Malformed)?;
    if claims.aud != AUDIENCE {
        return Err(TicketError::WrongAudience);
    }
    if claims.exp <= now_ms {
        return Err(TicketError::Expired);
    }
    let url = url::Url::parse(url).map_err(|_| TicketError::WrongHub)?;
    let host = url.host_str().unwrap_or_default();
    let secure = url.scheme() == "wss" && url.port().is_none() && host.eq_ignore_ascii_case(&claims.hub);
    let local = loopback_ok && url.scheme() == "ws" && host == "127.0.0.1" && claims.hub.starts_with("127.0.0.1");
    if !(secure || local) || url.path() != EXIT_PATH || url.query().is_some() || !url.username().is_empty() {
        return Err(TicketError::WrongHub);
    }
    Ok(claims)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    fn keypair() -> Ed25519KeyPair {
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap()
    }

    fn spki(pair: &Ed25519KeyPair) -> String {
        STANDARD.encode([&SPKI_PREFIX[..], pair.public_key().as_ref()].concat())
    }

    fn sign(pair: &Ed25519KeyPair, domain: &str, claims: serde_json::Value) -> String {
        let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
        let signature = pair.sign([domain.as_bytes(), payload.as_bytes()].concat().as_slice());
        format!("{payload}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()))
    }

    fn claims(hub: &str, exp: u64) -> serde_json::Value {
        serde_json::json!({ "aud": "browser-exit", "userId": "u1", "workspaceId": "w1", "sandbox": "browser-a",
            "deviceId": "mac-1", "hub": hub, "exp": exp })
    }

    const NOW: u64 = 1_800_000_000_000;
    const HUB: &str = "sb-abc123.vercel.run";

    #[test]
    fn accepts_a_token_for_its_own_hub() {
        let pair = keypair();
        let key = public_key(&spki(&pair)).unwrap();
        let token = sign(&pair, DOMAIN, claims(HUB, NOW + 60_000));
        let checked = verify(&token, "wss://sb-abc123.vercel.run/exit", &key, NOW, false).unwrap();
        assert_eq!(checked.sandbox, "browser-a");
        assert_eq!(checked.device_id.as_deref(), Some("mac-1"));
    }

    #[test]
    fn refuses_another_hub_signer_audience_or_an_old_token() {
        let pair = keypair();
        let key = public_key(&spki(&pair)).unwrap();
        let good = sign(&pair, DOMAIN, claims(HUB, NOW + 60_000));
        assert_eq!(verify(&good, "wss://sb-evil.vercel.run/exit", &key, NOW, false), Err(TicketError::WrongHub));
        assert_eq!(verify(&good, "ws://sb-abc123.vercel.run/exit", &key, NOW, false), Err(TicketError::WrongHub));
        assert_eq!(verify(&good, "wss://sb-abc123.vercel.run/viewer", &key, NOW, false), Err(TicketError::WrongHub));
        assert_eq!(verify(&good, "wss://sb-abc123.vercel.run:8443/exit", &key, NOW, false), Err(TicketError::WrongHub));
        assert_eq!(verify(&good, "wss://sb-abc123.vercel.run/exit", &key, NOW + 60_000, false), Err(TicketError::Expired));
        let other = keypair();
        let forged = sign(&other, DOMAIN, claims(HUB, NOW + 60_000));
        assert_eq!(verify(&forged, "wss://sb-abc123.vercel.run/exit", &key, NOW, false), Err(TicketError::BadSignature));
        // A viewer token, even for this sandbox, is never an exit token.
        let viewer = sign(&pair, "browser-viewer.v1.", claims(HUB, NOW + 60_000));
        assert_eq!(verify(&viewer, "wss://sb-abc123.vercel.run/exit", &key, NOW, false), Err(TicketError::BadSignature));
        let mut wrong_aud = claims(HUB, NOW + 60_000);
        wrong_aud["aud"] = "browser-viewer".into();
        let wrong_aud = sign(&pair, DOMAIN, wrong_aud);
        assert_eq!(verify(&wrong_aud, "wss://sb-abc123.vercel.run/exit", &key, NOW, false), Err(TicketError::WrongAudience));
        assert_eq!(verify("nonsense", "wss://sb-abc123.vercel.run/exit", &key, NOW, false), Err(TicketError::Malformed));
    }

    #[test]
    fn loopback_only_when_allowed() {
        let pair = keypair();
        let key = public_key(&spki(&pair)).unwrap();
        let token = sign(&pair, DOMAIN, claims("127.0.0.1:4100", NOW + 60_000));
        assert!(verify(&token, "ws://127.0.0.1:4100/exit", &key, NOW, true).is_ok());
        assert_eq!(verify(&token, "ws://127.0.0.1:4100/exit", &key, NOW, false), Err(TicketError::WrongHub));
    }

    #[test]
    fn reads_only_ed25519_keys() {
        assert_eq!(public_key("bm9wZQ=="), Err(TicketError::BadKey));
        assert_eq!(public_key("%%%"), Err(TicketError::BadKey));
    }
}
