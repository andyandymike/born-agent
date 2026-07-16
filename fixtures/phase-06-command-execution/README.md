# Phase 6 offline execution fixture

Every program in this directory is dependency-free and uses only local files,
stdio, timers, and local child processes. None opens a socket, invokes a package
manager, discovers credentials, or calls a remote service. `network-attempt.mjs`
calls the guarded loopback-server API and succeeds only when the preloaded guard
throws before the socket is created. `delete-sentinel.mjs`
exists to demonstrate that an approved repository program can still mutate the
host; acceptance tests never approve or execute it against the checked-in file.
