# Windows QEMU showcase (Git Bash)

This walkthrough demonstrates the end-user Windows x64 path for Gondolin's
QEMU backend from a local checkout.

It is written for **Git Bash on Windows** and exercises the most relevant
features in one flow:

- QEMU + WHPX host support
- host directory mounts (`--mount-hostfs`)
- outbound HTTP allowlists (`--allow-host`)
- secret injection without guest exposure (`--host-secret`)
- host ingress (`--listen`)
- host → guest SSH access (`--ssh`)
- session discovery (`gondolin list`)
- session attach (`gondolin attach`)
- optional snapshot/resume

> `krun` is not part of this walkthrough. On Windows, use the default
> `qemu` backend.

## Prerequisites

- Windows x64
- Node.js `>= 23.6`
- A QEMU build with `whpx` support
- This repo checked out locally

Useful Windows references:

- QEMU WHPX documentation: https://www.qemu.org/docs/master/system/whpx.html
- Example Windows installer used during validation: https://qemu.weilnetz.de/w64/2026/qemu-w64-setup-20260415.exe
- Example installer SHA512: `736e125e044149611c47510d5696bc877b8df741655f229a3e9348f31bd49bf2b0105c78717888f5259aac3708e51fdc9d2c45d919becec5ec9398a08c8d435a`
- Enable the Hypervisor Platform feature if WHPX is unavailable:

```powershell
DISM /online /Enable-Feature /FeatureName:HypervisorPlatform /All
```

Gondolin auto-detects the usual Windows QEMU binary names when `sandbox.qemuPath`
is not set, including `qemu-system-x86_64`, `qemu-system-x86_64w`, and the
standard `C:\Program Files\qemu\...` install paths.

From the repo root:

```bash
pnpm install
pnpm build
qemu-system-x86_64 -accel help
```

Expected QEMU accelerator output includes:

```text
Accelerators supported in QEMU binary:
tcg
whpx
```

## 1. Prepare a demo workspace

From the repo root in Git Bash:

```bash
mkdir -p demo

cat > demo/index.html <<'EOF'
<!doctype html>
<html>
  <body>
    <h1>Hello from Gondolin</h1>
    <p>If you can read this on localhost, ingress works.</p>
  </body>
</html>
EOF

export demo="$PWD/demo"
export SHOWCASE_TOKEN=demo-secret-123
```

## 2. Launch Gondolin with mounts, network policy, ingress, and SSH

```bash
pnpm gondolin bash \
  --mount-hostfs "$demo:/workspace" \
  --allow-host httpbin.org \
  --host-secret SHOWCASE_TOKEN@httpbin.org \
  --listen 127.0.0.1:3000 \
  --ssh --ssh-port 2222
```

Expected startup output looks like:

```text
SSH enabled: ssh -p 2222 -i C:\Users\Admin\AppData\Local\Temp\gondolin-ssh-...\id_ed25519 -o ForwardAgent=no -o ClearAllForwardings=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@127.0.0.1
Ingress enabled: http://127.0.0.1:3000
Configure routes by editing /etc/gondolin/listeners inside the VM.
(none):/#
```

Keep this shell open. It is the primary guest shell for the rest of the demo.

## 3. Inside the guest: prove the mount, ingress config, and secret injection

Run these commands inside the VM shell:

```sh
pwd
set -eux

echo "written by guest" > /workspace/from-guest.txt
echo "snapshot-ok" > /etc/checkpoint.txt
printf '/ :8000\n' > /etc/gondolin/listeners

cd /workspace
python3 -m http.server 8000 >/tmp/showcase-http.log 2>&1 &

echo "$SHOWCASE_TOKEN"

curl -sS \
  -H "Authorization: Bearer $SHOWCASE_TOKEN" \
  https://httpbin.org/anything | sed -n '1,40p'
```

Observed output from a successful run:

