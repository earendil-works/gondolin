//! `gondolin bash`: an interactive shell (or `-- COMMAND`) in a new VM.

use std::io::Write;

use gondolind::util::{Either, select2};

use super::tty::{self, Input, RawMode};
use super::{host_env, parse_failure, render_error, usage};
use crate::args::parse_bash;
use crate::checkpoint;
use crate::configure::{self, ResumeDisk};
use crate::session::{Session, label};
use crate::vm::{ExecEvent, ExecRequest};

pub async fn run(argv: Vec<String>) -> i32 {
    let args = match parse_bash(&argv, &host_env) {
        Ok(a) => a,
        Err(e) => return parse_failure(e, &usage::bash()),
    };
    let resume = match args.resume.as_deref().map(load_resume).transpose() {
        Ok(r) => r,
        Err(e) => {
            render_error(&e);
            return 1;
        }
    };
    let prepared = configure::prepare(&args.common, resume.as_ref()).await;
    if args.common.print_configure {
        return super::exec::print_configure(prepared).await;
    }
    let prepared = match prepared {
        Ok(p) => p,
        Err(e) => {
            render_error(&e);
            return 1;
        }
    };
    let has_etc = prepared.etc_mount_id.is_some();
    let session = match Session::start(prepared, label()).await {
        Ok(s) => s,
        Err(e) => {
            render_error(&e);
            return 1;
        }
    };
    let mut _ssh = None;
    if args.ssh {
        let user = args.ssh_user.clone().unwrap_or_else(|| "root".into());
        let host = args.ssh_listen.clone().unwrap_or_else(|| "127.0.0.1".into());
        match crate::ssh::enable(&session.vm, &user, &host, args.ssh_port.unwrap_or(0)).await {
            Ok(access) => {
                eprintln!("SSH enabled: {}", access.command);
                _ssh = Some(access);
            }
            Err(e) => {
                render_error(&e);
                session.close().await;
                return 1;
            }
        }
    }
    let mut _ingress = None;
    if let Some((host, port)) = &args.listen {
        if !has_etc {
            render_error(
                "ingress requires the /etc/gondolin mount. Ensure VFS is enabled and that /etc/gondolin is not overridden by a custom mount.",
            );
            session.close().await;
            return 1;
        }
        let allow_ws = !args.common.disable_websockets;
        match crate::ingress::enable(
            session.vm.engine.clone(),
            session.vm.etc.clone(),
            host,
            *port,
            allow_ws,
        )
        .await
        {
            Ok(access) => {
                eprintln!("Ingress enabled: {}", access.url);
                eprintln!("Configure routes by editing /etc/gondolin/listeners inside the VM.");
                _ingress = Some(access);
            }
            Err(e) => {
                render_error(&e);
                session.close().await;
                return 1;
            }
        }
    }
    let command = args.command.clone().unwrap_or_else(tty::default_shell);
    let req = ExecRequest {
        cmd: command[0].clone(),
        argv: command[1..].to_vec(),
        // `vm.shell()` builds the env itself; `Vm::exec` merges it again (no-op)
        env: tty::shell_env(&[], &args.env),
        cwd: args.cwd.clone(),
        stdin: true,
        pty: true,
        window: 0,
    };
    let code = match session.run(interactive(&session, req)).await {
        Some(code) => code,
        None => {
            eprintln!("\n[gondolin] session snapshotted");
            0
        }
    };
    session.close().await;
    code
}

fn load_resume(resume: &str) -> Result<ResumeDisk, String> {
    let path = checkpoint::resolve_resume(resume)?;
    if path.is_dir() {
        return Err(format!(
            "checkpoint path must be a .qcow2 file, got directory: {}",
            path.display()
        ));
    }
    let data = checkpoint::read_trailer(&path)?;
    Ok(ResumeDisk { path, data })
}

async fn interactive(session: &Session, req: ExecRequest) -> i32 {
    let mut proc = session.vm.exec(req).await;
    let mut raw = RawMode::enable();
    if let Some((rows, cols)) = tty::window_size() {
        proc.resize(rows, cols).await;
    }
    let mut winch = crate::signals::subscribe(&[libc::SIGWINCH]);
    let mut input = tty::stdin_reader();
    let mut input_open = true;
    loop {
        let input_ready = input_open && !proc.stdin_full();
        let next = select2(
            proc.next(),
            select2(
                async {
                    if input_ready { input.recv().await } else { std::future::pending().await }
                },
                winch.recv(),
            ),
        )
        .await;
        match next {
            Either::Left(ev) => match ev {
                Some(ExecEvent::Output { stdout, data }) => {
                    let n = data.len() as u32;
                    if stdout {
                        let mut out = std::io::stdout().lock();
                        let _ = out.write_all(&data).and_then(|_| out.flush());
                        proc.grant(n, 0).await;
                    } else {
                        let mut err = std::io::stderr().lock();
                        let _ = err.write_all(&data).and_then(|_| err.flush());
                        proc.grant(0, n).await;
                    }
                }
                Some(ExecEvent::Exit { exit_code, signal }) => {
                    raw.restore();
                    if let Some(sig) = signal {
                        eprintln!("process exited due to signal {sig}");
                    }
                    break exit_code;
                }
                Some(ExecEvent::Error { message, .. }) => {
                    raw.restore();
                    if !session.is_snapshotting() {
                        render_error(&message);
                    }
                    break 1;
                }
                Some(ExecEvent::StdinAck(_)) => {}
                None => {
                    raw.restore();
                    if !session.is_snapshotting() {
                        render_error("sandbox connection closed");
                    }
                    break 1;
                }
            },
            Either::Right(Either::Left(item)) => match item {
                Some(Input::Data(data)) => {
                    proc.write(&data).await;
                }
                Some(Input::Escape) => {
                    raw.restore();
                    eprintln!("\n[gondolin] detached (Ctrl-])");
                    break 130;
                }
                Some(Input::Eof) | None => {
                    input_open = false;
                    proc.eof().await;
                }
            },
            Either::Right(Either::Right(_)) => {
                if let Some((rows, cols)) = tty::window_size() {
                    proc.resize(rows, cols).await;
                }
            }
        }
    }
}
