// EXPERIMENTAL: host-acceptance candidate, not wired to the SDK sandbox mode.
// Policy changes require adversarial acceptance on the exact deployment host.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/magic.h>
#include <linux/sched.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/ioctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <unistd.h>
#if !defined(__x86_64__)
#error "Experimental syscall policy is only reviewed for x86_64"
#endif

static _Noreturn void fail(const char *stage) {
  int error = errno;
  dprintf(3, "{\"stage\":\"%s\",\"errno\":%d}\n", stage, error);
  fprintf(stderr, "linux-launcher: %s: %s\n", stage, strerror(error));
  exit(125);
}
static void require(int condition, const char *stage) {
  if (!condition) { errno = EINVAL; fail(stage); }
}
static void write_exact(int fd, const char *s, const char *stage) {
  size_t len = strlen(s);
  if (write(fd, s, len) != (ssize_t)len) fail(stage);
}
static void control_equals(int cg, const char *name, const char *expected) {
  int fd = openat(cg, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) fail(name);
  char buf[256];
  ssize_t n = read(fd, buf, sizeof(buf) - 1);
  if (n < 0) fail(name);
  close(fd);
  while (n > 0 && (buf[n - 1] == '\n' || buf[n - 1] == ' ')) n--;
  buf[n] = 0;
  require(!strcmp(buf, expected), name);
}
static unsigned long long positive(const char *s) {
  char *end; errno = 0;
  unsigned long long n = strtoull(s, &end, 10);
  require(!errno && *s >= '1' && *s <= '9' && !*end && n, "positive-limit");
  return n;
}
static void no_capabilities(void) {
  struct __user_cap_header_struct h = {_LINUX_CAPABILITY_VERSION_3, 0};
  struct __user_cap_data_struct d[2] = {{0}, {0}};
  if (syscall(SYS_capget, &h, d)) fail("capget");
  require(!(d[0].effective | d[1].effective | d[0].permitted | d[1].permitted |
    d[0].inheritable | d[1].inheritable), "run-with-empty-capability-sets");
}
static void rule(int ruleset, const char *path, uint64_t access, int directory) {
  // Paths are trusted host configuration; their parents must not be tenant-writable.
  int fd = open(path, O_PATH | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) fail("rule-open");
  struct stat s;
  if (fstat(fd, &s)) fail("rule-stat");
  require(directory ? S_ISDIR(s.st_mode) : S_ISREG(s.st_mode), "rule-type");
  struct landlock_path_beneath_attr r = {.allowed_access = access, .parent_fd = fd};
  if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &r, 0)) fail("landlock-rule");
  close(fd);
}
#define ALLOW(n) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_##n, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
#define ERR(e) BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (e))
static void filter(void) {
  // Default deny covers new externally-addressable sockets, io_uring, ptrace/process_vm, pidfd_getfd,
  // SysV IPC, mounts, namespaces, BPF, perf, keyrings, ownership and metadata writes.
  const unsigned clone_flags = CSIGNAL | CLONE_VM | CLONE_FS | CLONE_FILES |
    CLONE_SIGHAND | CLONE_VFORK | CLONE_THREAD | CLONE_SYSVSEM | CLONE_SETTLS |
    CLONE_PARENT_SETTID | CLONE_CHILD_CLEARTID | CLONE_CHILD_SETTID;
  struct sock_filter code[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    // x32 uses the same audit arch with a distinct syscall-number bit.
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1), ERR(EPERM),
    // Force libc to use inspectable clone flags; never inspect clone3 pointers.
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone3, 0, 1), ERR(ENOSYS),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone, 0, 7),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]) + 4),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0), ERR(EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, ~clone_flags, 0, 1), ERR(EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    // libuv toggles nonblocking mode via ioctl on pipes/anonymous socket pairs.
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_ioctl, 0, 5),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, FIONBIO, 2, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, FIONREAD, 1, 0), ERR(EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    // libuv uses anonymous UNIX stream pairs for child stdio. Permit only new
    // private pairs, not socket/connect/bind/listen or descriptor-passing calls.
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socketpair, 0, 11),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 1, 0), ERR(EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, ~(SOCK_CLOEXEC | SOCK_NONBLOCK)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SOCK_STREAM, 1, 0), ERR(EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0), ERR(EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    // Do not allow F_SETOWN/F_SETSIG/F_SETLEASE to target unrelated processes.
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_fcntl, 0, 9),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_GETFD, 6, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_SETFD, 5, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_GETFL, 4, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_SETFL, 3, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_DUPFD, 2, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_DUPFD_CLOEXEC, 1, 0), ERR(EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    // prlimit may address another process; permit only the current process (0).
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_prlimit64, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0), ERR(EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_prctl, 0, 5),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, PR_SET_NAME, 2, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, PR_GET_NAME, 1, 0), ERR(EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    ALLOW(read), ALLOW(write), ALLOW(readv), ALLOW(writev), ALLOW(pread64), ALLOW(pwrite64),
    ALLOW(close), ALLOW(close_range), ALLOW(lseek), ALLOW(dup), ALLOW(dup2), ALLOW(dup3),
    ALLOW(poll), ALLOW(ppoll), ALLOW(select), ALLOW(pselect6), ALLOW(epoll_create), ALLOW(epoll_create1),
    ALLOW(epoll_ctl), ALLOW(epoll_wait), ALLOW(epoll_pwait), ALLOW(epoll_pwait2), ALLOW(eventfd2),
    ALLOW(pipe), ALLOW(pipe2), ALLOW(open), ALLOW(openat), ALLOW(openat2), ALLOW(creat),
    ALLOW(getsockopt), ALLOW(getsockname), ALLOW(getpeername), ALLOW(shutdown),
    ALLOW(access), ALLOW(faccessat), ALLOW(faccessat2), ALLOW(fstat), ALLOW(stat), ALLOW(lstat),
    ALLOW(newfstatat), ALLOW(statx), ALLOW(statfs), ALLOW(fstatfs), ALLOW(getdents), ALLOW(getdents64),
    ALLOW(readlink), ALLOW(readlinkat), ALLOW(truncate), ALLOW(ftruncate), ALLOW(fsync), ALLOW(fdatasync),
    ALLOW(unlink), ALLOW(unlinkat), ALLOW(mkdir), ALLOW(mkdirat), ALLOW(rmdir),
    ALLOW(rename), ALLOW(renameat), ALLOW(renameat2), ALLOW(link), ALLOW(linkat), ALLOW(symlink), ALLOW(symlinkat),
    ALLOW(chdir), ALLOW(fchdir), ALLOW(getcwd), ALLOW(umask),
    ALLOW(mmap), ALLOW(mprotect), ALLOW(munmap), ALLOW(mremap), ALLOW(madvise), ALLOW(brk),
    ALLOW(rt_sigaction), ALLOW(rt_sigprocmask), ALLOW(rt_sigreturn), ALLOW(rt_sigsuspend),
    ALLOW(rt_sigtimedwait), ALLOW(sigaltstack), ALLOW(kill), ALLOW(tkill), ALLOW(tgkill),
    ALLOW(wait4), ALLOW(waitid), ALLOW(getpid), ALLOW(getppid), ALLOW(gettid), ALLOW(getpgrp),
    ALLOW(getpgid), ALLOW(getsid), ALLOW(setpgid), ALLOW(setsid), ALLOW(fork), ALLOW(vfork),
    ALLOW(execve), ALLOW(exit), ALLOW(exit_group), ALLOW(futex), ALLOW(set_tid_address),
    ALLOW(set_robust_list), ALLOW(rseq), ALLOW(arch_prctl),
    ALLOW(clock_gettime), ALLOW(clock_getres), ALLOW(clock_nanosleep), ALLOW(nanosleep),
    ALLOW(gettimeofday), ALLOW(time), ALLOW(times), ALLOW(getrusage), ALLOW(getrlimit), ALLOW(setrlimit),
    ALLOW(sched_yield), ALLOW(sched_getaffinity), ALLOW(sched_getparam), ALLOW(sched_getscheduler),
    ALLOW(sched_get_priority_min), ALLOW(sched_get_priority_max), ALLOW(getcpu), ALLOW(getrandom),
    ALLOW(uname), ALLOW(sysinfo), ALLOW(getuid), ALLOW(geteuid), ALLOW(getgid), ALLOW(getegid), ALLOW(getgroups),
    ERR(EPERM),
  };
  struct sock_fprog program = {.len = sizeof(code) / sizeof(code[0]), .filter = code};
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) fail("seccomp-filter");
}
static int self_test_seccomp(void) {
  // Fixed trusted diagnostic only. There is no option to launch a command while
  // omitting Landlock/cgroups. This filter is added to the inherited restrictions.
  int before = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  int baseline = before >= 0;
  if (before >= 0) close(before);
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail("probe-no-new-privileges");
  filter();
  int families[] = {AF_INET, AF_INET6, AF_UNIX};
  for (unsigned i = 0; i < sizeof(families) / sizeof(families[0]); i++) {
    errno = 0;
    require(socket(families[i], SOCK_STREAM, 0) == -1 && errno == EPERM, "probe-socket-denial");
  }
  errno = 0;
  require(syscall(SYS_clone3, NULL, 0) == -1 && errno == ENOSYS, "probe-clone3-fallback");
  errno = 0;
  require(syscall(SYS_getpid | 0x40000000) == -1 && errno == EPERM, "probe-x32-denial");
  errno = 0;
  require(syscall(SYS_prlimit64, getppid(), RLIMIT_NOFILE, NULL, NULL) == -1 && errno == EPERM, "probe-foreign-prlimit");
  errno = 0;
  require(fcntl(1, F_SETOWN, getppid()) == -1 && errno == EPERM, "probe-fcntl-owner");
  require(getpid() > 0 && fcntl(1, F_GETFD) >= 0, "probe-allowed-syscalls");
  int pair[2];
  require(socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair) == 0, "probe-private-stdio-pair");
  close(pair[0]); close(pair[1]); errno = 0;
  require(socketpair(AF_UNIX, SOCK_DGRAM, 0, pair) == -1 && errno == EPERM, "probe-datagram-pair-denied");
  errno = 0;
  require(ioctl(1, 0x5412, NULL) == -1 && errno == EPERM, "probe-terminal-injection-denied");
  printf("{\"seccompInstalled\":true,\"socketAllowedBeforeFilter\":%s,\"checks\":11,\"sandboxVerified\":false}\n", baseline ? "true" : "false");
  return 0;
}
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--self-test-seccomp")) return self_test_seccomp();
  const char *workspace = NULL, *cgroup = NULL, *memory = NULL, *pids = NULL, *cpu = NULL;
  const char *runtime[256]; int count = 0, command = 0;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--")) { command = i + 1; break; }
    require(i + 1 < argc, "option-value");
    const char *key = argv[i], *value = argv[++i];
    if (!strcmp(key, "--workspace")) { require(!workspace, "duplicate-option"); workspace = value; }
    else if (!strcmp(key, "--cgroup")) { require(!cgroup, "duplicate-option"); cgroup = value; }
    else if (!strcmp(key, "--memory")) { require(!memory, "duplicate-option"); memory = value; }
    else if (!strcmp(key, "--pids")) { require(!pids, "duplicate-option"); pids = value; }
    else if (!strcmp(key, "--cpu")) { require(!cpu, "duplicate-option"); cpu = value; }
    else if (!strcmp(key, "--runtime-file")) { require(count < 256, "runtime-count"); runtime[count++] = value; }
    else { errno = EINVAL; fail("unknown-option"); }
  }
  require(workspace && cgroup && memory && pids && cpu && count && command && command < argc,
    "required-options");
  require(workspace[0] == '/' && cgroup[0] == '/' && argv[command][0] == '/', "absolute-host-paths");
  positive(memory); positive(pids);
  char quota[32], period[32], extra;
  require(sscanf(cpu, "%31s %31s %c", quota, period, &extra) == 2, "cpu-format");
  positive(quota); positive(period);
  for (int fd = 0; fd <= 3; fd++) {
    struct stat s;
    if (fstat(fd, &s)) fail("stdio");
    require(S_ISFIFO(s.st_mode) || S_ISSOCK(s.st_mode), "stdio-must-be-manager-pipes");
  }
  if (fcntl(3, F_SETFD, FD_CLOEXEC)) fail("status-cloexec");
  no_capabilities();
  long abi = syscall(SYS_landlock_create_ruleset, NULL, 0, 1);
  if (abi < 0) fail("landlock-abi");
  require(abi >= 6, "landlock-abi-minimum-6");
  int cg = open(cgroup, O_DIRECTORY | O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (cg < 0) fail("cgroup-open");
  struct statfs fs;
  if (fstatfs(cg, &fs)) fail("cgroup-statfs");
  require(fs.f_type == CGROUP2_SUPER_MAGIC, "cgroup-v2-required");
  control_equals(cg, "memory.max", memory); control_equals(cg, "memory.swap.max", "0");
  control_equals(cg, "memory.oom.group", "1"); control_equals(cg, "pids.max", pids);
  control_equals(cg, "cpu.max", cpu); control_equals(cg, "cgroup.procs", "");
  int procs = openat(cg, "cgroup.procs", O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  if (procs < 0) fail("cgroup-procs");
  write_exact(procs, "0", "cgroup-join"); close(procs);
  char pid[32]; snprintf(pid, sizeof(pid), "%ld", (long)getpid());
  control_equals(cg, "cgroup.procs", pid); close(cg);
  // Local ABI-6 layout permits builds with older distro headers. No optional
  // rights are silently dropped; all FS rights through ABI 5 are handled.
  struct { uint64_t fs, net, scoped; } policy = { .fs = (1ULL << 16) - 1, .net = 3, .scoped = 3 };
  int ruleset = syscall(SYS_landlock_create_ruleset, &policy, sizeof(policy), 0);
  if (ruleset < 0) fail("landlock-create");
  uint64_t workspace_access = policy.fs & ~((1ULL << 6) | (1ULL << 9) | (1ULL << 11) | (1ULL << 15));
  rule(ruleset, workspace, workspace_access, 1);
  for (int i = 0; i < count; i++) {
    require(runtime[i][0] == '/', "absolute-runtime-file");
    rule(ruleset, runtime[i], LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_EXECUTE, 0);
  }
  if (chdir(workspace)) fail("workspace-cwd");
  struct rlimit core = {0, 0};
  if (setrlimit(RLIMIT_CORE, &core)) fail("core-limit");
  umask(0077);
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail("no-new-privileges");
  if (syscall(SYS_landlock_restrict_self, ruleset, 0)) fail("landlock-restrict");
  close(ruleset);
  if (syscall(SYS_close_range, 4, ~0U, 0)) fail("close-inherited-fds");
  char *home, *tmp;
  if (asprintf(&home, "HOME=%s", workspace) < 0 || asprintf(&tmp, "TMPDIR=%s", workspace) < 0) fail("environment");
  char *env[] = {home, tmp, "LANG=C.UTF-8", "PATH=/nonexistent", NULL};
  filter();
  write_exact(3, "{\"stage\":\"restricted-before-exec\",\"experimental\":true}\n", "status-ready");
  execve(argv[command], &argv[command], env);
  fail("execve");
}
