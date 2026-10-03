/**
 * Prometheus metrics (P9.3, P9.5).
 *
 * Unauthenticated by scrape convention — scrapers carry no JWT — and therefore deliberately
 * carries no submission, team or score data. It exposes counts and latencies only.
 */
import type { FastifyInstance } from 'fastify'
import { query } from '../../../db/pool.js'
import { createLogger } from '../../../lib/logger.js'

const log = createLogger('platform', 'metrics')

interface Metric {
  name: string
  help: string
  type: 'counter' | 'gauge'
  samples: Array<{ labels: Record<string, string>; value: number }>
}

function render(metrics: Metric[]): string {
  const lines: string[] = []
  for (const m of metrics) {
    lines.push(`# HELP ${m.name} ${m.help}`)
    lines.push(`# TYPE ${m.name} ${m.type}`)
    for (const s of m.samples) {
      const labels = Object.entries(s.labels)
        .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
        .join(',')
      lines.push(`${m.name}${labels ? `{${labels}}` : ''} ${s.value}`)
    }
  }
  return lines.join('\n') + '\n'
}

export async function registerMetricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/metrics', async (_req, reply) => {
    const metrics: Metric[] = []

    try {
      const runs = await query<{ status: string; n: number }>(
        'SELECT status, COUNT(*)::int AS n FROM run GROUP BY status',
      )
      metrics.push({
        name: 'crucible_runs_total',
        help: 'Evaluation runs by status.',
        type: 'gauge',
        samples: runs.rows.map((r) => ({ labels: { status: r.status }, value: r.n })),
      })

      const calls = await query<{ call_key: string; status: string; n: number; p99: number }>(
        `SELECT call_key, status, COUNT(*)::int AS n,
                COALESCE(percentile_disc(0.99) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p99
           FROM llm_call_log WHERE at > now() - interval '1 hour'
          GROUP BY call_key, status`,
      )
      metrics.push({
        name: 'crucible_llm_calls_total',
        help: 'LLM calls in the last hour, by call key and status (P9.3).',
        type: 'counter',
        samples: calls.rows.map((r) => ({
          labels: { call_key: r.call_key, status: r.status }, value: r.n,
        })),
      })
      metrics.push({
        name: 'crucible_llm_latency_p99_ms',
        help: 'P99 latency per call key over the last hour (P9.3).',
        type: 'gauge',
        samples: calls.rows.map((r) => ({ labels: { call_key: r.call_key }, value: r.p99 })),
      })
    } catch (err) {
      log.error('metrics collection failed', { err })
      reply.status(503).type('text/plain').send('# metrics unavailable\n')
      return
    }

    reply.type('text/plain; version=0.0.4').send(render(metrics))
  })
}
