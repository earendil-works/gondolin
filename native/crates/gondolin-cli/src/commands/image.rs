//! `gondolin image` (local store and builtin registry via gondolin-assets;
//! `import` copies an asset directory into the store).

use std::io::{BufRead, IsTerminal, Write};

use gondolin_assets::{Arch, Assets, ImportMode};

use super::{render_error, usage};

pub async fn run(argv: Vec<String>) -> i32 {
    let Some(sub) = argv.first().cloned() else {
        println!("{}", usage::IMAGE);
        return 1;
    };
    if matches!(sub.as_str(), "--help" | "-h" | "help") {
        println!("{}", usage::IMAGE);
        return 0;
    }
    let rest = &argv[1..];
    if rest.iter().any(|a| a == "--help" || a == "-h") {
        println!("{}", usage::IMAGE);
        return 0;
    }
    match image(&sub, rest).await {
        Ok(()) => 0,
        Err(e) => {
            render_error(&e);
            1
        }
    }
}

fn parse_arch(value: Option<&String>) -> Result<Arch, String> {
    let value = value.ok_or("--arch requires a value")?;
    Arch::normalize(value)
        .ok_or_else(|| format!("--arch must be one of: aarch64, x86_64 (got {value})"))
}

/// Positional arguments plus an optional `--arch`.
fn selector_args(
    rest: &[String],
    what: &str,
    max: usize,
) -> Result<(Vec<String>, Option<Arch>), String> {
    let mut pos = Vec::new();
    let mut arch = None;
    let mut i = 0;
    while i < rest.len() {
        if rest[i] == "--arch" {
            arch = Some(parse_arch(rest.get(i + 1))?);
            i += 2;
            continue;
        }
        if pos.len() >= max {
            return Err(format!("unexpected argument for image {what}: {}", rest[i]));
        }
        pos.push(rest[i].clone());
        i += 1;
    }
    Ok((pos, arch))
}

fn progress(ev: gondolin_assets::ProgressEvent) {
    use gondolin_assets::ProgressEvent::*;
    match ev {
        DownloadStart { label, .. } => eprintln!("Downloading {label}..."),
        DownloadDone { label, .. } => eprintln!("Downloaded {label}"),
        _ => {}
    }
}

async fn confirm(question: &str, yes: bool) -> bool {
    if yes {
        return true;
    }
    if !std::io::stdin().is_terminal() {
        eprintln!("{question} Refusing without a TTY; pass --yes to confirm.");
        return false;
    }
    eprint!("{question} [y/N] ");
    let _ = std::io::stderr().flush();
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
    matches!(line.trim().to_lowercase().as_str(), "y" | "yes")
}

