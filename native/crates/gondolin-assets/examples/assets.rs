//! Stand-alone `gondolind assets` for development:
//! `cargo run -p gondolin-assets --example assets -- resolve [SELECTOR]`

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(gondolin_assets::cli::run(&args).await);
}