```text
(none):/# pwd
/
(none):/# set -eux
(none):/# echo "written by guest" > /workspace/from-guest.txt
+ echo 'written by guest'
(none):/# echo "snapshot-ok" > /etc/checkpoint.txt
+ echo snapshot-ok
(none):/# printf '/ :8000\n' > /etc/gondolin/listeners
+ printf '/ :8000\n'
(none):/# cd /workspace
+ cd /workspace
(none):/workspace# python3 -m http.server 8000 >/tmp/showcase-http.log 2>&1 &
[1] 738
+ python3 -m http.server 8000
(none):/workspace# echo $SHOWCASE_TOKEN
+ echo GONDOLIN_SECRET_07f1d89d439a12d9ce54747d936720cfc366a55945a6d368
GONDOLIN_SECRET_07f1d89d439a12d9ce54747d936720cfc366a55945a6d368
(none):/workspace# curl -sS \
>   -H "Authorization: Bearer $SHOWCASE_TOKEN" \
>   https://httpbin.org/anything | sed -n '1,40p'
+ sed -n 1,40p
+ curl -sS -H 'Authorization: Bearer GONDOLIN_SECRET_07f1d89d439a12d9ce54747d936720cfc366a55945a6d368' https://httpbin.org/anything
{
  "args": {},
  "data": "",
  "files": {},
  "form": {},
  "headers": {
    "Accept": "*/*",
    "Accept-Encoding": "br, gzip, deflate",
    "Accept-Language": "*",
    "Authorization": "Bearer demo-secret-123",
    "Host": "httpbin.org",
    "Sec-Fetch-Mode": "cors",
    "User-Agent": "curl/8.17.0",
    "X-Amzn-Trace-Id": "Root=1-69e016c0-7478b3de6855bd6d0958338c"
  },
  "json": null,
  "method": "GET",
  "origin": "91.90.174.9",
  "url": "https://httpbin.org/anything"
}
```

What this proves:

- `/workspace` is a live host mount
- the guest can write files back to the host
- `/etc/checkpoint.txt` is written to the root disk, so it can survive disk-only checkpoint resume
- `/etc/gondolin/listeners` configures host ingress routing
- the guest only sees a `GONDOLIN_SECRET_...` placeholder
- the host replaces that placeholder with the real secret for the allowed host

## 4. From another terminal: prove the host can see the guest changes

Open a second Git Bash window in the repo root.

### 4.1 Verify the file written by the guest

```bash
cat demo/from-guest.txt
```

Observed output:

```text
written by guest
```

### 4.2 Verify ingress from host → guest

```bash
curl -sS http://127.0.0.1:3000/
```

Observed output:

```html
<!doctype html>
<html>
    <body>
    <h1>Hello from Gondolin</h1>
    <p>If you can read this on localhost, ingress works.</p>
    </body>
</html>
```

## 5. Discover the live session

```bash
pnpm gondolin list
```

Observed output:

```text
ID                                    PID    AGE  ALIVE  LABEL
cb977f76-d32d-42a9-89fd-9a937cefe4fe  15368  4m   yes    C:\Program Files\nodejs\node.exe C:\CodeBlocks\gondolin\host\bin\gondolin.ts bash --mount-hostfs C:\\CodeBlocks\\gondolin\\demo;C:\\Program Files\\Git\\workspace --allow-host httpbin.org --host-secret SHOWCASE_TOKEN@httpbin.org --listen 127.0.0.1:3000 --ssh --ssh-port 2222
```

Copy the session ID for the next step.

## 6. Attach a second command to the running VM

In Git Bash, prefix the command with `MSYS2_ARG_CONV_EXCL='*'` so `/bin/sh`
reaches the guest unchanged.

```bash
MSYS2_ARG_CONV_EXCL='*' pnpm gondolin attach <SESSION_ID> -- /bin/sh -lc \
  'echo ATTACH_OK && ls -la /workspace && cat /workspace/from-guest.txt'
```

Observed output:

