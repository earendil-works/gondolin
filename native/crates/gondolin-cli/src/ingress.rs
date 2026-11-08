//! `gondolin bash --listen` (`vm.enableIngress()`): an HTTP gateway on the
//! host routing requests by path prefix into guest services, configured by
//! the guest's `/etc/gondolin/listeners` (`host/src/ingress.ts`). Requests go
//! through the guest's `virtio-ingress` forwarder (`fwd_*`, channel
//! `ingress`), one upstream connection per request (`connection: close`);
//! WebSocket upgrades are tunneled.

use std::net::SocketAddr;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use gondolin_http::client::Connection;
use gondolin_http::head::canonical_reason;
use gondolin_http::server::{Request, Response, ServerConfig};
use gondolin_http::{BoxBody, HeadLimits, Header, ParseError};
use tokio::net::TcpListener;

use crate::engine::Engine;
use crate::etc_mount::EtcStore;

/// One `/etc/gondolin/listeners` route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    pub prefix: String,
    pub port: u16,
    pub strip_prefix: bool,
}

/// `normalizePrefix`
fn normalize_prefix(p: &str) -> String {
    let mut p = if p.starts_with('/') { p.to_string() } else { format!("/{p}") };
    if p.len() > 1 && p.ends_with('/') {
        p.pop();
    }
    p
}

/// `parseListenersFile`
pub fn parse_listeners(text: &str) -> Result<Vec<Route>, String> {
    let text = text.replace('\0', "");
    let mut routes = Vec::new();
    for (i, line) in text.split('\n').enumerate() {
        let n = i + 1;
        let line = line.strip_suffix('\r').unwrap_or(line);
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 2 {
            return Err(format!("invalid listeners file line {n}: expected '<prefix> <backend>'"));
        }
        if !parts[0].starts_with('/') {
            return Err(format!("invalid listeners file line {n}: prefix must start with '/'"));
        }
        let Some(port_text) = parts[1].strip_prefix(':') else {
            return Err(format!("invalid listeners file line {n}: backend must be ':<port>'"));
        };
        let port: u16 = port_text
            .parse()
            .ok()
            .filter(|p| *p > 0 && port_text.bytes().all(|b| b.is_ascii_digit()))
            .ok_or_else(|| format!("invalid listeners file line {n}: invalid port"))?;
        let mut strip_prefix = true;
        for opt in &parts[2..] {
            let Some((key, value)) = opt.split_once('=') else {
                return Err(format!("invalid listeners file line {n}: invalid option '{opt}'"));
            };
            if key == "strip_prefix" {
                strip_prefix = match value {
                    "true" => true,
                    "false" => false,
                    _ => {
                        return Err(format!(
                            "invalid listeners file line {n}: strip_prefix must be true|false"
                        ));
                    }
                };
            }
        }
        routes.push(Route { prefix: normalize_prefix(parts[0]), port, strip_prefix });
    }
    Ok(routes)
}

/// `serializeListenersFile`
pub fn serialize_listeners(routes: &[Route]) -> String {
    let lines: Vec<String> = routes
        .iter()
        .map(|r| {
            let mut line = format!("{}\t:{}", r.prefix, r.port);
            if !r.strip_prefix {
                line.push_str("\tstrip_prefix=false");
            }
            line
        })
        .collect();
    format!("{}\n", lines.join("\n"))
}

fn matches_prefix(path: &str, prefix: &str) -> bool {
    prefix == "/" || path == prefix || path.starts_with(&format!("{prefix}/"))
}

/// `stripPrefix`
fn strip_prefix(path: &str, prefix: &str) -> String {
    if prefix == "/" {
        return path.to_string();
    }
    if path == prefix {
        return "/".into();
    }
    match path.strip_prefix(prefix) {
        Some(rest) if rest.starts_with('/') => rest.to_string(),
        _ => path.to_string(),
    }
}

/// Longest matching prefix (`pickRoute`).
fn pick_route(routes: &[Route], path: &str) -> Option<Route> {
    routes
        .iter()
        .filter(|r| matches_prefix(path, &r.prefix))
        .max_by_key(|r| r.prefix.len())
        .cloned()
}

const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
];

/// Server limits (hyper's defaults)
const LIMITS: HeadLimits = HeadLimits { max_bytes: 8192 + 4096 * 100, max_headers: 100 };

fn get<'a>(headers: &'a [Header], name: &str) -> Option<&'a str> {
    gondolin_http::header(headers, name).and_then(|v| std::str::from_utf8(v).ok())
}

/// Replaces all `name` headers with one.
fn set(headers: &mut Vec<Header>, name: &str, value: &str) {
    headers.retain(|h| h.name != name);
    headers.push(Header::new(name, value));
}

fn connection_tokens(headers: &[Header]) -> Vec<String> {
    headers
        .iter()
        .filter(|h| h.name == "connection")
        .filter_map(|h| std::str::from_utf8(&h.value).ok())
        .flat_map(|v| v.split(','))
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty())
        .collect()
}

