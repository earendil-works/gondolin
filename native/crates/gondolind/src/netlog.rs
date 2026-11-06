//! Forwards `tracing` events of the network crates (`gondolin_netstack`,
//! `gondolin::egress`, `gondolin_sshproxy`) as controller `log` messages with
//! component `net` when the `net` debug flag is enabled (the node engine's
//! `debug` events of `QemuNetworkBackend`).

use std::fmt::Write as _;
use std::sync::Arc;

use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::subscriber::Subscriber;
use tracing::{Event, Level, Metadata};

use crate::controller::Controller;

struct Forwarder {
    ctl: Arc<Controller>,
}

#[derive(Default)]
struct Message {
    message: String,
    fields: String,
}

impl Visit for Message {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.message, "{value:?}");
        } else {
            let _ = write!(self.fields, " {}={value:?}", field.name());
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message.push_str(value);
        } else {
            let _ = write!(self.fields, " {}={value}", field.name());
        }
    }
}

impl Subscriber for Forwarder {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        *metadata.level() <= Level::DEBUG && metadata.target().starts_with("gondolin")
    }

    fn max_level_hint(&self) -> Option<tracing::level_filters::LevelFilter> {
        Some(tracing::level_filters::LevelFilter::DEBUG)
    }

    fn new_span(&self, _span: &Attributes<'_>) -> Id {
        Id::from_u64(1)
    }

    fn record(&self, _span: &Id, _values: &Record<'_>) {}

    fn record_follows_from(&self, _span: &Id, _follows: &Id) {}

    fn event(&self, event: &Event<'_>) {
        let mut msg = Message::default();
        event.record(&mut msg);
        let log = gondolin_proto::session::Log {
            component: "net".into(),
            message: format!("{}{}", msg.message, msg.fields),
        };
        self.ctl.send(gondolin_proto::session::LOG, 0, &log);
    }

    fn enter(&self, _span: &Id) {}

    fn exit(&self, _span: &Id) {}
}

/// Installs the forwarder as the process-wide subscriber (first call wins).
pub fn install(ctl: Arc<Controller>) {
    let _ = tracing::subscriber::set_global_default(Forwarder { ctl });
}
