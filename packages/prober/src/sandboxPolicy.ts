/**
 * The sandbox policy (E05-S01, P8.6).
 *
 * Every control the plan calls non-negotiable is declared here, once, so a reviewer can read the
 * entire security posture on one screen rather than inferring it from scattered flags. E05
 * executes build commands from fifty untrusted repositories; the plan calls this the
 * highest-severity risk in the system and warns it is easy to under-rate because it looks like
 * plumbing.
 */
import type { SandboxPolicy } from './types.js'

export const DEFAULT_POLICY: SandboxPolicy = {
  timeoutMs: 300_000,
  settleSeconds: 10,
  memoryMb: 2048,
  cpus: 2,
  pidsLimit: 256,
  logCapBytes: 256 * 1024,
  // Denied by default (acceptance 3). An allowance is a deliberate act and is recorded.
  egressAllowList: [],
}

/**
 * Docker arguments implementing the policy.
 *
 * Returned as data rather than executed here so the containment tests can assert on the flags
 * directly — a security control nobody can inspect is a security control nobody can verify.
 *
 * `workdir` is the one flag that is not a containment control. The COMMAND path copies the
 * repository to `/work` and needs the container to start there. The DOCKERFILE path must NOT
 * force it: the image declares its own `WORKDIR`, almost always `/app`, and overriding it makes
 * a relative `CMD` such as `["node", "src/server.js"]` unresolvable — the container exits at
 * once and the probe records "built successfully but did not stay running", which is a wrong
 * grade on a dimension the team is judged by. Pass `null` to leave the image's own directory
 * alone. Every other flag here is a control and is applied either way.
 */
export function containmentArgs(
  policy: SandboxPolicy,
  options: { workdir?: string | null } = {},
): string[] {
  const workdir = options.workdir === undefined ? '/work' : options.workdir
  return [
    // One ephemeral container, removed regardless of outcome (acceptance 1).
    '--rm',
    // Network egress denied by default (acceptance 3).
    ...(policy.egressAllowList.length === 0 ? ['--network', 'none'] : []),
    // CPU, memory and PID limits (acceptance 4). PIDs are what stops a fork bomb.
    `--memory=${policy.memoryMb}m`,
    // Equal to memory: no swap, so a memory limit is a real limit rather than a slowdown.
    `--memory-swap=${policy.memoryMb}m`,
    `--cpus=${policy.cpus}`,
    `--pids-limit=${policy.pidsLimit}`,
    // No privilege escalation, no capabilities (acceptance 5, defence in depth per P8.5).
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    // The host's environment, credentials and tokens are unreachable: the container is started
    // with an explicit, minimal environment and nothing is inherited. HOME follows the working
    // directory when we set one, and is /tmp otherwise — a home pointing at a directory the
    // image may not have breaks tools that write there.
    '--env', `HOME=${workdir ?? '/tmp'}`,
    '--env', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    // Untrusted code runs as a non-root user.
    '--user', '1000:1000',
    // Where the container starts. Not a containment control; see the note above.
    ...(workdir === null ? [] : ['--workdir', workdir]),
  ]
}

/** A policy permitting egress to named hosts. The allowance is recorded on the probe. */
export function withEgress(policy: SandboxPolicy, hosts: readonly string[]): SandboxPolicy {
  return { ...policy, egressAllowList: [...hosts] }
}

/**
 * Check a policy is actually restrictive before anything runs.
 *
 * A misconfigured policy is the failure mode that turns this from a sandbox into a shell on the
 * host, and it would not announce itself. Validated rather than trusted.
 */
export function assertPolicySafe(policy: SandboxPolicy): void {
  const problems: string[] = []

  if (policy.timeoutMs <= 0 || policy.timeoutMs > 1_800_000) {
    problems.push('timeoutMs must be between 1 ms and 30 minutes')
  }
  if (policy.memoryMb <= 0 || policy.memoryMb > 16_384) {
    problems.push('memoryMb must be between 1 and 16384')
  }
  if (policy.cpus <= 0 || policy.cpus > 8) problems.push('cpus must be between 0 and 8')
  if (policy.pidsLimit <= 0 || policy.pidsLimit > 4096) {
    problems.push('pidsLimit must be between 1 and 4096')
  }
  if (policy.logCapBytes <= 0) problems.push('logCapBytes must be positive')

  if (problems.length > 0) {
    throw new Error(
      `Refusing to run a probe under an unsafe sandbox policy: ${problems.join('; ')}.`,
    )
  }
}
