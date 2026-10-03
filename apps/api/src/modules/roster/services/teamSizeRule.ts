/**
 * The team size rule, declared once (E42-S01, P1.5 clause 6).
 *
 * Two callers with two readings of the same rule, which is exactly why it lives in one place:
 *
 *  - **Public registration REFUSES** a team outside the bounds. The rule is the contract with
 *    entrants, and an endpoint that accepted a team of two would create a dispute nobody could
 *    settle afterwards.
 *  - **An organiser is only WARNED.** A half-formed team at 9am is normal, and a system that
 *    refused to record one would be describing a world that does not exist.
 *
 * Both readings must use the same numbers, or the checklist will pass a team the public endpoint
 * would have rejected. That is the failure this file prevents.
 */
import { AppError } from '../../../lib/appError.js'
import { getNumber } from '../../platform/services/configService.js'

export interface SizeBounds {
  min: number
  max: number
}

export async function teamSizeBounds(): Promise<SizeBounds> {
  return {
    min: await getNumber('roster.min_team_size'),
    max: await getNumber('roster.max_team_size'),
  }
}

export const withinBounds = (size: number, bounds: SizeBounds): boolean =>
  size >= bounds.min && size <= bounds.max

/**
 * Say what is wrong with a size, or null when nothing is.
 *
 * The message names the bound AND the actual count, because "between 3 and 8" without the count
 * leaves the reader to work out which end they failed.
 */
export function sizeProblem(size: number, bounds: SizeBounds): string | null {
  if (withinBounds(size, bounds)) return null
  return `A team needs between ${bounds.min} and ${bounds.max} members; this one has ${size}.`
}

/** The refusing form, for the public path. Throws `UNPROCESSABLE` so the message reaches the team. */
export async function assertTeamSize(size: number): Promise<void> {
  const bounds = await teamSizeBounds()
  const problem = sizeProblem(size, bounds)
  if (problem !== null) throw new AppError('UNPROCESSABLE', problem)
}

/**
 * Whether removing one member would drop a team below the minimum.
 *
 * Checked separately because the interesting case is a team AT the minimum: removing somebody is
 * permitted right up until it would break the rule, and the refusal has to say so rather than
 * reporting the size after the removal it refused to make.
 */
export async function assertCanRemoveMember(currentSize: number): Promise<void> {
  const bounds = await teamSizeBounds()
  if (currentSize - 1 < bounds.min) {
    throw new AppError('UNPROCESSABLE',
      `Removing a member would leave ${currentSize - 1}, and a team needs at least `
      + `${bounds.min}. Add a replacement first, or ask an organiser to dissolve the team.`)
  }
}
