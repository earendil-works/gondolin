//! `URL` components for the shim, from the parser egress uses
//! (`gondolin_http::url`), so a policy sees URLs exactly as egress does.

use gondolin_http::url::Url;

/// The WHATWG `URL` getters of `input` (resolved against `base`).
pub fn components(input: &str, base: Option<&str>) -> Result<[(&'static str, String); 11], String> {
    let invalid = |e: gondolin_http::url::ParseError| format!("Invalid URL: {input} ({e})");
    let url = match base {
        Some(b) => Url::parse(b).map_err(|e| format!("Invalid base URL: {b} ({e})"))?.join(input),
        None => Url::parse(input),
    }
    .map_err(invalid)?;
    let hostname = url.host_str().unwrap_or("").to_string();
    let port = url.port().map(|p| p.to_string()).unwrap_or_default();
    let host = if port.is_empty() { hostname.clone() } else { format!("{hostname}:{port}") };
    let scheme = url.scheme();
    let origin = match scheme {
        "http" | "https" | "ws" | "wss" | "ftp" => format!("{scheme}://{host}"),
        _ => "null".to_string(),
    };
    Ok([
        ("href", url.as_str().to_string()),
        ("origin", origin),
        ("protocol", format!("{scheme}:")),
        ("username", url.username().to_string()),
        ("password", url.password().unwrap_or("").to_string()),
        ("host", host),
        ("hostname", hostname),
        ("port", port),
        ("pathname", url.path().to_string()),
        (
            "search",
            url.query().filter(|q| !q.is_empty()).map(|q| format!("?{q}")).unwrap_or_default(),
        ),
        (
            "hash",
            url.fragment().filter(|f| !f.is_empty()).map(|f| format!("#{f}")).unwrap_or_default(),
        ),
    ])
}
