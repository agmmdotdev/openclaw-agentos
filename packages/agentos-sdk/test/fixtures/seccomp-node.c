// Trusted test harness only: exercise the actual filter with native Node without
// claiming Landlock/cgroup enforcement. Never shipped as a production launcher.
#define main production_launcher_main
#include "../../native/launcher.c"
#undef main
int main(int argc, char **argv) {
  if (argc < 2) return 64;
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail("test-no-new-privileges");
  filter();
  execv(argv[1], &argv[1]);
  fail("test-exec");
}
