// Experimental per-active-job supervisor. fd 3: status, fd 4: manager liveness/control.
// The supervisor stays outside the workload cgroup and never runs tenant code itself.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/magic.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
static volatile sig_atomic_t interrupted;
static void on_signal(int number) { (void)number; interrupted = 1; }
static long long now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1000LL + t.tv_nsec / 1000000; }
static int group_fd = -1, kill_fd = -1;
static pid_t root_pid;
static int exact(int fd, const char *s) {
  ssize_t n;
  do { n = write(fd, s, strlen(s)); } while (n < 0 && errno == EINTR);
  return n == (ssize_t)strlen(s) ? 0 : -1;
}
static void reap_root(void) { while (waitpid(root_pid, NULL, 0) < 0 && errno == EINTR) {} }
static int group_open(const char *path) {
#ifdef AGENTOS_SUPERVISOR_TEST
  // Compile-only trusted state-machine fixture, never in the distributed helper.
  (void)path; return 0;
#else
  group_fd = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (group_fd < 0) return -1;
  struct statfs s;
  if (fstatfs(group_fd, &s)) return -1;
  if (s.f_type != CGROUP2_SUPER_MAGIC) { errno = EINVAL; return -1; }
  kill_fd = openat(group_fd, "cgroup.kill", O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  return kill_fd < 0 ? -1 : 0;
#endif
}
static int group_join(void) {
#ifdef AGENTOS_SUPERVISOR_TEST
  return setpgid(root_pid, root_pid);
#else
  int fd = openat(group_fd, "cgroup.procs", O_RDWR | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -1;
  char before[64]; ssize_t n = read(fd, before, sizeof(before));
  if (n != 0) { close(fd); errno = EBUSY; return -1; }
  char pid[32]; snprintf(pid, sizeof(pid), "%ld", (long)root_pid);
  if (exact(fd, pid)) { close(fd); return -1; }
  if (lseek(fd, 0, SEEK_SET) < 0) { close(fd); return -1; }
  n = read(fd, before, sizeof(before) - 1); close(fd);
  if (n < 0) return -1;
  before[n] = 0;
  char expected[33]; snprintf(expected, sizeof(expected), "%s\n", pid);
  if (strcmp(before, expected)) { errno = EINVAL; return -1; }
  return 0;
#endif
}
static int group_kill(void) {
#ifdef AGENTOS_SUPERVISOR_TEST
  return kill(-root_pid, SIGKILL) == 0 || errno == ESRCH ? 0 : -1;
#else
  return exact(kill_fd, "1");
#endif
}
static int group_empty(void) {
#ifdef AGENTOS_SUPERVISOR_TEST
  return 1; // Fixture asserts reaping; this never represents cgroup enforcement.
#else
  int fd = openat(group_fd, "cgroup.events", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -1;
  char data[1024]; ssize_t n = read(fd, data, sizeof(data) - 1); close(fd);
  if (n < 0) return -1;
  data[n] = 0;
  return strstr(data, "populated 0\n") ? 1 : 0;
#endif
}
static int error(const char *stage) {
  int e = errno;
  dprintf(3, "{\"event\":\"supervisor-error\",\"stage\":\"%s\",\"errno\":%d}\n", stage, e);
  fprintf(stderr, "linux-supervisor: %s: %s\n", stage, strerror(e));
  return 125;
}
int main(int argc, char **argv) {
  if (argc < 4 || strcmp(argv[2], "--") || argv[1][0] != '/' || argv[3][0] != '/') { errno = EINVAL; return error("arguments"); }
  signal(SIGPIPE, SIG_IGN);
  for (int fd = 0; fd <= 4; fd++) {
    struct stat s;
    if (fstat(fd, &s)) return error("manager-pipes");
    if (!S_ISFIFO(s.st_mode) && !S_ISSOCK(s.st_mode)) { errno = EINVAL; return error("manager-pipes"); }
  }
  if (group_open(argv[1])) return error("cgroup-open");
  if (prctl(PR_SET_CHILD_SUBREAPER, 1)) return error("subreaper");
  struct sigaction action = {.sa_handler = on_signal}; sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL)) return error("signal-handler");
  int gate[2]; if (pipe2(gate, O_CLOEXEC)) return error("start-gate");
  pid_t supervisor_pid = getpid();
  root_pid = fork();
  if (root_pid < 0) return error("fork");
  if (!root_pid) {
    close(gate[1]);
    char start; ssize_t n;
    do { n = read(gate[0], &start, 1); } while (n < 0 && errno == EINTR);
    if (n != 1 || start != 'G') _exit(125);
    close(gate[0]);
    // Defense for supervisor death only; full descendant cleanup still depends
    // on this supervisor surviving, or an outer host service supervisor.
    if (getppid() != supervisor_pid || prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != supervisor_pid) _exit(125);
    signal(SIGPIPE, SIG_DFL); signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL);
    if (syscall(SYS_close_range, 4, ~0U, 0)) _exit(125);
    execv(argv[3], &argv[3]); _exit(error("launcher-exec"));
  }
  close(gate[0]);
  if (group_join()) {
    int e = errno; close(gate[1]); kill(root_pid, SIGKILL); reap_root(); errno = e;
    return error("cgroup-enrollment");
  }
  // Publish identity before release so readiness cannot race ahead of the SDK's
  // root PID metadata, even if the child completes immediately after exec.
  dprintf(3, "{\"event\":\"enrolled\",\"pid\":%ld}\n", (long)root_pid);
  if (exact(gate[1], "G")) {
    int e = errno; close(gate[1]); kill(root_pid, SIGKILL); reap_root(); errno = e;
    return error("start-gate-release");
  }
  close(gate[1]);
  // Only the job owns stdin/stdout. Retain stderr for supervisor diagnostics.
  close(0); close(1);
  int root_status = 0, root_done = 0, stopping = 0, reaped = 0;
  long long deadline = 0;
  for (;;) {
    int no_children = 0;
    for (;;) {
      int status; pid_t pid = waitpid(-1, &status, WNOHANG);
      if (pid == 0) break;
      if (pid < 0) { if (errno == EINTR) continue; if (errno == ECHILD) no_children = 1; else return error("waitpid"); break; }
      reaped++;
      if (pid == root_pid) {
        root_done = 1; root_status = status;
        dprintf(3, "{\"event\":\"root-exit\",\"code\":%d,\"signal\":%d}\n",
          WIFEXITED(status) ? WEXITSTATUS(status) : -1, WIFSIGNALED(status) ? WTERMSIG(status) : 0);
      }
    }
    struct pollfd control = {.fd = stopping ? -1 : 4, .events = POLLIN | POLLHUP};
    int polled = poll(&control, 1, stopping ? 10 : 25);
    if (polled < 0 && errno != EINTR) return error("control-poll");
    int requested = interrupted || root_done;
    if (polled > 0 && control.revents) {
      // Any byte requests whole-job cancellation. EOF/HUP means manager death.
      requested = 1;
    }
    if (requested && !stopping) {
      stopping = 1; deadline = now_ms() + 3000;
      dprintf(3, "{\"event\":\"cleanup-start\",\"reason\":\"%s\"}\n", root_done ? "root-exit" : "manager-cancel-or-disconnect");
      if (group_kill()) { kill(root_pid, SIGKILL); return error("cgroup-kill"); }
    }
    if (stopping) {
      int empty = group_empty();
      if (empty < 0) return error("cgroup-events");
      if (root_done && no_children && empty) {
        dprintf(3, "{\"event\":\"cleanup-complete\",\"reaped\":%d,\"populated\":0}\n", reaped);
        if (group_fd >= 0) close(group_fd);
        if (kill_fd >= 0) close(kill_fd);
        return WIFEXITED(root_status) ? WEXITSTATUS(root_status) : 128 + WTERMSIG(root_status);
      }
      if (now_ms() >= deadline) { errno = ETIMEDOUT; return error("cleanup-timeout"); }
    }
  }
}
