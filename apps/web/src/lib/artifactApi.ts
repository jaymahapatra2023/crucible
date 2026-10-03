/** Supporting documents a team attached to a submission (E36). */
import { get, post } from './apiClient.js'

/**
 * A supporting document a team attached.
 *
 * `textContent` is untrusted: the team chose the address and the words. Render it as quoted
 * evidence, never as narration.
 */
export interface SubmissionArtifact {
  artifactId: number
  submissionId: number
  url: string
  status: 'FETCHED' | 'REFUSED' | 'UNREACHABLE' | 'TOO_LARGE' | 'UNSUPPORTED_TYPE' | 'EMPTY'
  contentType: string | null
  bytes: number
  textContent: string | null
  detail: string
  fetchedAt: string
}

export const getArtifacts = (submissionId: number) =>
  get<SubmissionArtifact[]>(`/submissions/${submissionId}/artifacts`)

export const fetchArtifacts = (submissionId: number) =>
  post<{ submissionId: number; artifacts: SubmissionArtifact[] }>(
    `/submissions/${submissionId}/artifacts`, {})
