import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseCube, sampleCube } from '../src/shared/cube.ts'

const identity2 = `TITLE "id"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n`

test('LUT identidad devuelve el mismo color', () => {
  const lut = parseCube(identity2)
  const [r, g, b] = sampleCube(lut, 0.2, 0.5, 0.9)
  assert.ok(Math.abs(r - 0.2) < 1e-6 && Math.abs(g - 0.5) < 1e-6 && Math.abs(b - 0.9) < 1e-6)
})

test('rechaza archivos incompletos', () => {
  assert.throws(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n'))
})

const capcutLuts = 'C:/Users/USUARIO 1/AppData/Local/CapCut/User Data/Resources/Lut'
test('lee todos los LUT de Daniel en CapCut', { skip: !existsSync(capcutLuts) }, () => {
  let count = 0
  for (const dir of readdirSync(capcutLuts, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    for (const f of readdirSync(join(capcutLuts, dir.name))) {
      if (!f.toLowerCase().endsWith('.cube')) continue
      const lut = parseCube(readFileSync(join(capcutLuts, dir.name, f), 'utf8'))
      assert.ok(lut.size >= 2)
      count++
    }
  }
  assert.ok(count >= 20, `solo ${count} LUTs`)
})

test('los LUT 1D se convierten en 3D', () => {
  const lut = parseCube('LUT_1D_SIZE 2\n0 0 0\n0.5 1 1\n')
  assert.equal(lut.size, 33)
  const [r, g] = sampleCube(lut, 1, 0.5, 0)
  assert.ok(Math.abs(r - 0.5) < 1e-5 && Math.abs(g - 0.5) < 1e-5)
})
