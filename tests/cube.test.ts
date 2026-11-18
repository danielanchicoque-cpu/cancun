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

test('lee .cube con BOM, UTF-16, comentarios al final y filas de más', async () => {
  const { decodeCubeText } = await import('../src/shared/cube.ts')
  const withBom = '﻿' + identity2
  assert.equal(parseCube(withBom).size, 2)
  const utf16 = new Uint8Array([0xff, 0xfe, ...Buffer.from(identity2, 'utf16le')])
  assert.equal(parseCube(decodeCubeText(utf16)).size, 2)
  const commented = identity2.replace('1 1 1\n', '1 1 1 # blanco\n\n0 0 0\n')
  const lut = parseCube(commented)
  assert.equal(lut.data.length, 24)
  assert.equal(lut.data[21], 1)
  const comma = 'LUT_3D_SIZE 2\n' + '0,0 0,0 0,0\n'.repeat(7) + '1,0 1,0 1,0\n'
  assert.equal(parseCube(comma).data[21], 1)
})

test('convierte un filtro PNG (cuadrícula 8×8 de 64³) a LUT y de vuelta a .cube', async () => {
  const { cubeFromImage, serializeCube } = await import('../src/shared/cube.ts')
  // Imagen identidad 512×512: en cada cuadro r→derecha, g→abajo; el azul cambia por cuadro.
  const w = 512
  const px = new Uint8Array(w * w * 4)
  for (let b = 0; b < 64; b++)
    for (let g = 0; g < 64; g++)
      for (let r = 0; r < 64; r++) {
        const x = (b % 8) * 64 + r
        const y = Math.floor(b / 8) * 64 + g
        const i = (y * w + x) * 4
        px[i] = Math.round((r / 63) * 255)
        px[i + 1] = Math.round((g / 63) * 255)
        px[i + 2] = Math.round((b / 63) * 255)
        px[i + 3] = 255
      }
  const lut = cubeFromImage(px, w, w, 'rgba', 'id')!
  assert.equal(lut.size, 64)
  const [r, g, b] = sampleCube(lut, 0.3, 0.6, 0.9)
  assert.ok(Math.abs(r - 0.3) < 0.01 && Math.abs(g - 0.6) < 0.01 && Math.abs(b - 0.9) < 0.01)
  const back = parseCube(serializeCube(lut))
  assert.equal(back.size, 64)
  // Tira horizontal (289×17 = 17³) y algo que no es LUT.
  assert.equal(cubeFromImage(new Uint8Array(289 * 17 * 4), 289, 17)?.size, 17)
  assert.equal(cubeFromImage(new Uint8Array(300 * 200 * 4), 300, 200), null)
})