/// `stripHopByHopHeaders` / `stripHopByHopHeadersForWebSocket`
fn filter_headers(headers: &[Header], websocket: bool) -> Vec<Header> {
    let tokens = connection_tokens(headers);
    let mut out = Vec::with_capacity(headers.len());
    for h in headers {
        let n = h.name.as_str();
        let drop = if websocket {
            matches!(
                n,
                "keep-alive"
                    | "proxy-connection"
                    | "proxy-authenticate"
                    | "proxy-authorization"
                    | "content-length"
                    | "transfer-encoding"
                    | "expect"
                    | "te"
                    | "trailer"
            ) || (tokens.iter().any(|t| t == n) && n != "upgrade")
        } else {
            HOP_BY_HOP.contains(&n) || tokens.iter().any(|t| t == n)
        };
        if !drop {
            out.push(h.clone());
        }
    }
    out
}

fn is_upgrade(headers: &[Header]) -> bool {
    headers.iter().any(|h| h.name == "upgrade")
        && connection_tokens(headers).iter().any(|t| t == "upgrade")
}

fn text(status: u16, body: &str) -> Response {
    Response::new(
        status,
        vec![Header::new("content-type", "text/plain")],
        BoxBody::full(body.to_string()),
    )
}

/// Path and `?query` of a request-target (origin or absolute form; no fragment).
fn split_target(target: &str) -> (String, String) {
    let target = target.split('#').next().unwrap_or_default();
    let rest = match target.find("://") {
        Some(i) => {
            let after = &target[i + 3..];
            after.find(['/', '?']).map_or("", |j| &after[j..])
        }
        None => target,
    };
    let (path, query) = rest.split_at(rest.find('?').unwrap_or(rest.len()));
    let path = if path.is_empty() { "/" } else { path };
    (path.to_string(), query.to_string())
}

