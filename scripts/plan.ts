// Herramienta de diagnóstico: imprime el comando de exportación de un proyecto.
import { readFileSync, writeFileSync } from 'node:fs'
import { buildExport } from '../src/shared/exportGraph.ts'
import { normalizeProject } from '../src/shared/project.ts'

const [projectFile, output, filterPath] = process.argv.slice(2)
const p = normalizeProject(JSON.parse(readFileSync(projectFile, 'utf8')))
const plan = buildExport(p, { output, encoder: 'h264_nvenc', filterPath })
writeFileSync(filterPath, plan.filter ?? '')
console.log(JSON.stringify({ args: plan.args, w: plan.width, h: plan.height, frames: plan.frames, fps: plan.fps }))
