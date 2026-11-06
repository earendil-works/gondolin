//! Root disk checkpoints for remote sessions: the daemon owns the qcow2
//! overlay, the controller owns the checkpoint file (node's single-file
//! format: the qcow2 plus a JSON trailer the controller appends).
//!
//! | dir | type | payload |
//! |---|---|---|
//! | c→d | `checkpoint_export` (request) | `{}`: stop the VM, stream the overlay as `checkpoint_data`, answer `{ ok, bytes, build_id? }` |
//! | c→d | `checkpoint_import` (request) | `{}` before `start`; the controller then sends the checkpoint file as `checkpoint_data` frames with the same id, the last with `eof`; answered once complete |
//! | both | `checkpoint_data` | `{ data, eof? }` with the request id |
//!
//! An imported checkpoint is used with `root_disk.mode = "checkpoint"`: it is
//! rebased onto the image's rootfs (its backing file names the exporting
//! machine) and booted below a fresh overlay, like `VmCheckpoint.resume`.

use std::io::{Read, Write};
use std::path::PathBuf;

use gondolin_wire::{RawEnvelope, Value};
use serde::Serialize;

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
    pub overlay: Option<PathBuf>,
    /// completed import
    pub imported: Option<PathBuf>,
    /// import in progress: request id, file, path
    importing: Option<(u64, std::fs::File, PathBuf)>,
}

impl Drop for CheckpointState {
    fn drop(&mut self) {
        if let Some((_, _, path)) = self.importing.take() {
            let _ = std::fs::remove_file(path);
        }
        if let Some(path) = self.imported.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[derive(Serialize)]
struct Data<'a> {
    #[serde(with = "serde_bytes")]
    data: &'a [u8],
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
                let path = import_path();
                match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
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
                        "cannot checkpoint: the root disk is not an overlay created by the daemon (rootfs mode cow)",
                    );
                    return;
                }
                if self.close_vm() {
                    self.add_export_waiter(id);
                } else {
                    self.export_overlay(id);
                }
            }
            _ => {}
        }
    }

    /// Streams the overlay to the controller (VM stopped).
    pub(crate) fn export_overlay(&mut self, id: u64) {
        let Some(path) = self.ckpt.overlay.clone() else {
            self.ctl.reply_err(CHECKPOINT_EXPORT, id, "invalid_state", "no overlay");
            return;
        };
        let ctl = self.ctl.clone();
        let build_id = self.ckpt.image_build_id.clone();
        tokio::spawn(async move {
            let res = crate::panics::CatchUnwind::new(async {
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
