import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { externalUrl } from '../src/main/externalUrl.js'

test('能打开的网址：https 和不带参数的 mailto 邮箱', () => {
  assert.equal(externalUrl('https://apps.us-cloud.uk'), 'https://apps.us-cloud.uk')
  assert.equal(externalUrl('mailto:infoschaeferanjon@gmail.com'), 'mailto:infoschaeferanjon@gmail.com')
})

test('其他的一律不开：http、file、javascript、带参数或带空格的 mailto、非字符串', () => {
  for (const bad of ['http://a.com', 'file:///etc/passwd', 'javascript:alert(1)', 'mailto:', 'mailto:a', 'mailto:a@b.com?body=x', 'mailto:a@b.com&cc=c@d.com', 'mailto:a@b.com c', 'https://', 'https://a b', 'ftp://a.com', '', null, undefined, 5, {}]) {
    assert.equal(externalUrl(bad), null, String(bad))
  }
})

test('主进程的 shell:openExternal 走 externalUrl，自测时只打印不打开', () => {
  const src = fs.readFileSync(new URL('../src/main/main.js', import.meta.url), 'utf8')
  assert.match(src, /import \{ externalUrl \} from '\.\/externalUrl\.js'/)
  assert.match(src, /ipcMain\.handle\('shell:openExternal', \(_e, url\) => openExternalChecked\(url\)\)/)
  assert.match(src, /function openExternalChecked[\s\S]*?MEETCAPTION_NO_EXTERNAL[\s\S]*?shell\.openExternal\(target\)/)
})
