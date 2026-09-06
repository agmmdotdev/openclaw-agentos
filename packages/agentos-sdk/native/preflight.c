// Read-only capability probe. This does not install policies or grant privileges.
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <unistd.h>
#include <sys/syscall.h>
int main(void) {
#ifdef SYS_landlock_create_ruleset
  errno = 0;
  long abi = syscall(SYS_landlock_create_ruleset, NULL, 0, 1);
  int error = abi < 0 ? errno : 0;
  printf("{\"landlockAbi\":%ld,\"landlockErrno\":%d}\n", abi, error);
#else
  printf("{\"landlockAbi\":-1,\"landlockErrno\":38}\n");
#endif
  return 0;
}
