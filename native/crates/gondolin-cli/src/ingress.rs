//! `gondolin bash --listen` (`vm.enableIngress()`): an HTTP gateway on the
//! host routing requests by path prefix into guest services, configured by
//! the guest's `/etc/gondolin/listeners` (`host/src/ingress.ts`). Requests go
//! through the guest's `virtio-ingress` forwarder (`fwd_*`, channel
//! `ingress`), one upstream connection per request (`connection: close`);
//! WebSocket upgrades are tunneled.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use http_body_util::{BodyExt, Full, combinators::BoxBody};
use hyper::body::{Bytes, Incoming};
use hyper::header::{HeaderMap, HeaderName, HeaderValue};
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
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

fn connection_tokens(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all(hyper::header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty())
        .collect()
}

/// `stripHopByHopHeaders` / `stripHopByHopHeadersForWebSocket`
fn filter_headers(headers: &HeaderMap, websocket: bool) -> HeaderMap {
    let tokens = connection_tokens(headers);
    let mut out = HeaderMap::new();
    for (name, value) in headers {
        let n = name.as_str();
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
            out.append(name.clone(), value.clone());
        }
    }
    out
}

fn is_upgrade(headers: &HeaderMap) -> bool {
    headers.contains_key(hyper::header::UPGRADE)
        && connection_tokens(headers).iter().any(|t| t == "upgrade")
}

type Body = BoxBody<Bytes, hyper::Error>;

fn text(status: StatusCode, body: &str) -> Response<Body> {
    let mut res =
        Response::new(Full::new(Bytes::from(body.to_string())).map_err(|e| match e {}).boxed());
    *res.status_mut() = status;
    res.headers_mut().insert(hyper::header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
    res
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
            tokio::spawn(async move {
                let service = hyper::service::service_fn(move |req| {
                    let gw = gw.clone();
                    async move { Ok::<_, Infallible>(gw.handle(req, peer).await) }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(socket), service)
                    .with_upgrades()
                    .await;
            });
        }
    });
    let shown = if addr.is_ipv6() { format!("[{}]", addr.ip()) } else { addr.ip().to_string() };
    Ok(Ingress { url: format!("http://{shown}:{}", addr.port()), tasks: vec![reload, accept] })
}

impl Gateway {
    async fn handle(&self, req: Request<Incoming>, peer: SocketAddr) -> Response<Body> {
        let upgrade = is_upgrade(req.headers());
        if upgrade && !self.allow_websockets {
            return text(StatusCode::NOT_IMPLEMENTED, "websocket upgrades disabled\n");
        }
        if !upgrade && req.headers().contains_key(hyper::header::UPGRADE) {
            let mut res = text(StatusCode::UPGRADE_REQUIRED, "use websocket upgrade\n");
            res.headers_mut().insert(hyper::header::UPGRADE, HeaderValue::from_static("websocket"));
            return res;
        }
        let path = req.uri().path().to_string();
        let query = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
        let Some(route) = pick_route(&self.routes.read().unwrap(), &path) else {
            return text(StatusCode::NOT_FOUND, "no route\n");
        };
        let backend_path =
            if route.strip_prefix { strip_prefix(&path, &route.prefix) } else { path.clone() };
        let host_header = req
            .headers()
            .get(hyper::header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("localhost")
            .to_string();
        let mut headers = filter_headers(req.headers(), upgrade);
        if !upgrade {
            for h in ["content-length", "expect"] {
                headers.remove(h);
            }
        }
        headers.insert(
            hyper::header::HOST,
            HeaderValue::from_str(&host_header).unwrap_or(HeaderValue::from_static("localhost")),
        );
        if !upgrade {
            headers.insert(hyper::header::CONNECTION, HeaderValue::from_static("close"));
        }
        let client_ip = peer.ip().to_string();
        let xff = match headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
            Some(prev) if !prev.is_empty() => format!("{prev}, {client_ip}"),
            _ => client_ip,
        };
        let set = |headers: &mut HeaderMap, name: &'static str, value: &str| {
            if let Ok(v) = HeaderValue::from_str(value) {
                headers.insert(HeaderName::from_static(name), v);
            }
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
            Err(_) => text(StatusCode::BAD_GATEWAY, "bad gateway\n"),
        }
    }

    async fn forward(
        &self,
        mut req: Request<Incoming>,
        port: u16,
        target: String,
        headers: HeaderMap,
        upgrade: bool,
    ) -> Result<Response<Body>, String> {
        let stream =
            crate::fwd::open(&self.engine, "ingress", "127.0.0.1", port, Duration::from_secs(10))
                .await?;
        let (mut sender, conn) =
            hyper::client::conn::http1::handshake::<_, Body>(TokioIo::new(stream))
                .await
                .map_err(|e| e.to_string())?;
        tokio::spawn(async move {
            let _ = conn.with_upgrades().await;
        });
        let client_upgrade = upgrade.then(|| hyper::upgrade::on(&mut req));
        let (parts, body) = req.into_parts();
        let mut upstream = Request::builder().method(parts.method).uri(target);
        if let Some(h) = upstream.headers_mut() {
            *h = headers;
        }
        let body: Body = if upgrade {
            Full::new(Bytes::new()).map_err(|e| match e {}).boxed()
        } else {
            body.boxed()
        };
        let upstream = upstream.body(body).map_err(|e| e.to_string())?;
        let mut res = sender.send_request(upstream).await.map_err(|e| e.to_string())?;
        if upgrade && res.status() == StatusCode::SWITCHING_PROTOCOLS {
            let upstream_upgrade = hyper::upgrade::on(&mut res);
            let (parts, _) = res.into_parts();
            tokio::spawn(async move {
                let (Ok(client), Ok(server)) =
                    (client_upgrade.unwrap().await, upstream_upgrade.await)
                else {
                    return;
                };
                let _ = tokio::io::copy_bidirectional(
                    &mut TokioIo::new(client),
                    &mut TokioIo::new(server),
                )
                .await;
            });
            return Ok(Response::from_parts(
                parts,
                Full::new(Bytes::new()).map_err(|e| match e {}).boxed(),
            ));
        }
        let (mut parts, body) = res.into_parts();
        parts.headers = filter_headers(&parts.headers, false);
        Ok(Response::from_parts(parts, body.boxed()))
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
        let mut h = HeaderMap::new();
        h.insert("connection", HeaderValue::from_static("upgrade, x-drop"));
        h.insert("upgrade", HeaderValue::from_static("websocket"));
        h.insert("x-drop", HeaderValue::from_static("1"));
        h.insert("x-keep", HeaderValue::from_static("1"));
        assert!(is_upgrade(&h));
        let plain = filter_headers(&h, false);
        assert!(plain.get("upgrade").is_none() && plain.get("x-drop").is_none());
        let ws = filter_headers(&h, true);
        assert!(
            ws.get("upgrade").is_some() && ws.get("x-keep").is_some() && ws.get("x-drop").is_none()
        );
    }
}