async fn image(sub: &str, rest: &[String]) -> Result<(), String> {
    let assets = Assets::from_env();
    let store = assets.store().clone();
    match sub {
        "ls" => {
            let refs = store.list_refs();
            let untagged = store.untagged();
            if refs.is_empty() && untagged.is_empty() {
                println!("No local images found.");
                return Ok(());
            }
            for r in refs {
                let mut targets = Vec::new();
                for arch in [Arch::Aarch64, Arch::X86_64] {
                    if let Some(id) = r.targets.get(&arch) {
                        targets.push(format!("{arch}={id}"));
                    }
                }
                if targets.is_empty() {
                    println!("{}", r.reference);
                } else {
                    println!("{}  {}", r.reference, targets.join(" "));
                }
            }
            for (id, arch) in untagged {
                let arch = arch.map(|a| a.to_string()).unwrap_or_else(|| "unknown".into());
                println!("<untagged>  {arch}={id}");
            }
            Ok(())
        }
        "import" => {
            let mut dir = None;
            let mut tag = None;
            let mut i = 0;
            while i < rest.len() {
                if rest[i] == "--tag" {
                    tag =
                        Some(rest.get(i + 1).cloned().ok_or("--tag requires an image reference")?);
                    i += 2;
                    continue;
                }
                if dir.is_some() {
                    return Err(format!("unexpected argument for image import: {}", rest[i]));
                }
                dir = Some(rest[i].clone());
                i += 1;
            }
            let dir = dir.ok_or("image import requires <ASSET_DIR>")?;
            let imported = store
                .import_dir(std::path::Path::new(&dir), ImportMode::Copy)
                .map_err(|e| e.to_string())?;
            println!("Imported buildId: {}", imported.build_id);
            println!("  arch: {}", imported.arch);
            println!("  object: {}", imported.asset_dir.display());
            println!("  status: {}", if imported.created { "created" } else { "already-present" });
            if let Some(tag) = tag {
                store
                    .set_ref(&tag, &imported.build_id, imported.arch)
                    .map_err(|e| e.to_string())?;
                println!("  tag: {tag}");
            }
            Ok(())
        }
        "tag" => {
            let (pos, arch) = selector_args(rest, "tag", 2)?;
            if pos.len() != 2 {
                return Err("image tag requires <SOURCE> and <TARGET>".into());
            }
            let resolved = assets.resolve_local(&pos[0], arch).map_err(|e| e.to_string())?;
            let build_id = resolved.build_id.clone().ok_or_else(|| {
                format!(
                    "image selector '{}' does not have a buildId (expected manifest buildId)",
                    pos[0]
                )
            })?;
            let arch = arch.or(resolved.arch).unwrap_or_else(Arch::host);
            store.set_ref(&pos[1], &build_id, arch).map_err(|e| e.to_string())?;
            let r = gondolin_assets::ImageRef::parse(&pos[1]).map_err(|e| e.to_string())?;
            let targets = store.ref_targets(&r).map_err(|e| e.to_string())?;
            println!("Updated {}", r.canonical());
            for a in [Arch::Aarch64, Arch::X86_64] {
                if let Some(id) = targets.get(&a) {
                    println!("  {a}: {id}");
                }
            }
            Ok(())
        }
        "rm" => {
            let (mut selector, mut force, mut yes, mut untagged, mut all) =
                (None, false, false, false, false);
            for arg in rest {
                match arg.as_str() {
                    "--force" | "-f" => force = true,
                    "--yes" | "-y" => yes = true,
                    "--untagged" => untagged = true,
                    "--all" => all = true,
                    other if selector.is_none() => selector = Some(other.to_string()),
                    other => return Err(format!("unexpected argument for image rm: {other}")),
                }
            }
            let modes = selector.is_some() as u8 + untagged as u8 + all as u8;
            if modes != 1 {
                return Err(
                    "image rm requires exactly one of <BUILD_ID|REF>, --untagged, or --all".into(),
                );
            }
            if force && selector.is_none() {
                return Err("--force requires a build id or image ref".into());
            }
            let description = if all {
                "all local images".to_string()
            } else if untagged {
                "all untagged local images".to_string()
            } else {
                format!("local image {}", selector.as_deref().unwrap_or(""))
            };
            if !confirm(&format!("Remove {description}?"), yes).await {
                return Ok(());
            }
            let (refs, ids) = if all {
                store.remove_all()
            } else if untagged {
                (Vec::new(), store.remove_untagged())
            } else {
                store
                    .remove_image(selector.as_deref().unwrap_or(""), force)
                    .map_err(|e| e.to_string())?
            };
            for (r, a) in refs {
                println!("Untagged: {r} ({a})");
            }
            for id in ids {
                println!("Deleted: {id}");
            }
            Ok(())
        }
        "inspect" | "pull" => {
            let (pos, arch) = selector_args(rest, sub, 1)?;
            let selector = pos.first().ok_or(format!("image {sub} requires <SELECTOR>"))?;
            let resolved =
                assets.resolve(selector, arch, Some(&progress)).await.map_err(|e| e.to_string())?;
            let source = resolved.source.as_str();
            if sub == "inspect" {
                println!("selector: {}", resolved.selector);
                println!("source: {source}");
                println!("assetDir: {}", resolved.asset_dir.display());
                if let Some(id) = &resolved.build_id {
                    println!("buildId: {id}");
                }
                if let Some(a) = resolved.arch {
                    println!("arch: {a}");
                }
                if resolved.manifest.is_some() {
                    println!("manifest: {}", resolved.asset_dir.join("manifest.json").display());
                }
            } else {
                println!("Pulled {}", resolved.selector);
                println!("  assetDir: {}", resolved.asset_dir.display());
                if let Some(id) = &resolved.build_id {
                    println!("  buildId: {id}");
                }
                if let Some(a) = resolved.arch {
                    println!("  arch: {a}");
                }
            }
            Ok(())
        }
        "build" => Err("image builds need the Node CLI: npx @earendil-works/gondolin build".into()),
        other => Err(format!("unknown image command: {other}")),
    }
}
