#include <net/if.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

/* Trusted PID 1 calls this before customer code. No configurable interface. */
int main(void) {
  struct ifreq interface = { .ifr_name = "lo" };
  int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  if (fd == -1) {
    perror("loopback socket");
    return 1;
  }
  if (ioctl(fd, SIOCGIFFLAGS, &interface) == -1) {
    perror("read loopback flags");
    close(fd);
    return 1;
  }
  interface.ifr_flags |= IFF_UP;
  if (ioctl(fd, SIOCSIFFLAGS, &interface) == -1) {
    perror("raise loopback");
    close(fd);
    return 1;
  }
  return close(fd) == 0 ? 0 : 1;
}
