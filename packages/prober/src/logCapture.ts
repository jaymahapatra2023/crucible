/**
 * Size-capped log capture (E05-S02 acceptance 3).
 *
 * A build log is the only way a reviewer can tell a broken submission from a broken prober
 * (E05-S05), so it is kept — but a runaway build can emit gigabytes, and fifty of them would
 * fill a disk during the run that matters most.
 *
 * When truncating, the head AND tail are kept: the head holds what the build was doing, the tail
 * holds why it stopped. Keeping only the head is the common choice and discards the answer.
 */

export interface CapturedLog {
  text: string
  truncated: boolean
  originalBytes: number
}

export function captureLog(stdout: string, stderr: string, capBytes: number): CapturedLog {
  const combined = [
    stdout.trim() === '' ? '' : `--- stdout ---\n${stdout}`,
    stderr.trim() === '' ? '' : `--- stderr ---\n${stderr}`,
  ].filter(Boolean).join('\n\n')

  const originalBytes = Buffer.byteLength(combined, 'utf8')
  if (originalBytes <= capBytes) {
    return { text: combined, truncated: false, originalBytes }
  }

  const headBytes = Math.floor(capBytes * 0.6)
  const tailBytes = capBytes - headBytes - 200

  const head = combined.slice(0, headBytes)
  const tail = combined.slice(-tailBytes)
  const omitted = originalBytes - headBytes - tailBytes

  return {
    text:
      `${head}\n\n` +
      `... [${omitted.toLocaleString()} bytes omitted — log exceeded the ` +
      `${capBytes.toLocaleString()} byte cap] ...\n\n` +
      `${tail}`,
    truncated: true,
    originalBytes,
  }
}
