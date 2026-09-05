# OpenClaw worker compatibility audit

- OpenClaw: `2026.8.1`
- AgentOS: `0.2.19`
- Worker SHA-256: `03eca1d346aa24fd5028b2ca8d09385b764bf9dd2c82810ce564043a34356f1c`
- Worker bytes: `46593544`
- Builtin modules imported: `37`
- Blocking modules: `5`

| Builtin | Required named exports | Result | Missing/error |
| --- | --- | --- | --- |
| `node:assert` | default | compatible | — |
| `node:async_hooks` | AsyncLocalStorage | compatible | — |
| `node:buffer` | Buffer, isUtf8 | compatible | — |
| `node:child_process` | default, ChildProcess, execFile, execFileSync, execSync, fork, spawn, spawnSync, namespace | compatible | — |
| `node:crypto` | default, X509Certificate, createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, hash, randomBytes, randomInt, randomUUID, sign, timingSafeEqual, namespace | missing-export | X509Certificate, hash, randomInt |
| `node:diagnostics_channel` | channel | compatible | — |
| `node:dns` | lookup | compatible | — |
| `node:dns/promises` | lookup | compatible | — |
| `node:events` | default, EventEmitter, addAbortListener, on, once, setMaxListeners | compatible | — |
| `node:fs` | default, accessSync, appendFileSync, chmodSync, close, closeSync, constants, createReadStream, createWriteStream, default, existsSync, globSync, linkSync, lstatSync, mkdirSync, openSync, promises, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, stat, statSync, unlinkSync, unwatchFile, watch, watchFile, write, writeFileSync, writev, namespace | missing-export | globSync, writev |
| `node:fs/promises` | default, access, chmod, copyFile, default, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile, namespace | compatible | — |
| `node:http` | default, createServer, request | compatible | — |
| `node:http2` | default | compatible | — |
| `node:https` | default, Agent, createServer, request | compatible | — |
| `node:module` | default, createRequire, flushCompileCache | missing-export | flushCompileCache |
| `node:net` | default, isIP, namespace | compatible | — |
| `node:os` | default, arch, constants, homedir, hostname, platform, tmpdir, totalmem, type, namespace | compatible | — |
| `node:path` | default, basename, dirname, isAbsolute, join, parse, posix, relative, resolve, sep, win32, namespace | compatible | — |
| `node:path/win32` | default | compatible | — |
| `node:perf_hooks` | monitorEventLoopDelay, performance | missing-export | monitorEventLoopDelay |
| `node:process` | default, execArgv, execPath, hrtime, platform, stdin, stdout | compatible | — |
| `node:readline` | default, createInterface, namespace | compatible | — |
| `node:readline/promises` | default | unresolved | not present in the AgentOS builtin registry |
| `node:stream` | default, Duplex, PassThrough, Readable, Transform, Writable, getDefaultHighWaterMark, pipeline | compatible | — |
| `node:stream/promises` | finished, pipeline | compatible | — |
| `node:string_decoder` | StringDecoder | compatible | — |
| `node:timers` | clearTimeout, setTimeout | compatible | — |
| `node:timers/promises` | scheduler, setImmediate, setTimeout | compatible | — |
| `node:tls` | default, TLSSocket, rootCertificates | compatible | — |
| `node:tty` | default, ReadStream | compatible | — |
| `node:url` | URL, domainToASCII, fileURLToPath, format, pathToFileURL | compatible | — |
| `node:util` | default, TextDecoder, aborted, callbackify, debuglog, deprecate, inspect, isDeepStrictEqual, promisify, stripVTControlCharacters, styleText, types | compatible | — |
| `node:util/types` | isProxy | compatible | — |
| `node:v8` | getHeapStatistics, serialize | compatible | — |
| `node:vm` | Script | compatible | — |
| `node:worker_threads` | Worker | compatible | — |
| `node:zlib` | default, brotliCompress, constants, createGunzip, deflateSync, gunzipSync, gzip, gzipSync, inflateSync, namespace | compatible | — |

`compatible` means the module resolved and exposed every statically imported
named/default export. It does not prove behavioral equivalence with Node.js.
Namespace imports are recorded but cannot be exhaustively validated statically.
