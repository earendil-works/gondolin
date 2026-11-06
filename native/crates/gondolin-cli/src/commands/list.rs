//! `gondolin list`

use super::{parse_failure, usage};
use crate::args::ParseError;
use crate::registry;

/// `formatAge`
fn format_age(created_at: &str) -> String {
    let Some(ts) = crate::checkpoint::parse_iso_millis(created_at) else { return "?".into() };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let s = (now - ts).max(0) / 1000;
    if s < 60 {
        return format!("{s}s");
    }
    let m = s / 60;
    if m < 60 {
        return format!("{m}m");
    }
    let h = m / 60;
    if h < 24 {
        return format!("{h}h");
    }
    format!("{}d", h / 24)
}

pub async fn run(argv: Vec<String>) -> i32 {
    let mut all = false;
    for arg in &argv {
        match arg.as_str() {
            "--all" => all = true,
            "--help" | "-h" => return parse_failure(ParseError::Help, usage::LIST),
            other => {
                return parse_failure(
                    ParseError::Usage(format!("Unknown argument: {other}")),
                    usage::LIST,
                );
            }
        }
    }
    registry::gc().await;
    let sessions = registry::list().await;
    let visible: Vec<_> = sessions.into_iter().filter(|s| all || s.alive).collect();
    if visible.is_empty() {
        println!("No running sessions.");
        return 0;
    }
    let rows: Vec<[String; 5]> = visible
        .iter()
        .map(|e| {
            [
                e.info.id.clone(),
                e.info.pid.to_string(),
                format_age(&e.info.created_at),
                if e.alive { "yes".into() } else { "no".into() },
                e.info.label.clone().unwrap_or_default(),
            ]
        })
        .collect();
    let width = |i: usize, title: &str| {
        rows.iter().map(|r| r[i].len()).chain(std::iter::once(title.len())).max().unwrap_or(0)
    };
    let w = [width(0, "ID"), width(1, "PID"), width(2, "AGE"), width(3, "ALIVE")];
    println!(
        "{:<a$}  {:<b$}  {:<c$}  {:<d$}  LABEL",
        "ID",
        "PID",
        "AGE",
        "ALIVE",
        a = w[0],
        b = w[1],
        c = w[2],
        d = w[3]
    );
    for r in rows {
        println!(
            "{:<a$}  {:<b$}  {:<c$}  {:<d$}  {}",
            r[0],
            r[1],
            r[2],
            r[3],
            r[4],
            a = w[0],
            b = w[1],
            c = w[2],
            d = w[3]
        );
    }
    0
}
