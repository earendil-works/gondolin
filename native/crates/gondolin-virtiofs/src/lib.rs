//! virtio-fs backend for gondolind (see `native/docs/virtio-fs.md`): a
//! minimal vhost-user device ([`vhost_user`], QEMU), FUSE over a socket
//! ([`socket`], libkrun), split virtqueues ([`virtq`])
//! and the FUSE protocol ([`fuse`]) over the inode-level
//! [`fuse::FileSystem`] trait. gondolind serves `gondolin-vfs`'s `FsCore`
//! through it; the host-directory [`passthrough`] is only used by the demo
//! (`examples/virtiofs_demo.rs`) and the tests.

pub mod fuse;
pub mod passthrough;
pub mod socket;
pub mod vhost_user;
pub mod virtq;
