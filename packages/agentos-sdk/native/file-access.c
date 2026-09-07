// Experimental, one-operation broker primitive. fd 3 is an already-open workspace.
// No pathname fallback: unsupported openat2 or ambiguous resolution is an error.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <dirent.h>
#include <limits.h>
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
static int at_beneath(int directory, const char *path, int flags, unsigned mode) {
  struct open_how how = {.flags = (unsigned)flags | O_CLOEXEC | O_NOFOLLOW,
    .mode = mode, .resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS |
      RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV};
  int fd = syscall(SYS_openat2, directory, path, &how, sizeof(how));
  if (fd < 0) fail("openat2");
  return fd;
}
static int beneath(const char *path, int flags, unsigned mode) { return at_beneath(3, path, flags, mode); }
static void mutation_path(const char *path) {
  if (!*path || *path == '/' || strlen(path) >= PATH_MAX) { errno = EINVAL; fail("mutation-path"); }
  const char *p = path;
  while (*p) {
    size_t n = strcspn(p, "/");
    if (!n || (n == 1 && p[0] == '.') || (n == 2 && p[0] == '.' && p[1] == '.')) { errno = EINVAL; fail("mutation-component"); }
    p += n;
    if (*p && !*++p) { errno = EINVAL; fail("mutation-component"); }
  }
}
static int parent(const char *path, char **storage, char **leaf) {
  mutation_path(path);
  *storage = strdup(path); if (!*storage) fail("allocate");
  char *slash = strrchr(*storage, '/');
  if (!slash) { *leaf = *storage; return beneath(".", O_RDONLY | O_DIRECTORY, 0); }
  *slash = 0; *leaf = slash + 1;
  return beneath(*storage, O_RDONLY | O_DIRECTORY, 0);
}
static void remove_entry(int directory, const char *name, int recursive, unsigned depth, unsigned *budget) {
  if (!(*budget)--) { errno = E2BIG; fail("entry-limit"); }
  struct stat s;
  if (fstatat(directory, name, &s, AT_SYMLINK_NOFOLLOW)) fail("remove-stat");
  if (S_ISDIR(s.st_mode) && recursive) {
    if (depth >= 64) { errno = E2BIG; fail("depth-limit"); }
    int fd = at_beneath(directory, name, O_RDONLY | O_DIRECTORY, 0);
    DIR *dir = fdopendir(fd); if (!dir) fail("remove-directory");
    struct dirent *e;
    for (;;) {
      errno = 0; e = readdir(dir); if (!e) { if (errno) fail("remove-readdir"); break; }
      if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
      remove_entry(fd, e->d_name, 1, depth + 1, budget);
    }
    if (closedir(dir)) fail("remove-close");
  }
  // Unlink final symlinks themselves. Parent opens never follow symlinks.
  if (unlinkat(directory, name, S_ISDIR(s.st_mode) ? AT_REMOVEDIR : 0)) fail("unlinkat");
}
static void list(const char *path) {
  int fd = beneath(path, O_RDONLY | O_DIRECTORY, 0);
  DIR *dir = fdopendir(fd); if (!dir) fail("list-directory");
  unsigned count = 0; size_t bytes = 0;
  for (;;) {
    errno = 0; struct dirent *e = readdir(dir); if (!e) { if (errno) fail("readdir"); break; }
    if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
    struct stat s;
    if (fstatat(fd, e->d_name, &s, AT_SYMLINK_NOFOLLOW)) fail("entry-stat");
    // Hex names preserve arbitrary directory bytes. The SDK explicitly rejects
    // non-UTF-8 names instead of returning lossy paths for subsequent mutations.
    bytes += strlen(e->d_name) * 2 + 32;
    if (++count > 10000 || bytes > 1048576) { errno = E2BIG; fail("directory-limit"); }
    for (const unsigned char *p = (const unsigned char *)e->d_name; *p; p++) printf("%02x", *p);
    printf("\t%c\t%lld\n", S_ISDIR(s.st_mode) ? 'd' : S_ISLNK(s.st_mode) ? 'l' : 'f', (long long)s.st_size);
  }
  if (closedir(dir)) fail("directory-close");
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
  if (argc != 4 && argc != 5) { errno = EINVAL; fail("arguments"); }
  char *end;
  errno = 0;
  unsigned long limit = strtoul(argv[3], &end, 10);
  if (errno || !*argv[3] || *end || limit > 16777216) {
    errno = EINVAL; fail("limit");
  }
  struct stat root;
  if (fstat(3, &root) || !S_ISDIR(root.st_mode)) { errno = ENOTDIR; fail("root-fd"); }
  const char *op = argv[1], *path = argv[2];
  if ((argc == 5) != !strcmp(op, "move")) { errno = EINVAL; fail("arguments"); }
  if (!*path || path[0] == '/') { errno = EINVAL; fail("relative-path"); }
  if (!strcmp(op, "list")) { list(path); return 0; }
  if (!strcmp(op, "mkdir") || !strcmp(op, "mkdir-recursive")) {
    if (!strcmp(op, "mkdir-recursive") && !strcmp(path, ".")) return 0;
    mutation_path(path);
    if (!strcmp(op, "mkdir-recursive")) {
      char *parts = strdup(path), *save = NULL; if (!parts) fail("allocate");
      int fd = beneath(".", O_RDONLY | O_DIRECTORY, 0);
      for (char *part = strtok_r(parts, "/", &save); part; part = strtok_r(NULL, "/", &save)) {
        if (mkdirat(fd, part, 0700) && errno != EEXIST) fail("mkdirat");
        int next = at_beneath(fd, part, O_RDONLY | O_DIRECTORY, 0); close(fd); fd = next;
      }
      close(fd); free(parts); return 0;
    }
    char *storage, *leaf; int fd = parent(path, &storage, &leaf);
    if (mkdirat(fd, leaf, 0700)) fail("mkdirat");
    close(fd); free(storage); return 0;
  }
  if (!strcmp(op, "move")) {
    char *a, *b, *from, *to;
    int first = parent(path, &a, &from), second = parent(argv[4], &b, &to);
    if (renameat(first, from, second, to)) fail("renameat");
    close(first); close(second); free(a); free(b); return 0;
  }
  if (!strcmp(op, "remove") || !strcmp(op, "remove-recursive")) {
    char *storage, *leaf; int fd = parent(path, &storage, &leaf);
    unsigned budget = 10000;
    remove_entry(fd, leaf, !strcmp(op, "remove-recursive"), 0, &budget);
    close(fd); free(storage); return 0;
  }
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
  if (strcmp(op, "read") && strcmp(op, "write") && strcmp(op, "write-exclusive")) { errno = EINVAL; fail("operation"); }
  char *data = malloc(limit + 1);
  if (!data) fail("allocate");
  size_t size = 0;
  int exclusive = !strcmp(op, "write-exclusive");
  int writing = !strcmp(op, "write") || exclusive;
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
  int fd = beneath(path, (writing ? O_WRONLY | O_CREAT | (exclusive ? O_EXCL : 0) : O_RDONLY) | O_NONBLOCK,
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
