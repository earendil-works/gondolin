//! A registered session: a started [`Vm`] plus its registry entry and IPC
//! socket (`ensureSessionIpc`), so `list`/`attach`/`exec --sock`/`snapshot`
//! from either CLI reach it.

use std::sync::Arc;

use tokio::sync::mpsc;

use crate::configure::Prepared;
use crate::registry::{self, IpcContext, IpcServer};
use crate::vm::Vm;

pub struct Session {
    pub vm: Arc<Vm>,
    pub id: String,
    ipc: Option<IpcServer>,
    snapshot_done: tokio::sync::Mutex<mpsc::UnboundedReceiver<()>>,
    /// a snapshot request is being served (the VM stops underneath the command)
    snapshotting: Arc<std::sync::atomic::AtomicBool>,
}

impl Session {
    /// Starts the VM and registers it.
    pub async fn start(prepared: Prepared, label: String) -> Result<Session, String> {
        let vm = Vm::start(prepared).await?;
        let id = crate::util::uuid_v4();
        registry::gc().await;
        let info = match registry::register(&id, Some(label)) {
            Ok(info) => info,
            Err(e) => {
                vm.close().await;
                return Err(e);
            }
        };
        let (done_tx, snapshot_done) = mpsc::unbounded_channel();
        let snapshotting = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let snapshot: registry::SnapshotFn = {
            let vm = vm.clone();
            let snapshotting = snapshotting.clone();
            Arc::new(move |path: String| {
                let vm = vm.clone();
                snapshotting.store(true, std::sync::atomic::Ordering::SeqCst);
                Box::pin(async move { vm.checkpoint(&path).await })
            })
        };
        let next_client = {
            let vm = vm.clone();
            Arc::new(move || vm.client_id())
        };
        let ipc = IpcServer::start(
            std::path::Path::new(&info.socket_path),
            IpcContext {
                engine: vm.engine.clone(),
                next_client,
                snapshot: Some(snapshot),
                snapshot_done: done_tx,
            },
        );
        // like the Node CLI, a session without IPC still runs (it just
        // cannot be attached to)
        let ipc = match ipc {
            Ok(ipc) => Some(ipc),
            Err(e) => {
                eprintln!("warning: session {id} is not attachable: {e}");
                registry::unregister(&id);
                None
            }
        };
        Ok(Session {
            vm,
            id,
            ipc,
            snapshot_done: tokio::sync::Mutex::new(snapshot_done),
            snapshotting,
        })
    }

    /// Resolves once a snapshot request stopped this session.
    pub async fn snapshotted(&self) {
        if self.snapshot_done.lock().await.recv().await.is_none() {
            std::future::pending::<()>().await;
        }
    }

    /// Runs a command's main future. When a snapshot stops the VM meanwhile,
    /// waits for the snapshot to be answered and returns `None`; termination
    /// signals return their exit code.
    pub async fn run<F: std::future::Future<Output = i32>>(&self, main: F) -> Option<i32> {
        use gondolind::util::{Either, select2};
        let code = match select2(main, select2(crate::commands::termination(), self.snapshotted()))
            .await
        {
            Either::Left(code) => code,
            Either::Right(Either::Left(code)) => return Some(code),
            Either::Right(Either::Right(())) => return None,
        };
        if self.snapshotting.load(std::sync::atomic::Ordering::SeqCst) {
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(120), self.snapshotted()).await;
            return None;
        }
        Some(code)
    }

    /// Whether a snapshot request is being served.
    pub fn is_snapshotting(&self) -> bool {
        self.snapshotting.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Stops the VM and unregisters.
    pub async fn close(mut self) {
        if let Some(ipc) = self.ipc.take() {
            ipc.close();
        }
        registry::unregister(&self.id);
        self.vm.close().await;
    }
}

/// `sessionLabel`: the command line.
pub fn label() -> String {
    std::env::args().collect::<Vec<_>>().join(" ")
}
