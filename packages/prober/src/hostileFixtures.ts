/**
 * Deliberately hostile submissions, for verifying containment (E05-S01 acceptance 6, P8.6).
 *
 * These are **real attacks**, not simulations. A fixture that only pretends to fork-bomb proves
 * nothing about the PID limit, and P8.6 is explicit that a green suite without genuine
 * containment evidence "is not evidence of anything".
 *
 * Every one of these is expected to be *contained*, not to fail: a fork bomb that is stopped by
 * the PID limit is a pass. The test asserts the host is unaffected.
 */

export interface HostileFixture {
  name: string
  /** What it attempts, and which control is expected to stop it. */
  attack: string
  expectedControl: string
  files: Record<string, string>
  buildCommand: string
  language: string
}

/** Attempts to reach the network — blocked by `--network none`. */
export const networkCalloutFixture: HostileFixture = {
  name: 'network-callout',
  attack: 'Exfiltrates the working directory to an external host during the build.',
  expectedControl: '--network none',
  language: 'python',
  buildCommand: 'python3 exfiltrate.py',
  files: {
    'exfiltrate.py': [
      'import socket, sys',
      '',
      '# Try several ways out. Every one must fail.',
      'targets = [("example.com", 80), ("1.1.1.1", 53), ("169.254.169.254", 80)]',
      'reached = []',
      'for host, port in targets:',
      '    try:',
      '        s = socket.create_connection((host, port), timeout=3)',
      '        s.close()',
      '        reached.append(f"{host}:{port}")',
      '    except Exception as e:',
      '        print(f"blocked {host}:{port} -> {type(e).__name__}")',
      '',
      'if reached:',
      '    print("ESCAPED: reached " + ", ".join(reached))',
      '    sys.exit(0)',
      'print("CONTAINED: no egress")',
      'sys.exit(1)',
    ].join('\n'),
  },
}

/** Attempts to exhaust process slots — blocked by `--pids-limit`. */
export const forkBombFixture: HostileFixture = {
  name: 'fork-bomb',
  attack: 'Spawns processes without bound, to exhaust the host process table.',
  expectedControl: '--pids-limit',
  language: 'python',
  buildCommand: 'python3 fork.py',
  files: {
    'fork.py': [
      'import os, sys',
      '',
      'spawned = 0',
      'try:',
      '    while spawned < 100000:',
      '        pid = os.fork()',
      '        if pid == 0:',
      '            # Child: hold a slot and exit only when killed.',
      '            while True:',
      '                pass',
      '        spawned += 1',
      'except Exception as e:',
      '    print(f"CONTAINED: fork refused after {spawned} -> {type(e).__name__}")',
      '    sys.exit(1)',
      'print(f"ESCAPED: spawned {spawned} processes")',
      'sys.exit(0)',
    ].join('\n'),
  },
}

/** Attempts to write outside the container — blocked by having no host mount. */
export const hostWriteFixture: HostileFixture = {
  name: 'host-write',
  attack: 'Writes to paths that would be the host filesystem if anything were mounted.',
  expectedControl: 'no host filesystem mount; repository copied in',
  language: 'python',
  buildCommand: 'python3 escape.py',
  files: {
    'escape.py': [
      'import os, sys',
      '',
      '# Host locations, named explicitly. NOT "~": the sandbox sets HOME to the working',
      '# directory on purpose, so expanduser points at /work — the container\'s own copy of the',
      '# repository, which a build command is supposed to be able to write to. Testing that',
      '# path asserted nothing about the host, and it passed only while a permissions defect',
      '# made /work unwritable; when that was fixed, this fixture reported an escape that had',
      '# not happened.',
      'targets = [',
      '    "/etc/crucible-escaped",',
      '    "/host/crucible-escaped",',
      '    "/var/run/docker.sock",',
      '    "/root/crucible-escaped",',
      '    "/home/crucible-escaped",',
      '    "/Users/crucible-escaped",',
      '    "/proc/sysrq-trigger",',
      ']',
      'written = []',
      'for target in targets:',
      '    try:',
      '        with open(target, "w") as handle:',
      '            handle.write("escaped")',
      '        written.append(target)',
      '    except Exception as e:',
      '        print(f"blocked {target} -> {type(e).__name__}")',
      '',
      '# The docker socket is the prize: reaching it means full host control.',
      'if os.path.exists("/var/run/docker.sock"):',
      '    print("ESCAPED: docker socket is present in the container")',
      '    sys.exit(0)',
      '',
      'if written:',
      '    print("ESCAPED: wrote " + ", ".join(written))',
      '    sys.exit(0)',
      'print("CONTAINED: no host path was writable")',
      'sys.exit(1)',
    ].join('\n'),
  },
}

