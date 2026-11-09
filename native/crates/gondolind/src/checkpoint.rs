//! Root disk checkpoints for remote sessions: the daemon owns the qcow2
//! overlay, the controller owns the checkpoint file (node's single-file
//! format: the qcow2 plus a JSON trailer the controller appends).
//!
//! | dir | type | payload |
//! |---|---|---|
//! | c→d | `checkpoint_export` (request) | `{ path? }`: stop the VM, collapse the root disk's chain onto the rootfs, then move it to `path` (local daemons) or stream it as `checkpoint_data`; answer `{ ok, bytes, build_id? }` |
//! | c→d | `checkpoint_import` (request) | `{ path? }` before `start`: use the checkpoint file at `path` in place (local daemons), else the controller sends it as `checkpoint_data` frames with the same id, the last with `eof`; answered once complete |
//! | both | `checkpoint_data` | `{ data, eof? }` with the request id |
//!
//! An imported checkpoint is used with `root_disk.mode = "checkpoint"`: it is
//! rebased onto the image's rootfs (its backing file names the machine and
//! image directory it was created with; metadata only, so a local checkpoint
//! file is updated in place) and booted below a fresh overlay, like
//! `VmCheckpoint.resume`. Exporting such an overlay first collapses its chain
//! onto the rootfs (safe rebase), so the exported file depends on nothing but
//! the image. The controller appends the checkpoint trailer.

use std::io::{Read, Write};
use std::path::PathBuf;

use gondolin_wire::{RawEnvelope, Value};

use crate::fields::Fields;
use crate::session::Session;

pub const CHECKPOINT_EXPORT: &str = "checkpoint_export";
pub const CHECKPOINT_IMPORT: &str = "checkpoint_import";
pub const CHECKPOINT_DATA: &str = "checkpoint_data";

/// Export chunk size in `bytes`.
const CHUNK: usize = 1024 * 1024;

#[derive(Default)]
pub(crate) struct CheckpointState {
    /// build id of the resolved image (for the controller's trailer)
    pub image_build_id: Option<String>,
    /// overlay created by the daemon (exportable)
    pub overlay: Option<crate::rootdisk::Overlay>,
    /// why the root disk cannot be exported (no `overlay`; set at `start`)
    pub export_blocker: Option<String>,
    /// completed import
    pub imported: Option<PathBuf>,
    /// `imported` is the controller's own file (`checkpoint_import` with `path`): never removed
    imported_in_place: bool,
    /// `checkpoint_export` was requested: the VM stays stopped (its disk is
    /// being collapsed and moved away or streamed), starts are refused
    pub exported: bool,
    /// import in progress: request id, file, path
    importing: Option<(u64, std::fs::File, PathBuf)>,
}

impl Drop for CheckpointState {
    fn drop(&mut self) {
        if let Some((_, _, path)) = self.importing.take() {
            let _ = std::fs::remove_file(path);
        }
        if let Some(path) = self.imported.take()
            && !self.imported_in_place
        {
            let _ = std::fs::remove_file(path);
        }
    }
}

gondolin_wire::wire_encode! {
    struct Data<'a> {
        data: &'a [u8],
    }
}

fn import_path() -> PathBuf {
    let mut rand = [0u8; 8];
    let _ = ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut rand);
    let name: String = rand.iter().map(|b| format!("{b:02x}")).collect();
    std::env::temp_dir().join(format!("gondolind-checkpoint-{name}.qcow2"))
}

