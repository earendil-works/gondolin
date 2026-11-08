//! Forwards `gondolin-log` records of the network crates (`gondolin_netstack`,
//! `gondolin::egress`, `gondolin_sshproxy`) as controller `log` messages with
//! component `net` when the `net` debug flag is enabled (the node engine's
//! `debug` events of `QemuNetworkBackend`).

use std::sync::Arc;

use crate::controller::Controller;

/// Installs the `gondolin-log` forwarder process-wide (first call wins).
pub fn install(ctl: Arc<Controller>) {
    let sink_ctl = ctl;
    gondolin_log::set_sink(
        gondolin_log::Level::Debug,
        Box::new(move |record| {
            if !record.target.starts_with("gondolin") {
                return;
            }
            let log = gondolin_proto::session::Log {
                component: "net".into(),
                message: record.args.to_string(),
            };
            sink_ctl.send(gondolin_proto::session::LOG, 0, &log);
        }),
    );
}
