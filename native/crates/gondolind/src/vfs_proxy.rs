//! Interim VFS backend: forwards sandboxfs requests to the controller
//! (`vfs_rpc { op, req }` → `vfs_rpc_result { ok, err, res?, message? }`),
//! where the node engine's `FsRpcService` serves them from the JS providers.
//! Replaced by the native VFS (`gondolin-vfs`) as it lands.

use std::sync::Arc;

use gondolin_wire::Value;

use crate::controller::{CallError, Controller};
use crate::fields::Fields;
use crate::subsystem::{FsReply, VfsBackend, errno};

/// Controller request type of the proxy.
pub const VFS_RPC: &str = "vfs_rpc";

pub struct ControllerVfs {
    ctl: Arc<Controller>,
}

impl ControllerVfs {
    pub fn new(ctl: Arc<Controller>) -> Self {
        ControllerVfs { ctl }
    }
}

gondolin_wire::wire_encode! {
    struct VfsRpc<'a> {
        op: &'a str,
        req: Value,
    }
}

impl VfsBackend for ControllerVfs {
    fn handle<'a>(&'a self, op: &'a str, req: Value) -> crate::BoxFuture<'a, FsReply> {
        Box::pin(async move {
            match self.ctl.request(VFS_RPC, &VfsRpc { op, req }).await {
                Ok(result) => {
                    let f = Fields::of(&result);
                    let err =
                        f.int("err").and_then(|e| i64::try_from(e).ok()).unwrap_or(errno::EIO);
                    FsReply {
                        err,
                        res: f.get_some("res").cloned(),
                        message: f.text("message").map(str::to_string),
                    }
                }
                Err(CallError::Remote(e)) => FsReply::error(errno::EIO, e.message),
                Err(e) => FsReply::error(errno::EIO, e.to_string()),
            }
        })
    }
}
