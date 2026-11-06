//! Best-effort parser for git-over-SSH exec commands (port of
//! `getInfoFromSshExecRequest` in `host/src/ssh/exec.ts`).
//!
//! Only canonical invocations such as `git-upload-pack 'org/repo.git'` are
//! understood; anything else (extra arguments, shell metacharacters,
//! suspicious paths) yields `None`, failing closed.

/// Git service and repository of an exec command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitExecInfo {
    /// e.g. `git-upload-pack`
    pub service: String,
    /// e.g. `org/repo.git`
    pub repo: String,
}

fn split_command(command: &str) -> Option<Vec<String>> {
    let chars: Vec<char> = command.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }
        let mut cur = String::new();
        #[derive(PartialEq)]
        enum Mode {
            None,
            Single,
            Double,
        }
        let mut mode = Mode::None;
        while i < chars.len() {
            let ch = chars[i];
            match mode {
                Mode::None => {
                    if ch.is_whitespace() {
                        break;
                    }
                    match ch {
                        '\'' => mode = Mode::Single,
                        '"' => mode = Mode::Double,
                        '\\' => {
                            i += 1;
                            cur.push(*chars.get(i)?);
                        }
                        _ => cur.push(ch),
                    }
                }
                Mode::Single => {
                    if ch == '\'' {
                        mode = Mode::None;
                    } else {
                        cur.push(ch);
                    }
                }
                Mode::Double => match ch {
                    '"' => mode = Mode::None,
                    '\\' => {
                        i += 1;
                        cur.push(*chars.get(i)?);
                    }
                    _ => cur.push(ch),
                },
            }
            i += 1;
        }
        if mode != Mode::None {
            return None;
        }
        out.push(cur);
    }
    Some(out)
}

fn is_service_name(s: &str) -> bool {
    // git-[a-z0-9][a-z0-9-]*
    let Some(rest) = s.get(..4).filter(|p| p.eq_ignore_ascii_case("git-")).map(|_| &s[4..]) else {
        return false;
    };
    let mut chars = rest.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn is_service_arg(s: &str) -> bool {
    let s = s.strip_prefix('/').unwrap_or(s);
    let mut segments: Vec<&str> = s.split('/').collect();
    let Some(last) = segments.pop() else {
        return false;
    };
    segments.iter().all(|seg| {
        !seg.is_empty() && seg.chars().all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c))
    }) && is_service_name(last)
}

fn is_repo_path(repo: &str) -> bool {
    let segments: Vec<&str> = repo.split('/').collect();
    segments.len() >= 2
        && segments.iter().all(|seg| {
            let mut chars = seg.chars();
            matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
                && chars.all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        })
}

/// Parses a git smart-protocol exec command.
pub fn git_exec_info(command: &str) -> Option<GitExecInfo> {
    let argv = split_command(command)?;
    if argv.len() != 2 {
        return None;
    }
    let service_arg = argv[0].trim();
    if !is_service_arg(service_arg) {
        return None;
    }
    let service = service_arg.rsplit('/').next().unwrap_or(service_arg);
    if !is_service_name(service) {
        return None;
    }
    let mut repo = argv[1].trim();
    if repo.is_empty() {
        return None;
    }
    if let Some(r) = repo.strip_prefix("~/") {
        repo = r;
    }
    let repo = repo.trim_start_matches('/').trim_end_matches('/');
    if !repo.contains('/') || repo.contains("..") || repo.starts_with('-') || !is_repo_path(repo) {
        return None;
    }
    Some(GitExecInfo { service: service.to_string(), repo: repo.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(service: &str, repo: &str) -> Option<GitExecInfo> {
        Some(GitExecInfo { service: service.into(), repo: repo.into() })
    }

    #[test]
    fn parses_git_commands() {
        assert_eq!(
            git_exec_info("git-upload-pack 'my-org/my-repo.git'"),
            info("git-upload-pack", "my-org/my-repo.git")
        );
        assert_eq!(
            git_exec_info("git-receive-pack '/my-org/my-repo.git/'"),
            info("git-receive-pack", "my-org/my-repo.git")
        );
        assert_eq!(
            git_exec_info("/usr/lib/git-core/git-upload-pack \"~/org/repo\""),
            info("git-upload-pack", "org/repo")
        );
        assert_eq!(git_exec_info("git-upload-pack org/repo"), info("git-upload-pack", "org/repo"));
    }

    #[test]
    fn rejects_everything_else() {
        assert_eq!(git_exec_info("echo hello"), None);
        assert_eq!(git_exec_info("git-upload-pack 'my-org/my-repo.git' && echo pwned"), None);
        assert_eq!(git_exec_info("git-upload-pack \"$(echo my-org/my-repo.git)\""), None);
        assert_eq!(
            git_exec_info("/usr/lib/git-core/$(id)/git-upload-pack 'my-org/my-repo.git'"),
            None
        );
        assert_eq!(git_exec_info("git-upload-pack 'repo.git'"), None);
        assert_eq!(git_exec_info("git-upload-pack 'org/../etc'"), None);
        assert_eq!(git_exec_info("git-upload-pack '-org/repo'"), None);
        assert_eq!(git_exec_info("git-upload-pack 'org/repo"), None);
        assert_eq!(git_exec_info("git-upload-pack org/repo\\"), None);
        assert_eq!(git_exec_info("git- org/repo"), None);
        assert_eq!(git_exec_info("//git-upload-pack org/repo"), None);
    }
}