impl Session {
    pub(crate) fn handle_checkpoint_message(&mut self, msg: RawEnvelope) {
        let id = msg.id;
        match msg.t.as_str() {
            CHECKPOINT_IMPORT => {
                if self.is_started() {
                    self.ctl.reply_err(
                        CHECKPOINT_IMPORT,
                        id,
                        "invalid_state",
                        "import before start",
                    );
                    return;
                }
                if id == 0 || self.ckpt.importing.is_some() || self.ckpt.imported.is_some() {
                    self.ctl.reply_err(
                        CHECKPOINT_IMPORT,
                        id,
                        "invalid_state",
                        "one import per session",
                    );
                    return;
                }
                if let Some(path) = Fields::of(&msg.p).text("path") {
                    let path = PathBuf::from(path);
                    match std::fs::metadata(&path) {
                        Ok(m) if m.is_file() && path.is_absolute() => {
                            self.ckpt.imported = Some(path);
                            self.ckpt.imported_in_place = true;
                            self.ctl.reply_ok(CHECKPOINT_IMPORT, id, vec![]);
                        }
                        Ok(_) => self.ctl.reply_err(
                            CHECKPOINT_IMPORT,
                            id,
                            "invalid_argument",
                            &format!("not an absolute path to a file: {}", path.display()),
                        ),
                        Err(err) => self.ctl.reply_err(
                            CHECKPOINT_IMPORT,
                            id,
                            "io_error",
                            &format!("checkpoint disk not found: {} ({err})", path.display()),
                        ),
                    }
                    return;
                }
                let path = import_path();
                // private: the checkpoint is the guest's disk
                let open = {
                    use std::os::unix::fs::OpenOptionsExt;
                    std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path)
                };
                match open {
                    Ok(file) => self.ckpt.importing = Some((id, file, path)),
                    Err(err) => self.ctl.reply_err(
                        CHECKPOINT_IMPORT,
                        id,
                        "io_error",
                        &format!("cannot create {}: {err}", path.display()),
                    ),
                }
            }
            CHECKPOINT_DATA => {
                let Some((req, file, _)) = self.ckpt.importing.as_mut() else { return };
                if *req != id {
                    return;
                }
                let f = Fields::of(&msg.p);
                let res = file.write_all(f.bytes("data").unwrap_or(&[]));
                if let Err(err) = res {
                    let (req, _, path) = self.ckpt.importing.take().unwrap();
                    let _ = std::fs::remove_file(&path);
                    self.ctl.reply_err(CHECKPOINT_IMPORT, req, "io_error", &err.to_string());
                    return;
                }
                if f.truthy("eof") {
                    let (req, file, path) = self.ckpt.importing.take().unwrap();
                    if let Err(err) = file.sync_all() {
                        let _ = std::fs::remove_file(&path);
                        self.ctl.reply_err(CHECKPOINT_IMPORT, req, "io_error", &err.to_string());
                        return;
                    }
                    self.ckpt.imported = Some(path);
                    self.ctl.reply_ok(CHECKPOINT_IMPORT, req, vec![]);
                }
            }
            CHECKPOINT_EXPORT => {
                if self.ckpt.overlay.is_none() {
                    self.ctl.reply_err(
                        CHECKPOINT_EXPORT,
                        id,
                        "invalid_state",
                        self.ckpt.export_blocker.as_deref().unwrap_or(
                            "cannot checkpoint: the session has no root disk to export (start it first)",
                        ),
                    );
                    return;
                }
                if self.ckpt.exported {
                    self.ctl.reply_err(
                        CHECKPOINT_EXPORT,
                        id,
                        "invalid_state",
                        "the root disk was already exported",
                    );
                    return;
                }
                let dest = Fields::of(&msg.p).text("path").map(PathBuf::from);
                if dest.as_ref().is_some_and(|d| !d.is_absolute()) {
                    self.ctl.reply_err(
                        CHECKPOINT_EXPORT,
                        id,
                        "invalid_argument",
                        "checkpoint_export path must be absolute",
                    );
                    return;
                }
                self.ckpt.exported = true;
                // also wait for a VMM that is already stopping (a restart or
                // lifecycle shutdown in flight) before touching its disk
                if self.close_vm() || self.vm_stopping() {
                    self.add_export_waiter(id, dest);
                } else {
                    self.export_overlay(id, dest);
                }
            }
            _ => {}
        }
    }

    /// Collapses the root disk's chain and moves it to `dest`, or streams it
    /// to the controller (VM stopped).
    pub(crate) fn export_overlay(&mut self, id: u64, dest: Option<PathBuf>) {
        let Some(overlay) = self.ckpt.overlay.clone() else {
            self.ctl.reply_err(CHECKPOINT_EXPORT, id, "invalid_state", "no overlay");
            return;
        };
        if dest.is_some() {
            // moved away: the session has no exportable disk afterwards
            self.ckpt.overlay = None;
        }
        let path = overlay.path.clone();
        let ctl = self.ctl.clone();
        let build_id = self.ckpt.image_build_id.clone();
        tokio::spawn(async move {
            let res = crate::panics::CatchUnwind::new(async {
                if let Some(dest) = dest {
                    return tokio::task::spawn_blocking(move || overlay.export_to(&dest))
                        .await
                        .map_err(|e| format!("cannot checkpoint: {e}"))?;
                }
                // collapse a resumed checkpoint's chain onto the rootfs
                tokio::task::spawn_blocking(move || overlay.collapse())
                    .await
                    .map_err(|e| format!("cannot checkpoint: {e}"))?
                    .map_err(|e| format!("cannot checkpoint: {e}"))?;
                let mut file = std::fs::File::open(&path)
                    .map_err(|e| format!("cannot open {}: {e}", path.display()))?;
                let mut buf = vec![0u8; CHUNK];
                let mut total = 0u64;
                loop {
                    ctl.wait_capacity().await;
                    let n = file.read(&mut buf).map_err(|e| e.to_string())?;
                    if n == 0 {
                        return Ok::<u64, String>(total);
                    }
                    total += n as u64;
                    ctl.send(CHECKPOINT_DATA, id, &Data { data: &buf[..n] });
                }
            })
            .await
            .unwrap_or_else(|panic| Err(format!("internal error: {panic}")));
            match res {
                Ok(bytes) => {
                    let mut fields =
                        vec![(Value::Text("bytes".into()), Value::Integer(bytes.into()))];
                    if let Some(b) = build_id {
                        fields.push((Value::Text("build_id".into()), Value::Text(b)));
                    }
                    ctl.reply_ok(CHECKPOINT_EXPORT, id, fields);
                }
                Err(err) => ctl.reply_err(CHECKPOINT_EXPORT, id, "io_error", &err),
            }
        });
    }
}
