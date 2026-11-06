# Guest-side HTTP(S) client for the network benchmarks; prints JSON.
# usage: netclient.py '<json config>'
#   config: scheme, host, port, ip, mode (seq|keepalive|concurrent|download|upload),
#           count, concurrency, bytes, path
# Connections go to `ip` (any address routed to the host) while Host/SNI carry
# `host`, which the host side resolves and checks against its policy.
import http.client
import json
import socket
import ssl
import sys
import threading
import time

cfg = json.loads(sys.argv[1])
HOST, PORT, IP = cfg["host"], cfg["port"], cfg["ip"]
CTX = ssl.create_default_context()


class Http(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.create_connection((IP, self.port), self.timeout)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)


class Https(http.client.HTTPSConnection):
    def connect(self):
        sock = socket.create_connection((IP, self.port), self.timeout)
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.sock = CTX.wrap_socket(sock, server_hostname=self.host)


def conn():
    cls = Https if cfg["scheme"] == "https" else Http
    return cls(HOST, PORT, timeout=120)


def get(c, path):
    c.request("GET", path)
    r = c.getresponse()
    n = 0
    while True:
        chunk = r.read(1 << 20)
        if not chunk:
            break
        n += len(chunk)
    if r.status != 200:
        raise SystemExit(f"GET {path}: HTTP {r.status}")
    return n


def one_request(path):
    c = conn()
    t0 = time.perf_counter_ns()
    get(c, path)
    dt = time.perf_counter_ns() - t0
    c.close()
    return dt / 1e6


mode = cfg["mode"]
out = {}
if mode == "seq":
    out["ms"] = [one_request(cfg["path"]) for _ in range(cfg["count"])]
elif mode == "keepalive":
    c = conn()
    get(c, cfg["path"])
    samples = []
    for _ in range(cfg["count"]):
        t0 = time.perf_counter_ns()
        get(c, cfg["path"])
        samples.append((time.perf_counter_ns() - t0) / 1e6)
    out["ms"] = samples
elif mode == "concurrent":
    per = cfg["count"] // cfg["concurrency"]
    lat = []
    errors = []

    def worker():
        try:
            for _ in range(per):
                lat.append(one_request(cfg["path"]))
        except BaseException as e:  # noqa: BLE001
            errors.append(repr(e))

    threads = [threading.Thread(target=worker) for _ in range(cfg["concurrency"])]
    t0 = time.perf_counter_ns()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    out["wallMs"] = (time.perf_counter_ns() - t0) / 1e6
    out["ms"] = lat
    if errors:
        raise SystemExit("; ".join(errors[:3]))
    out["requests"] = len(lat)
elif mode == "download":
    c = conn()
    t0 = time.perf_counter_ns()
    n = get(c, f"/bytes/{cfg['bytes']}")
    out["wallMs"] = (time.perf_counter_ns() - t0) / 1e6
    if n != cfg["bytes"]:
        raise SystemExit(f"download got {n} bytes, expected {cfg['bytes']}")
elif mode == "upload":
    total = cfg["bytes"]
    block = b"u" * (1 << 20)

    def body():
        sent = 0
        while sent < total:
            chunk = block[: min(len(block), total - sent)]
            sent += len(chunk)
            yield chunk

    c = conn()
    t0 = time.perf_counter_ns()
    c.request("POST", "/upload", body=body(), headers={"Content-Length": str(total)})
    r = c.getresponse()
    got = r.read().decode()
    out["wallMs"] = (time.perf_counter_ns() - t0) / 1e6
    if r.status != 200 or int(got) != total:
        raise SystemExit(f"upload: HTTP {r.status}, server saw {got}")
else:
    raise SystemExit(f"unknown mode {mode}")
print(json.dumps(out))
