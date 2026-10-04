/**
 * What the entry form refuses, and what it merely warns about (E03-S01).
 *
 * The split is the whole design. Both of the first two entries at codeLinc 11 scored zero on the
 * Runs dimension because of this form rather than their code: one pointed `npm install` at a
 * directory with no manifest, the other pasted README instructions into the command box. Neither
 * had any way of knowing, and both were a minute's work to fix.
 *
 * So these checks exist — and they WARN. A guess about intent that stops a team submitting at
 * four in the morning is worse than the mistake it prevents.
 */
import { describe, expect, it } from 'vitest'
import { submissionProblems, submissionWarnings, type SubmissionDraft } from './submitApi.js'

const draft = (over: Partial<SubmissionDraft> = {}): SubmissionDraft => ({
  contactEmail: 'team@example.test', challengeId: 1,
  repoUrl: 'https://github.com/team/project', buildMethod: 'COMMAND',
  buildCommand: 'npm ci && npm start', artifactUrls: [], ...over,
})

describe('what blocks an entry', () => {
  it('refuses a Dockerfile path the prober would refuse anyway', () => {
    // Left unchecked these become UNSUPPORTED_STACK after the deadline, which reads to a
    // reviewer as "we have no recipe for this stack" rather than "the path was wrong".
    for (const dockerfilePath of ['/etc/Dockerfile', '../Dockerfile', 'a/../../Dockerfile']) {
      const problems = submissionProblems(draft({ buildMethod: 'DOCKERFILE', dockerfilePath }), 'tok')
      expect(problems.join(' '), dockerfilePath).toMatch(/must be inside the repository/)
    }
  })

  it('accepts an ordinary Dockerfile path, at the root or not', () => {
    for (const dockerfilePath of ['Dockerfile', 'backend/Dockerfile', 'infra/docker/api.Dockerfile']) {
      expect(submissionProblems(draft({ buildMethod: 'DOCKERFILE', dockerfilePath }), 'tok'))
        .toEqual([])
    }
  })

  it('still asks for the things it always asked for', () => {
    expect(submissionProblems(draft({ buildMethod: 'COMMAND', buildCommand: '' }), 'tok').join(' '))
      .toMatch(/command that builds and starts/)
    expect(submissionProblems(draft(), '').join(' ')).toMatch(/submission token/)
  })
})

describe('what is only a warning', () => {
  it('catches the pasted-instructions command that cost a real entry its score', () => {
    const buildCommand = 'Frontend: cd apps/web && npm install && npm run build '
      + 'Backend: Install and build: pip install -r apps/api/requirements.txt '
      + 'Start: cd apps/api && uvicorn main:app --host 0.0.0.0 --port $PORT'
    const warnings = submissionWarnings(draft({ buildCommand }))
    expect(warnings.join(' ')).toMatch(/looks like instructions rather than one command/)
    // And it does NOT block: the team can still send it if they mean it.
    expect(submissionProblems(draft({ buildCommand }), 'tok')).toEqual([])
  })

  it('catches PROSE WITH NO COLONS, which the first version let through', () => {
    // Verbatim from a third entry. No label, no newline, and a first word that looks like a
    // program, so every rule written for the previous team missed it.
    const buildCommand = 'select the index.html inside of the lifemap-ai folder, '
      + 'then run "npm run api"'
    expect(submissionWarnings(draft({ buildCommand })).join(' '))
      .toMatch(/looks like instructions rather than one command/)
  })

  it('needs TWO English words, so an honestly-named path does not trip it', () => {
    // One such word can appear in a real command; a sentence has several.
    for (const buildCommand of [
      'cd the-api && npm start',
      'node open-server.js',
      'python select_rows.py',
      'npm run build --prefix your-app',
    ]) {
      expect(submissionWarnings(draft({ buildCommand })), buildCommand).toEqual([])
    }
  })

  it('catches a label as the very first word, and a command spread over lines', () => {
    expect(submissionWarnings(draft({ buildCommand: 'Start: npm start' })).join(' '))
      .toMatch(/looks like instructions/)
    expect(submissionWarnings(draft({ buildCommand: 'npm ci\nnpm start' })).join(' '))
      .toMatch(/looks like instructions/)
  })

  it('does NOT warn on a bare npm command, however tempting that check was', () => {
    // It was written, and it fired on `npm ci && npm run build && npm start` — correct, and what
    // most teams type. A panel that appears for most entries teaches people to dismiss it, and
    // then the one precise check above is lost too. Where the manifest lives is a field hint.
    expect(submissionWarnings(draft({ buildCommand: 'npm install && npm run dev' }))).toEqual([])
  })

  it('says NOTHING about an ordinary command', () => {
    for (const buildCommand of [
      'npm ci && npm run build && npm start',
      'cd frontend && npm ci && npm start',
      './gradlew bootRun',
      'make run',
      'python -m uvicorn app.main:app --host 0.0.0.0 --port 8000',
    ]) {
      expect(submissionWarnings(draft({ buildCommand })), buildCommand).toEqual([])
    }
  })

  it('says nothing at all on the Dockerfile path — these checks are about commands', () => {
    expect(submissionWarnings(draft({
      buildMethod: 'DOCKERFILE', dockerfilePath: 'Dockerfile', buildCommand: 'Start: whatever',
    }))).toEqual([])
  })

  it('says nothing for an empty command — that is the blocking panel’s job', () => {
    expect(submissionWarnings(draft({ buildCommand: '' }))).toEqual([])
  })
})
