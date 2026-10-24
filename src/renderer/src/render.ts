// Ventana oculta que hace de motor de render para las exportaciones.

import { cancelRender, renderJob, type RenderJob } from './engine/ExportRenderer'

window.cancun.render.onCancel((jobId) => cancelRender(jobId))
window.cancun.render.onJob(async (job: RenderJob) => {
  try {
    if (job.sinkPort) {
      // Camino rápido: cuadros directo al socket de ffmpeg; al proceso principal solo el progreso.
      const sink = await window.cancun.render.sinkOpen(job.sinkPort)
      try {
        await renderJob(job, async (data, index) => {
          await window.cancun.render.sinkWrite(sink, data)
          if (index % 5 === 0 || index === job.frames - 1) window.cancun.render.progress(job.jobId, index)
        })
      } finally {
        window.cancun.render.sinkClose(sink)
      }
    } else {
      await renderJob(job, (data, index) => window.cancun.render.frame(job.jobId, data, index))
    }
    window.cancun.render.done(job.jobId)
  } catch (err) {
    window.cancun.render.fail(job.jobId, err instanceof Error ? err.message : String(err))
  }
})
window.cancun.render.ready()
