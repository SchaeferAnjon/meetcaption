import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { probeSystemAudioOnce } from '../src/main/audio/macTap.js'

// 引导重开后真查一次电脑声音能不能录：起一次 audiotee，出了数据才算能录

function fakeProc() {
  const p = new EventEmitter()
  p.stdout = new PassThrough()
  p.stderr = new PassThrough()
  p.exitCode = null
  p.signalCode = null
  p.kill = () => {
    p.killed = true
  }
  return p
}

test('电脑声音探测：出了数据 → granted，探完关掉 audiotee', async () => {
  const p = fakeProc()
  const r = probeSystemAudioOnce({ timeoutMs: 2000, spawnTap: () => p })
  p.stdout.write(Buffer.alloc(320))
  assert.equal(await r, 'granted')
  assert.ok(p.killed)
})

test('电脑声音探测：没授权时 audiotee 一个字节都不给 → 超时 denied（不假装能用）', async () => {
  const p = fakeProc()
  const t0 = Date.now()
  assert.equal(await probeSystemAudioOnce({ timeoutMs: 150, spawnTap: () => p }), 'denied')
  assert.ok(Date.now() - t0 >= 140)
  assert.ok(p.killed)
})

test('电脑声音探测：audiotee 报错或起不来 → denied，后面再报错也不抛', async () => {
  const p = fakeProc()
  const r = probeSystemAudioOnce({ timeoutMs: 2000, spawnTap: () => p })
  p.stderr.write(`${JSON.stringify({ message_type: 'error', data: { message: 'permission denied' } })}\n`)
  assert.equal(await r, 'denied')
  p.stderr.write(`${JSON.stringify({ message_type: 'error', data: { message: 'again' } })}\n`)
  await new Promise((res) => setTimeout(res, 30))

  const q = fakeProc()
  const r2 = probeSystemAudioOnce({ timeoutMs: 2000, spawnTap: () => q })
  q.emit('error', new Error('spawn ENOENT'))
  assert.equal(await r2, 'denied')
})

test('引导：重开后电脑声音不再直接当成已允许，要等探测结果；录屏看系统的授权状态', () => {
  const src = fs.readFileSync(new URL('../src/renderer/onboarding/app.js', import.meta.url), 'utf8')
  const boot = src.match(/for \(const k of ob\.inList \?\? \[\]\) \{[\s\S]*?\n  \}\n/)[0]
  assert.doesNotMatch(boot, /S\.sys = 'ok'/, '重开后不能没查就写已允许')
  assert.match(boot, /S\.sys = 'checking'/)
  assert.match(src, /S\.sys = \(await api\.probeSystemAudio\(\)\) === 'granted' \? 'ok' : 'noeffect'/)
  const main = fs.readFileSync(new URL('../src/main/main.js', import.meta.url), 'utf8')
  assert.match(main, /ipcMain\.handle\('permission:probeSystemAudio'/)
  const preload = fs.readFileSync(new URL('../src/preload/control.cjs', import.meta.url), 'utf8')
  assert.match(preload, /probeSystemAudio: invoke\('permission:probeSystemAudio'\)/)
})
