// Linux/glibc-only diagnostic interposer; never preload in performance trials.
// cc -shared -fPIC -O2 native-allocation-probe.c -o /tmp/core-allocation-probe.so
#define _GNU_SOURCE
#include <execinfo.h>
#include <stdlib.h>
#include <stdio.h>
#include <unistd.h>
extern void *__libc_malloc(size_t);
extern void *__libc_calloc(size_t,size_t);
extern void *__libc_realloc(void*,size_t);
static __thread int tracing;
static void trace(size_t size){if(size<32*1024*1024||tracing)return;tracing=1;char b[100];int n=snprintf(b,sizeof(b),"ALLOC pid=%d bytes=%zu\n",getpid(),size);ssize_t written=write(2,b,n);(void)written;void* stack[18];n=backtrace(stack,18);backtrace_symbols_fd(stack,n,2);tracing=0;}
void *malloc(size_t s){trace(s);return __libc_malloc(s);}
void *calloc(size_t n,size_t s){trace(n*s);return __libc_calloc(n,s);}
void *realloc(void*p,size_t s){trace(s);return __libc_realloc(p,s);}
