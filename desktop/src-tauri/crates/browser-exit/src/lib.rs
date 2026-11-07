//! The Mac exit for the agent's cloud browser (dial8-website
//! docs/plans/cloud-browser.md, C4): when this Mac is online, the sites the
//! agent's browser visits see this Mac's internet connection, and nothing of
//! this Mac or its network is reachable through it.
//!
//! - [`ticket`]: the server-signed exit token, checked before connecting.
//! - [`policy`]: where a stream may go (public, ports 80/443).
//! - [`mux`]: the tunnel's frames.
//! - [`node`]: the tunnel itself.

pub mod mux;
pub mod node;
pub mod policy;
pub mod ticket;
