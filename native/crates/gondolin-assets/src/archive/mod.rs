//! Image archive handling: gzip ([`gzip`], own framing + CRC-32 around
//! `miniz_oxide`) and a minimal hardened tar reader ([`tar`]).

pub mod crc32;
pub mod gzip;
pub mod tar;
