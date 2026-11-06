//! Runs one policy in a loop, for profilers: probe <policy> <calls> [fresh]
use djs_hooks_experiment::{DjsHooks, Limits, Mode};
use gondolin_egress::RequestHead;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let src = std::fs::read_to_string(&args[1]).unwrap();
    let n: usize = args[2].parse().unwrap();
    let mode = if args.get(3).is_some_and(|a| a == "fresh") { Mode::Fresh } else { Mode::Pooled };
    let body = args.get(4).is_some_and(|a| a == "body");
    let hooks = DjsHooks::new(&src, mode, Limits::default(), body).unwrap();
    let head = RequestHead {
        method: "GET".into(),
        url: "https://api.github.com/repos/earendil-works/gondolin/pulls?state=open".into(),
        headers: vec![
            ("host".into(), "api.github.com".into()),
            ("user-agent".into(), "curl/8.7.1".into()),
            ("accept".into(), "application/vnd.github+json".into()),
            ("authorization".into(), "Bearer GONDOLIN_SECRET_GH_TOKEN".into()),
            ("x-debug-token".into(), "abc".into()),
        ],
    };
    let t = std::time::Instant::now();
    let data = bytes::Bytes::from(vec![b'x'; 64 * 1024]);
    for _ in 0..n {
        if body {
            let pb = gondolin_egress::PullableBody::new(
                gondolin_egress::full_body(data.clone()),
                1 << 20,
                gondolin_egress::Blocked::forbidden("too large"),
            );
            hooks.run_on_request(&head, Some(&pb.handle())).await.unwrap();
        } else {
            hooks.run_on_request(&head, None).await.unwrap();
        }
    }
    println!("{:?}/call", t.elapsed() / n as u32);
}
