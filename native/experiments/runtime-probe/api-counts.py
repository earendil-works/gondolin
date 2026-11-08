#!/usr/bin/env python3
# Regex counts of tokio API mentions per crate, split into src and test code
# (native/docs/runtime-without-tokio.md, section 1). Usage: api-counts.py native/crates
import os,re,sys,collections
root=sys.argv[1]
cats={
 'runtime':r'tokio::runtime|tokio::main|Handle::current|\bblock_on\(|block_in_place|RuntimeFlavor',
 'spawn':r'tokio::spawn|task::spawn\(|\bspawn\(|JoinHandle|JoinSet|yield_now|AbortHandle',
 'spawn_blocking':r'spawn_blocking',
 'net':r'\bUnixStream\b|\bUnixListener\b|tokio::net|\bUdpSocket\b|lookup_host|TcpListener|TcpStream',
 'process':r'tokio::process|process::Child|\.wait\(\)\.await|kill_on_drop',
 'io-util':r'AsyncReadExt|AsyncWriteExt|AsyncBufReadExt|\bBufReader\b|copy_bidirectional|io::copy|\bduplex\(|io::split|\bReadBuf\b|DuplexStream|ReadHalf|WriteHalf|io::stdin|io::stdout',
 'io-traits':r'\bAsyncRead\b|\bAsyncWrite\b',
 'time':r'time::(sleep|timeout|Instant|interval|sleep_until|timeout_at|Sleep)|\bsleep\(|\btimeout\(|sleep_until|timeout_at|interval\(',
 'sync':r'\bmpsc::|\boneshot::|\bNotify\b|\bwatch::|sync::Mutex|Semaphore|sync::RwLock',
 'signal':r'tokio::signal|\bsignal\(SignalKind',
 'fs':r'tokio::fs',
 'macros':r'select!|join!|try_join!|tokio::pin!|\bpin!\(',
 'test-attr':r'#\[tokio::test',
 'async_trait':r'#\[async_trait',
 'async fn':r'\basync fn\b',
 '.await':r'\.await\b',
}
cre={k:re.compile(v) for k,v in cats.items()}
res=collections.defaultdict(lambda: collections.Counter())
for crate in sorted(os.listdir(root)):
  for dp,dn,fn in os.walk(os.path.join(root,crate)):
    if 'target' in dp: continue
    for f in fn:
      if not f.endswith('.rs'): continue
      p=os.path.join(dp,f); rel=os.path.relpath(p,os.path.join(root,crate))
      testfile = rel.startswith(('tests','benches','examples')) or 'tests' in f or f=='tests.rs'
      intest=testfile
      for line in open(p):
        s=line.strip()
        if s.startswith('//'): continue
        if '#[cfg(test)]' in s: intest=True
        kind='test' if intest else 'src'
        for k,r in cre.items():
          n=len(r.findall(line))
          if n: res[(crate,kind)][k]+=n
keys=list(cats)
print('| crate | kind | '+' | '.join(keys)+' |')
print('|'+'---|'*(len(keys)+2))
tot=collections.defaultdict(collections.Counter)
for (crate,kind),c in sorted(res.items()):
  print(f'| {crate} | {kind} | '+' | '.join(str(c.get(k,0)) for k in keys)+' |')
  tot[kind].update(c)
for kind,c in tot.items():
  print(f'| **total** | {kind} | '+' | '.join(str(c.get(k,0)) for k in keys)+' |')
