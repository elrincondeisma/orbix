/**
 * Genera `resources/trayTemplate.png` (16×16) y `@2x` (32×32).
 *
 * Es una imagen PLANTILLA de macOS: negro puro + alfa. El sistema la invierte solo en
 * modo oscuro y al resaltar el icono, así que aquí solo se dibuja la silueta.
 *
 * Dibujo (04-frontal.md §10.1): la gota de la mascota con dos ojos calados.
 *
 * Sin dependencias: se escribe el PNG a mano con `zlib` (grises + alfa, 8 bits).
 * Ejecutar con:  node scripts/gen-tray-icon.mjs
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources')

/** Muestreo 4×4 por píxel para que los bordes no salgan dentados. */
const SUB = 4

/** ¿Está el punto (x, y) —en coordenadas 0..1— dentro de la gota? */
function inDrop(x, y) {
  // Cuerpo: círculo.
  const cx = 0.5
  const cy = 0.6
  const r = 0.355
  const inBody = (x - cx) ** 2 + (y - cy) ** 2 <= r * r

  // Punta: triángulo isósceles que sube desde el ecuador del círculo.
  const apexY = 0.05
  const baseY = cy
  let inTip = false
  if (y >= apexY && y <= baseY) {
    const t = (y - apexY) / (baseY - apexY) // 0 en la punta, 1 en la base
    const halfWidth = 0.235 * t
    inTip = Math.abs(x - cx) <= halfWidth
  }
  return inBody || inTip
}

/** Los dos ojos calados. */
function inEye(x, y) {
  const r = 0.082
  const eyes = [
    [0.383, 0.585],
    [0.617, 0.585]
  ]
  return eyes.some(([ex, ey]) => (x - ex) ** 2 + (y - ey) ** 2 <= r * r)
}

function render(size) {
  // 2 bytes por píxel (gris + alfa) y 1 byte de filtro por fila.
  const raw = Buffer.alloc(size * (size * 2 + 1))
  let p = 0
  for (let py = 0; py < size; py += 1) {
    raw[p++] = 0 // filtro None
    for (let px = 0; px < size; px += 1) {
      let hits = 0
      for (let sy = 0; sy < SUB; sy += 1) {
        for (let sx = 0; sx < SUB; sx += 1) {
          const x = (px + (sx + 0.5) / SUB) / size
          const y = (py + (sy + 0.5) / SUB) / size
          if (inDrop(x, y) && !inEye(x, y)) hits += 1
        }
      }
      const alpha = Math.round((hits / (SUB * SUB)) * 255)
      raw[p++] = 0 // negro puro: es una plantilla
      raw[p++] = alpha
    }
  }
  return raw
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([len, body, crc])
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return c ^ 0xffffffff
}

function png(size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // profundidad
  ihdr[9] = 4 // gris + alfa
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(render(size), { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Vista previa en ASCII, para poder juzgar el dibujo sin abrir el fichero. */
function preview(size) {
  const ramp = ' .:-=+*#%@'
  const lines = []
  for (let py = 0; py < size; py += 1) {
    let line = ''
    for (let px = 0; px < size; px += 1) {
      let hits = 0
      for (let sy = 0; sy < SUB; sy += 1) {
        for (let sx = 0; sx < SUB; sx += 1) {
          const x = (px + (sx + 0.5) / SUB) / size
          const y = (py + (sy + 0.5) / SUB) / size
          if (inDrop(x, y) && !inEye(x, y)) hits += 1
        }
      }
      const a = hits / (SUB * SUB)
      line += ramp[Math.min(ramp.length - 1, Math.round(a * (ramp.length - 1)))].repeat(2)
    }
    lines.push(line)
  }
  return lines.join('\n')
}

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'trayTemplate.png'), png(16))
writeFileSync(join(OUT_DIR, 'trayTemplate@2x.png'), png(32))
console.log(preview(16))
console.log('\nEscritos resources/trayTemplate.png (16×16) y trayTemplate@2x.png (32×32)')
