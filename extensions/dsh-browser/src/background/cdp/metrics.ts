/**
 * Performance-metric helpers (pure). CDP's Performance.getMetrics returns
 * absolute counters; the model-facing view is the delta over one observation
 * window plus a static summary for window-independent values.
 *
 * @module
 */

import type { MetricSample } from './types.ts'

/** Keep only counters that change meaningfully between two samples. */
export function metricDeltas(before: MetricSample[], after: MetricSample[]): MetricSample[] {
  const afterMap = new Map(after.map((sample) => [sample.name, sample.value]))
  const deltas: MetricSample[] = []
  for (const entry of before) {
    const next = afterMap.get(entry.name)
    if (next === undefined || next < entry.value) continue
    const delta = next - entry.value
    if (delta > 0) deltas.push({ name: entry.name, value: delta })
  }
  return deltas.sort((a, b) => b.value - a.value)
}

/** Render metric deltas as bounded text for the model. */
export function renderMetrics(samples: MetricSample[], maxChars = 2_000): string {
  if (samples.length === 0) return 'No measurable change in browser performance metrics.'
  let output = ''
  for (const sample of samples) {
    const line = `${sample.name}: ${formatMetricValue(sample.value)}`
    if (output.length + line.length + 1 > maxChars) break
    output += `${line}\n`
  }
  return output.trimEnd()
}

export function formatMetricValue(value: number): string {
  const absolute = Math.abs(value)
  if (absolute >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)} GB`
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} MB`
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(2)} kB`
  return value.toFixed(0)
}
