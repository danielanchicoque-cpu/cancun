// Ventana oculta que hace de motor de render para las exportaciones.

import { cancelRender, renderJob, type RenderJob } from './engine/ExportRenderer'

window.cancun.render.onCancel((jobId) => cancelRender(jobId))
window.cancun.render.onJob(async (job: RenderJob) => {
  try {
    await renderJob(job, (data, index) => window.cancun.render.frame(job.jobId, data, index))
    window.cancun.render.done(job.jobId)
  } catch (err) {
    window.cancun.render.fail(job.jobId, err instanceof Error ? err.message : String(err))
  }
})
window.cancun.render.ready()