/** Attempts to read the operator's environment — blocked by the minimal explicit env. */
export const credentialTheftFixture: HostileFixture = {
  name: 'credential-theft',
  attack: 'Reads the process environment looking for tokens belonging to the host.',
  expectedControl: 'explicit minimal environment; nothing inherited',
  language: 'python',
  buildCommand: 'python3 steal.py',
  files: {
    'steal.py': [
      'import os, sys',
      '',
      '# Variables that come from the base image or from the shell that runs the command.',
      '# Neither is inherited from the host, so finding them is not an escape. Listing them',
      '# explicitly keeps the test honest: anything NOT on this list came from somewhere else.',
      'EXPECTED = {',
      '    # Set by the shell itself when the command does `cd /work`.',
      '    "PWD", "OLDPWD", "SHLVL", "_",',
      '    "GPG_KEY", "PYTHON_VERSION", "PYTHON_SHA256", "PYTHON_PIP_VERSION",',
      '    "PYTHON_SETUPTOOLS_VERSION", "PYTHON_GET_PIP_URL", "PYTHON_GET_PIP_SHA256",',
      '    "LANG", "LC_ALL", "PATH", "HOME", "HOSTNAME", "TERM",',
      '    "NODE_VERSION", "YARN_VERSION", "GOLANG_VERSION", "GOPATH", "GOTOOLCHAIN",',
      '    "RUST_VERSION", "RUSTUP_HOME", "CARGO_HOME", "JAVA_HOME", "JAVA_VERSION",',
      '    "RUBY_VERSION", "RUBY_MAJOR", "RUBY_DOWNLOAD_SHA256", "BUNDLE_SILENCE_ROOT_WARNING",',
      '    "PHP_VERSION", "PHP_INI_DIR", "PHPIZE_DEPS", "PHP_LDFLAGS", "PHP_CFLAGS",',
      '    "PHP_CPPFLAGS", "PHP_SHA256", "PHP_URL", "PHP_ASC_URL", "DEBIAN_FRONTEND",',
      '}',
      '',
      '# A canary the harness sets on the HOST process before running this probe. If it is',
      '# visible in here, the container inherited the host environment.',
      'CANARY = "CRUCIBLE_HOST_CANARY"',
      '',
      'leaked = sorted(k for k in os.environ if k not in EXPECTED)',
      '',
      'if CANARY in os.environ:',
      '    print("ESCAPED: the host canary is visible inside the container")',
      '    sys.exit(0)',
      'if leaked:',
      '    print("ESCAPED: unexpected variables present -> " + ", ".join(leaked))',
      '    sys.exit(0)',
      '',
      'print("CONTAINED: nothing beyond the base image is visible")',
      'print("visible:", sorted(os.environ.keys()))',
      'sys.exit(1)',
    ].join('\n'),
  },
}

/** Attempts to consume unbounded memory — blocked by `--memory`. */
export const memoryBombFixture: HostileFixture = {
  name: 'memory-bomb',
  attack: 'Allocates without bound, to exhaust host memory.',
  expectedControl: '--memory with --memory-swap equal',
  language: 'python',
  buildCommand: 'python3 balloon.py',
  files: {
    'balloon.py': [
      'import sys',
      '',
      'chunks = []',
      'try:',
      '    while len(chunks) < 20000:',
      '        chunks.append(bytearray(10 * 1024 * 1024))',
      'except MemoryError:',
      '    print(f"CONTAINED: memory refused after {len(chunks) * 10} MB")',
      '    sys.exit(1)',
      'print("ESCAPED: allocated 200 GB")',
      'sys.exit(0)',
    ].join('\n'),
  },
}

export const HOSTILE_FIXTURES: readonly HostileFixture[] = [
  networkCalloutFixture,
  forkBombFixture,
  hostWriteFixture,
  credentialTheftFixture,
  memoryBombFixture,
]

/** A submission that behaves normally, as the control case. */
export const benignFixture = {
  name: 'benign',
  language: 'python',
  buildCommand: 'python3 build.py',
  files: {
    'build.py': 'print("built successfully")\n',
    'README.md': '# A well-behaved submission\n',
  },
}
