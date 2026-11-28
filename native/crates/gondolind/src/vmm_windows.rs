//! Windows VMM lifetime: an unnamed, non-inherited kill-on-close Job Object
//! contains QEMU and its children. Closing the daemon (even forcibly) closes
//! the job handle, so a guest cannot outlive its host controller.
use std::io::{self, Read};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::mpsc;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};

static CURRENT_JOB: Mutex<Option<Weak<OwnedHandle>>> = Mutex::new(None);

fn terminate(job: &OwnedHandle) {
    // SAFETY: the owned handle is a live job created by this module.
    unsafe {
        TerminateJobObject(job.as_raw_handle(), 1);
    }
}

pub fn kill_current() {
    if let Ok(current) = CURRENT_JOB.lock()
        && let Some(job) = current.as_ref().and_then(Weak::upgrade)
    {
        terminate(&job);
    }
}

#[derive(Debug)]
pub enum VmmEvent {
    Log { stderr: bool, chunk: Vec<u8> },
    Exited { code: Option<i32>, signal: Option<i32> },
}

pub struct VmmProcess {
    pub pid: u32,
    job: Arc<OwnedHandle>,
}

#[derive(Debug, Default)]
pub struct SpawnExtra {
    /// Linux network namespace descriptor; rejected on Windows
    pub netns: Option<i32>,
    pub binds: Vec<crate::jailer::Bind>,
    pub watchdog: bool,
}

fn create_job() -> io::Result<OwnedHandle> {
    // SAFETY: null attributes/name create a private, non-inheritable job.
    let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: ownership of the newly created job is transferred exactly once.
    let job = unsafe { OwnedHandle::from_raw_handle(handle) };
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: a live job and the documented structure/size for this class.
    if unsafe {
        SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&info) as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(job)
}

impl VmmProcess {
    pub fn spawn(
        program: &str,
        args: &[String],
        generation: u64,
        events: mpsc::Sender<(u64, VmmEvent)>,
    ) -> io::Result<Self> {
        Self::spawn_with(program, args, generation, events, &SpawnExtra::default())
    }

    pub fn spawn_in(
        program: &str,
        args: &[String],
        generation: u64,
        events: mpsc::Sender<(u64, VmmEvent)>,
        netns: Option<i32>,
    ) -> io::Result<Self> {
        Self::spawn_with(
            program,
            args,
            generation,
            events,
            &SpawnExtra { netns, ..Default::default() },
        )
    }

    pub fn spawn_with(
        program: &str,
        args: &[String],
        generation: u64,
        events: mpsc::Sender<(u64, VmmEvent)>,
        extra: &SpawnExtra,
    ) -> io::Result<Self> {
        if extra.netns.is_some() || !extra.binds.is_empty() {
            return Err(io::Error::new(io::ErrorKind::Unsupported, "namespaces are Linux-only"));
        }
        let job = Arc::new(create_job()?);
        let mut child = Command::new(program)
            .args(args)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let pid = child.id();
        // SAFETY: both handles are owned and live. Fail closed if the runner's
        // job configuration does not permit nesting; never run an unguarded VM.
        if unsafe { AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) } == 0 {
            let error = io::Error::last_os_error();
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        *CURRENT_JOB.lock().unwrap() = Some(Arc::downgrade(&job));
        let process = Self { pid, job: job.clone() };
        let mut readers = Vec::new();
        let pipes: [(bool, Option<Box<dyn Read + Send>>); 2] = [
            (false, child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>)),
            (true, child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>)),
        ];
        for (stderr, pipe) in pipes {
            let Some(mut pipe) = pipe else { continue };
            let events = events.clone();
            readers.push(std::thread::Builder::new().name("vmm-log".into()).spawn(move || {
                let mut buffer = [0u8; 16 * 1024];
                loop {
                    match pipe.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(n) => {
                            if events
                                .blocking_send((
                                    generation,
                                    VmmEvent::Log { stderr, chunk: buffer[..n].to_vec() },
                                ))
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
            })?);
        }
        std::thread::Builder::new().name("vmm-wait".into()).spawn(move || {
            let status = child.wait().ok();
            terminate(&job); // close any descendant-held output pipes too
            for reader in readers {
                let _ = reader.join();
            }
            let _ = events.blocking_send((
                generation,
                VmmEvent::Exited { code: status.and_then(|s| s.code()), signal: None },
            ));
        })?;
        Ok(process)
    }

    pub fn stop(&mut self, _force: bool) {
        terminate(&self.job);
    }
}

impl Drop for VmmProcess {
    fn drop(&mut self) {
        terminate(&self.job);
    }
}

pub fn signal_name(signal: i32) -> String {
    format!("signal {signal}")
}

/// Windows lifetime protection is implemented by the job, not a helper process.
pub fn run_watchdog(_pid: i32) -> i32 {
    2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dropping_a_vmm_terminates_its_process_tree_and_drains_logs() {
        let (tx, mut rx) = mpsc::channel(32);
        let program = std::env::var("ComSpec").expect("Windows command processor");
        let mut process = Some(VmmProcess::spawn(&program, &[
            "/d".into(), "/c".into(),
            "start /b ping -n 30 127.0.0.1 >nul & echo WINDOWS_JOB_READY & ping -n 30 127.0.0.1 >nul".into(),
        ], 17, tx).unwrap());
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let mut ready = false;
            while let Some((generation, event)) = rx.recv().await {
                assert_eq!(generation, 17);
                match event {
                    VmmEvent::Log { chunk, .. } => {
                        if String::from_utf8_lossy(&chunk).contains("WINDOWS_JOB_READY") {
                            ready = true;
                            drop(process.take());
                        }
                    }
                    VmmEvent::Exited { .. } => {
                        assert!(ready);
                        return;
                    }
                }
            }
            panic!("VMM closed without its exit event");
        })
        .await
        .expect("drop must kill the descendant, not wait for ping to finish");
    }
}
