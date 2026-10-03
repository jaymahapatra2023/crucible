/** Challenge and brief API surface (E02-S01, E02-S02, E02-S04). */
import { get, post, uploadFile } from './apiClient.js'

export type ArtifactKind = 'BRIEF' | 'SUPPORTING' | 'RULES' | 'DATA_SAMPLE'

export interface Challenge {
  challengeId: number
  name: string
  slug: string
  description: string
  status: 'DRAFT' | 'OPEN' | 'CLOSED'
  createdAt: string
}

export interface Artifact {
  artifactId: number
  challengeId: number
  kind: ArtifactKind
  filename: string
  mediaType: string
  bytes: number
  extractionStatus: 'PENDING' | 'EXTRACTED' | 'FAILED' | 'UNSUPPORTED'
  extractionError: string | null
  extractedAt: string | null
}

export interface RubricSummary {
  rubricId: string
  version: number
  status: 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'FROZEN' | 'SUPERSEDED'
  criteria: unknown[]
  contentHash: string | null
  publishedAt: string | null
}

export interface GenerationResult {
  rubricId: string
  generated: number
  needsRewrite: number
}

export const listChallenges = () => get<Challenge[]>('/challenges')
export const getChallenge = (id: number) => get<Challenge>(`/challenges/${id}`)

export const createChallenge = (input: { name: string; description: string }) =>
  post<Challenge>('/challenges', input)

export const listArtifacts = (id: number) => get<Artifact[]>(`/challenges/${id}/artifacts`)

/**
 * Upload a brief.
 *
 * Multipart rather than JSON: the server reads the file as a stream with a size cap, and a
 * base64 round-trip through JSON would both inflate it and defeat that cap.
 */
export const uploadArtifact = (id: number, file: File, kind: ArtifactKind = 'BRIEF') =>
  uploadFile<Artifact>(`/challenges/${id}/artifacts`, file, { kind })

export const extractChallenge = (id: number) =>
  post<{ extracted: number; failed: number }>(`/challenges/${id}/extract`)

export const generateRubric = (id: number) =>
  post<GenerationResult>(`/challenges/${id}/rubrics/generate`)

export const listRubrics = (id: number) => get<RubricSummary[]>(`/challenges/${id}/rubrics`)
