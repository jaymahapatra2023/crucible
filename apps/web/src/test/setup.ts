/**
 * Web test setup.
 *
 * Testing Library's automatic cleanup only self-registers when Vitest runs with `globals: true`.
 * This project does not, so cleanup is registered explicitly — without it, renders accumulate in
 * the document and queries start matching elements left behind by earlier tests, which shows up
 * as baffling "found multiple elements" failures in tests that are individually correct.
 */
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
})
