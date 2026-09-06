// Experimental, one-operation broker primitive. fd 3 is an already-open workspace.
// No pathname fallback: unsupported openat2 or ambiguous resolution is an error.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static _Noreturn void fail(const char *stage) {
  fprintf(stderr, "{\"stage\":\"%s\",\"errno\":%d}\n", stage, errno);
  exit(1);
}
static int beneath(const char *path, int flags, unsigned mode) {
  struct open_how how = {.flags = (unsigned)flags | O_CLOEXEC | O_NOFOLLOW,
    .mode = mode, .resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS |
      RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV};
  int fd = syscall(SYS_openat2, 3, path, &how, sizeof(how));
  if (fd < 0) fail("openat2");
  return fd;
}
static void write_all(int fd, const char *data, size_t size) {
  while (size) {
    ssize_t n = write(fd, data, size);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) fail("write");
    data += n; size -= n;
  }
}
int main(int argc, char **argv) {
  if (argc != 4) { errno = EINVAL; fail("arguments"); }
  char *end;
  errno = 0;
  unsigned long limit = strtoul(argv[3], &end, 10);
  if (errno || !*argv[3] || *end || !limit || limit > 16777216) {
    errno = EINVAL; fail("limit");
  }
  struct stat root;
  if (fstat(3, &root) || !S_ISDIR(root.st_mode)) { errno = ENOTDIR; fail("root-fd"); }
  const char *op = argv[1], *path = argv[2];
  if (!*path || path[0] == '/') { errno = EINVAL; fail("relative-path"); }
  if (!strcmp(op, "stat")) {
    int fd = beneath(path, O_PATH, 0);
    struct stat s;
    if (fstat(fd, &s)) fail("stat");
    // O_PATH|O_NOFOLLOW can return the symlink itself; never report it as a file.
    if (!S_ISREG(s.st_mode) && !S_ISDIR(s.st_mode)) { errno = EPERM; fail("file-type"); }
    printf("{\"size\":%lld,\"sizeExact\":\"%lld\",\"directory\":%s,\"isDirectory\":%s,"
      "\"isSymbolicLink\":false,\"dev\":%llu,\"rdev\":%llu,\"ino\":%llu,\"inoExact\":\"%llu\","
      "\"nlink\":%llu,\"nlinkExact\":\"%llu\",\"mode\":%u,\"uid\":%u,\"gid\":%u,\"blocks\":%lld,"
      "\"atimeMs\":%.6f,\"mtimeMs\":%.6f,\"ctimeMs\":%.6f,\"birthtimeMs\":0}\n",
      (long long)s.st_size, (long long)s.st_size, S_ISDIR(s.st_mode) ? "true" : "false",
      S_ISDIR(s.st_mode) ? "true" : "false", (unsigned long long)s.st_dev,
      (unsigned long long)s.st_rdev, (unsigned long long)s.st_ino, (unsigned long long)s.st_ino,
      (unsigned long long)s.st_nlink, (unsigned long long)s.st_nlink, s.st_mode, s.st_uid, s.st_gid,
      (long long)s.st_blocks, s.st_atim.tv_sec * 1000.0 + s.st_atim.tv_nsec / 1000000.0,
      s.st_mtim.tv_sec * 1000.0 + s.st_mtim.tv_nsec / 1000000.0,
      s.st_ctim.tv_sec * 1000.0 + s.st_ctim.tv_nsec / 1000000.0);
    close(fd); return 0;
  }
  if (strcmp(op, "read") && strcmp(op, "write")) { errno = EINVAL; fail("operation"); }
  char *data = malloc(limit + 1);
  if (!data) fail("allocate");
  size_t size = 0;
  int writing = !strcmp(op, "write");
  // Fully bound input before opening/truncating the destination.
  if (writing) {
    while (size <= limit) {
      ssize_t n = read(0, data + size, limit + 1 - size);
      if (n < 0 && errno == EINTR) continue;
      if (n < 0) fail("stdin");
      if (!n) break;
      size += n;
    }
    if (size > limit) { errno = EFBIG; fail("input-limit"); }
  }
  int fd = beneath(path, (writing ? O_WRONLY | O_CREAT : O_RDONLY) | O_NONBLOCK,
    writing ? 0600 : 0);
  struct stat s;
  if (fstat(fd, &s)) fail("stat");
  if (!S_ISREG(s.st_mode) || s.st_nlink != 1) { errno = EPERM; fail("regular-single-link-file"); }
  if (writing) {
    if (ftruncate(fd, 0)) fail("truncate");
    write_all(fd, data, size);
  } else {
    while (size <= limit) {
      ssize_t n = read(fd, data + size, limit + 1 - size);
      if (n < 0 && errno == EINTR) continue;
      if (n < 0) fail("read");
      if (!n) break;
      size += n;
    }
    if (size > limit) { errno = EFBIG; fail("output-limit"); }
    write_all(1, data, size);
  }
  if (close(fd)) fail("close");
  free(data); return 0;
}
