import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell.js'
import { LoadingState } from './components/LoadingState.js'
import { RequireAuth } from './components/RequireAuth.js'

// P5.6 — every page is lazy-loaded.
const RunsPage = lazy(() => import('./pages/RunsPage.js').then((m) => ({ default: m.RunsPage })))
const HealthPage = lazy(() => import('./pages/HealthPage.js').then((m) => ({ default: m.HealthPage })))
const RubricReviewPage = lazy(() => import('./pages/RubricReviewPage.js').then((m) => ({ default: m.RubricReviewPage })))
const IntakePage = lazy(() => import('./pages/IntakePage.js').then((m) => ({ default: m.IntakePage })))
const RosterPage = lazy(() => import('./pages/RosterPage.js').then((m) => ({ default: m.RosterPage })))
const RankingPage = lazy(() => import('./pages/RankingPage.js').then((m) => ({ default: m.RankingPage })))
const SubmissionScorePage = lazy(() => import('./pages/SubmissionScorePage.js').then((m) => ({ default: m.SubmissionScorePage })))
const ScoringRunsPage = lazy(() => import('./pages/ScoringRunsPage.js').then((m) => ({ default: m.ScoringRunsPage })))
const BatchRunPage = lazy(() => import('./pages/BatchRunPage.js').then((m) => ({ default: m.BatchRunPage })))
const ReviewPage = lazy(() => import('./pages/ReviewPage.js').then((m) => ({ default: m.ReviewPage })))
const TeamReviewPage = lazy(() => import('./pages/TeamReviewPage.js').then((m) => ({ default: m.TeamReviewPage })))
const ChallengesPage = lazy(() => import('./pages/ChallengesPage.js').then((m) => ({ default: m.ChallengesPage })))
const CalibrationPage = lazy(() => import('./pages/CalibrationPage.js').then((m) => ({ default: m.CalibrationPage })))
const CataloguePage = lazy(() => import('./pages/CataloguePage.js').then((m) => ({ default: m.CataloguePage })))
const DiscoveryPage = lazy(() => import('./pages/DiscoveryPage.js').then((m) => ({ default: m.DiscoveryPage })))
const NotFoundPage = lazy(() => import('./pages/NotFoundPage.js').then((m) => ({ default: m.NotFoundPage })))
const CoachSheetsPage = lazy(() => import('./pages/CoachSheetsPage.js').then((m) => ({ default: m.CoachSheetsPage })))
const FinalRankingPage = lazy(() => import('./pages/FinalRankingPage.js').then((m) => ({ default: m.FinalRankingPage })))
const SubmitPage = lazy(() => import('./pages/SubmitPage.js').then((m) => ({ default: m.SubmitPage })))
const RegisterPage = lazy(() => import('./pages/RegisterPage.js').then((m) => ({ default: m.RegisterPage })))
const LoginPage = lazy(() => import('./pages/LoginPage.js').then((m) => ({ default: m.LoginPage })))

export function App() {
  return (
    <BrowserRouter>
      <AppShell>
        <Suspense fallback={<LoadingState label="Loading page" />}>
          <Routes>
            <Route path="/" element={<Navigate to="/runs" replace />} />
            <Route path="/login" element={<LoginPage />} />
            {/* Public: teams have no Crucible account by design (P8.2). */}
            <Route path="/submit" element={<SubmitPage />} />
            {/* Public: participants form their own teams through an emailed link (E44). */}
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/runs" element={<RequireAuth><RunsPage /></RequireAuth>} />
            <Route path="/health" element={<RequireAuth><HealthPage /></RequireAuth>} />
            <Route path="/challenges" element={<RequireAuth><ChallengesPage /></RequireAuth>} />
            <Route path="/catalogue" element={<RequireAuth><CataloguePage /></RequireAuth>} />
            <Route path="/calibration" element={<RequireAuth><CalibrationPage /></RequireAuth>} />
            <Route
              path="/submissions/:submissionId/discovery"
              element={<RequireAuth><DiscoveryPage /></RequireAuth>}
            />
            <Route path="/rubrics/:rubricId" element={<RequireAuth><RubricReviewPage /></RequireAuth>} />
            <Route path="/intake" element={<RequireAuth><IntakePage /></RequireAuth>} />
            <Route path="/roster" element={<RequireAuth><RosterPage /></RequireAuth>} />
            <Route path="/scoring" element={<RequireAuth><ScoringRunsPage /></RequireAuth>} />
            <Route path="/scoring/runs/:runId" element={<RequireAuth><RankingPage /></RequireAuth>} />
            <Route path="/scoring/cohorts/:cohortKey/final" element={<RequireAuth><FinalRankingPage /></RequireAuth>} />
            <Route path="/batch/runs/:runId" element={<RequireAuth><BatchRunPage /></RequireAuth>} />
            <Route path="/review/runs/:runId" element={<RequireAuth><ReviewPage /></RequireAuth>} />
            <Route path="/review/runs/:runId/coach-sheets" element={<RequireAuth><CoachSheetsPage /></RequireAuth>} />
            <Route
              path="/review/runs/:runId/teams/:submissionId"
              element={<RequireAuth><TeamReviewPage /></RequireAuth>}
            />
            <Route
              path="/scoring/runs/:runId/submissions/:submissionId"
              element={<RequireAuth><SubmissionScorePage /></RequireAuth>}
            />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </AppShell>
    </BrowserRouter>
  )
}