/// A listening gateway.
pub struct Ingress {
    pub url: String,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for Ingress {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

struct Gateway {
    engine: Arc<Engine>,
    routes: RwLock<Vec<Route>>,
    allow_websockets: bool,
}

/// Starts the gateway on `host:port` (`IngressGateway.listen`).
pub async fn enable(
    engine: Arc<Engine>,
    etc: Arc<EtcStore>,
    host: &str,
    port: u16,
    allow_websockets: bool,
) -> Result<Ingress, String> {
    let routes =
        parse_listeners(&String::from_utf8_lossy(&etc.read("/listeners").unwrap_or_default()))
            .unwrap_or_default();
    let gw = Arc::new(Gateway { engine, routes: RwLock::new(routes), allow_websockets });
    // reload on change (25 ms debounce), keeping the last good routes
    let reload = {
        let gw = gw.clone();
        let mut changed = etc.listeners_changed();
        tokio::spawn(async move {
            while changed.changed().await.is_ok() {
                tokio::time::sleep(Duration::from_millis(25)).await;
                changed.borrow_and_update();
                let text = match etc.read("/listeners") {
                    Some(bytes)
                        if bytes.len() as u64 > crate::configure::MAX_LISTENERS_FILE_BYTES =>
                    {
                        continue;
                    }
                    Some(bytes) => String::from_utf8_lossy(&bytes).to_string(),
                    None => String::new(),
                };
                if let Ok(routes) = parse_listeners(&text) {
                    let canonical = serialize_listeners(&routes);
                    if canonical != text && etc.read("/listeners").is_some() {
                        etc.write("/listeners", canonical.into_bytes());
                    }
                    *gw.routes.write().unwrap() = routes;
                }
            }
        })
    };
    let listener = TcpListener::bind((host, port))
        .await
        .map_err(|e| format!("cannot listen on {host}:{port}: {e}"))?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let accept = tokio::spawn(async move {
        while let Ok((socket, peer)) = listener.accept().await {
            let _ = socket.set_nodelay(true);
            let gw = gw.clone();
            tokio::spawn(gondolin_http::server::serve(
                socket,
                ServerConfig { keep_alive: true, limits: LIMITS },
                move |req| {
                    let gw = gw.clone();
                    async move { gw.handle(req, peer).await }
                },
                |err: &ParseError| {
                    let status = if matches!(err, ParseError::TooLarge | ParseError::TooManyHeaders)
                    {
                        431
                    } else {
                        400
                    };
                    Response::new(status, vec![], BoxBody::empty())
                },
            ));
        }
    });
    let shown = if addr.is_ipv6() { format!("[{}]", addr.ip()) } else { addr.ip().to_string() };
    Ok(Ingress { url: format!("http://{shown}:{}", addr.port()), tasks: vec![reload, accept] })
}

impl Gateway {
    async fn handle(&self, req: Request, peer: SocketAddr) -> Response {
        let upgrade = is_upgrade(&req.head.headers);
        if upgrade && !self.allow_websockets {
            return text(501, "websocket upgrades disabled\n");
        }
        if !upgrade && req.head.headers.iter().any(|h| h.name == "upgrade") {
            let mut res = text(426, "use websocket upgrade\n");
            res.headers.push(Header::new("upgrade", "websocket"));
            return res;
        }
        let (path, query) = split_target(&req.head.target);
        let Some(route) = pick_route(&self.routes.read().unwrap(), &path) else {
            return text(404, "no route\n");
        };
        let backend_path =
            if route.strip_prefix { strip_prefix(&path, &route.prefix) } else { path.clone() };
        let host_header = get(&req.head.headers, "host").unwrap_or("localhost").to_string();
        let mut headers = filter_headers(&req.head.headers, upgrade);
        if !upgrade {
            headers.retain(|h| h.name != "content-length" && h.name != "expect");
        }
        let host_value = if gondolin_http::head::valid_value(host_header.as_bytes()) {
            &host_header
        } else {
            "localhost"
        };
        set(&mut headers, "host", host_value);
        if !upgrade {
            set(&mut headers, "connection", "close");
        }
        let client_ip = peer.ip().to_string();
        let xff = match get(&headers, "x-forwarded-for") {
            Some(prev) if !prev.is_empty() => format!("{prev}, {client_ip}"),
            _ => client_ip,
        };
        set(&mut headers, "x-forwarded-for", &xff);
        set(&mut headers, "x-forwarded-host", &host_header);
        set(&mut headers, "x-forwarded-proto", "http");
        if route.strip_prefix && route.prefix != "/" {
            set(&mut headers, "x-forwarded-prefix", &route.prefix);
        }
        match self
            .forward(req, route.port, format!("{backend_path}{query}"), headers, upgrade)
            .await
        {
            Ok(res) => res,
            Err(_) => text(502, "bad gateway\n"),
        }
    }

    async fn forward(
        &self,
        req: Request,
        port: u16,
        target: String,
        headers: Vec<Header>,
        upgrade: bool,
    ) -> Result<Response, String> {
        let stream =
            crate::fwd::open(&self.engine, "ingress", "127.0.0.1", port, Duration::from_secs(10))
                .await?;
        let Request { head, body, upgrade: client_upgrade, .. } = req;
        let body = if upgrade { BoxBody::empty() } else { body.boxed() };
        let res = gondolin_http::client::send(
            Connection::new(stream),
            &head.method,
            &target,
            &headers,
            body,
            &LIMITS,
            None,
        )
        .await
        .map_err(|e| e.to_string())?;
        let reason = (canonical_reason(res.head.status).map(str::as_bytes)
            != Some(res.head.reason.as_slice()))
        .then(|| res.head.reason.clone());
        if upgrade && res.head.status == 101 {
            if let (Some(client), Some(mut server)) = (client_upgrade, res.upgraded) {
                tokio::spawn(async move {
                    let Ok(mut client) = client.await else {
                        return;
                    };
                    let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
                });
            }
            return Ok(Response {
                status: 101,
                reason,
                headers: res.head.headers,
                body: BoxBody::empty(),
            });
        }
        Ok(Response {
            status: res.head.status,
            reason,
            headers: filter_headers(&res.head.headers, false),
            body: res.body.boxed(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listeners_file() {
        let routes =
            parse_listeners("# comment\n/api/ :8080\n/  :3000 strip_prefix=false\n").unwrap();
        assert_eq!(
            routes,
            vec![
                Route { prefix: "/api".into(), port: 8080, strip_prefix: true },
                Route { prefix: "/".into(), port: 3000, strip_prefix: false },
            ]
        );
        assert_eq!(serialize_listeners(&routes), "/api\t:8080\n/\t:3000\tstrip_prefix=false\n");
        assert_eq!(serialize_listeners(&[]), "\n");
        assert!(parse_listeners("/ 80").unwrap_err().contains("backend must be"));
        assert!(parse_listeners("/ :0").unwrap_err().contains("invalid port"));
        assert_eq!(pick_route(&routes, "/api/x").unwrap().port, 8080);
        assert_eq!(pick_route(&routes, "/apix").unwrap().port, 3000);
        assert_eq!(strip_prefix("/api/x", "/api"), "/x");
        assert_eq!(strip_prefix("/api", "/api"), "/");
    }

    #[test]
    fn hop_by_hop() {
        let h = vec![
            Header::new("connection", "upgrade, x-drop"),
            Header::new("upgrade", "websocket"),
            Header::new("x-drop", "1"),
            Header::new("x-keep", "1"),
        ];
        assert!(is_upgrade(&h));
        let plain = filter_headers(&h, false);
        assert!(get(&plain, "upgrade").is_none() && get(&plain, "x-drop").is_none());
        let ws = filter_headers(&h, true);
        assert!(
            get(&ws, "upgrade").is_some()
                && get(&ws, "x-keep").is_some()
                && get(&ws, "x-drop").is_none()
        );
    }

    #[test]
    fn targets() {
        assert_eq!(split_target("/a/b?x=1"), ("/a/b".into(), "?x=1".into()));
        assert_eq!(split_target("http://h:1"), ("/".into(), "".into()));
        assert_eq!(split_target("http://h/p?q#f"), ("/p".into(), "?q".into()));
        assert_eq!(split_target("/p#f"), ("/p".into(), "".into()));
    }
}
