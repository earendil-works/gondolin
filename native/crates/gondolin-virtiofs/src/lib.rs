//! Prototype virtio-fs backend for gondolind (see `native/docs/virtio-fs.md`):
//! a minimal vhost-user device ([`vhost_user`]), split virtqueues
//! ([`virtq`]), the FUSE protocol ([`fuse`]) and a host-directory
//! passthrough ([`passthrough`]) standing in for `gondolin-vfs`.

pub mod fuse;
pub mod passthrough;
pub mod vhost_user;
pub mod virtq;