```text
ATTACH_OK
total 1
-rw-rw-rw-    1 root     root            17 Apr 15 22:51 from-guest.txt
-rw-rw-rw-    1 root     root           153 Apr 15 22:37 index.html
written by guest
```

What this proves:

- session registry works on Windows
- attach IPC works on Windows
- the attached process sees the same mounted workspace and guest state

## 7. SSH into the guest from the host

The easiest path is to copy the exact `ssh ...` command printed by Gondolin when
it started. Example:

```bash
ssh -p 2222 -i /c/Users/Admin/AppData/Local/Temp/gondolin-ssh-2YQoxX/id_ed25519 \
  -o ForwardAgent=no \
  -o ClearAllForwardings=yes \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  root@127.0.0.1 'uname -a && cat /workspace/from-guest.txt'
```

Observed output:

```text
Warning: Permanently added '[127.0.0.1]:2222' (ED25519) to the list of known hosts.
Linux (none) 6.18.13-0-virt #1-Alpine SMP PREEMPT_DYNAMIC 2026-02-20 15:23:57 x86_64 Linux
written by guest
```

What this proves:

- host → guest SSH forwarding works on Windows
- the guest is a real Linux VM reachable via the advertised SSH endpoint

## 8. Optional: snapshot and resume

This step stops the live session and writes a qcow2 checkpoint.

```bash
pnpm gondolin snapshot <SESSION_ID> --output ./showcase.qcow2
```

Resume it with the **same host-side arguments again** so the resumed VM gets the
same mount, allowlist, secret injection, ingress, and SSH setup as the original
showcase session:

```bash
pnpm gondolin bash \
  --resume ./showcase.qcow2 \
  --mount-hostfs "$demo:/workspace" \
  --allow-host httpbin.org \
  --host-secret SHOWCASE_TOKEN@httpbin.org \
  --listen 127.0.0.1:3000 \
  --ssh --ssh-port 2222
```

In Git Bash, prefer `./showcase.qcow2`, `host/showcase.qcow2`, or a `/c/...`
path. Avoid an unquoted `C:\...` argument, because bash treats backslashes as
escape characters before Gondolin sees the path.

Inside the resumed VM shell, verify both the checkpointed root-disk state and
that `/workspace` has been mounted again:

```sh
cat /etc/checkpoint.txt && echo RESUME_OK
ls -la /workspace
cat /workspace/from-guest.txt
```

Expected output:

```text
snapshot-ok
RESUME_OK
total 1
-rw-rw-rw-    1 root     root            17 ... from-guest.txt
-rw-rw-rw-    1 root     root           153 ... index.html
written by guest
```

Notes:

- snapshots are **disk-only**
- tmpfs-backed paths like `/tmp` are **not** preserved
- host mounts and listeners are re-created from the CLI arguments you pass on resume

What this proves:

- disk checkpoints work on Windows with the QEMU backend
- resumed VMs can recover root-disk state written before the snapshot
- the same host filesystem mount can be reattached after resume
- the resumed VM can be brought back up with the same end-user CLI workflow shape

## Success criteria summary

A successful Windows showcase demonstrates all of the following:

- `qemu-system-x86_64 -accel help` advertises `whpx`
- Gondolin boots a guest and opens an interactive shell
- `--mount-hostfs` works from Git Bash with `/c/...` host paths
- guest writes appear on the host under `demo/`
- `--allow-host` permits outbound HTTP only to the configured host
- `--host-secret` injects a placeholder into the guest and substitutes the real secret on the host side
- `--listen` exposes a guest web server on `http://127.0.0.1:3000/`
- `gondolin list` sees the live session
- `gondolin attach` can run an extra command in the same VM
- `--ssh` enables host SSH access to the guest
- optional: snapshot/resume preserves root-disk guest state, and the showcase host-side settings can be re-applied on resume

If all of those pass, Gondolin's Windows x64 QEMU path is working end-to-end in
an end-user workflow.
