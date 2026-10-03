/**
 * Base images for the COMMAND path (E05-S03).
 *
 * A team without a Dockerfile must not be disadvantaged (acceptance 1), so a standard image is
 * chosen from the detected stack. When nothing matches, the probe records `UNSUPPORTED_STACK`
 * rather than failing the submission (acceptance 3) — the team did nothing wrong, and scoring a
 * harness limitation against them would be indefensible.
 */

export interface BaseImage {
  language: string
  image: string
  /** Shown to a reviewer so an unexpected image choice is explicable. */
  note: string
}

/** Pinned by digest-free tag but with an explicit version: `latest` would make runs undeterministic. */
export const BASE_IMAGES: readonly BaseImage[] = [
  { language: 'javascript', image: 'node:22-bookworm-slim', note: 'Node.js 22' },
  { language: 'typescript', image: 'node:22-bookworm-slim', note: 'Node.js 22' },
  { language: 'python', image: 'python:3.12-slim-bookworm', note: 'CPython 3.12' },
  { language: 'go', image: 'golang:1.23-bookworm', note: 'Go 1.23' },
  { language: 'rust', image: 'rust:1.82-slim-bookworm', note: 'Rust 1.82' },
  { language: 'java', image: 'eclipse-temurin:21-jdk-jammy', note: 'Temurin JDK 21' },
  { language: 'kotlin', image: 'eclipse-temurin:21-jdk-jammy', note: 'Temurin JDK 21' },
  { language: 'ruby', image: 'ruby:3.3-slim-bookworm', note: 'Ruby 3.3' },
  { language: 'php', image: 'php:8.3-cli-bookworm', note: 'PHP 8.3' },
  { language: 'csharp', image: 'mcr.microsoft.com/dotnet/sdk:8.0', note: '.NET SDK 8' },
  { language: 'elixir', image: 'elixir:1.17-slim', note: 'Elixir 1.17' },
  { language: 'dart', image: 'dart:stable', note: 'Dart stable' },
  { language: 'swift', image: 'swift:5.10', note: 'Swift 5.10' },
]

export function baseImageFor(language: string | undefined): BaseImage | null {
  if (!language) return null
  return BASE_IMAGES.find((b) => b.language === language.toLowerCase()) ?? null
}

export function supportedLanguages(): string[] {
  return [...new Set(BASE_IMAGES.map((b) => b.language))].sort()
}
