import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 录音和关键画面放哪（用户定的「录音存法三选一」）。笔记里的链接三种都一样：库里的 .canvas-notes/录音/<篇>/录音-N.webm，
// 画布笔记照这个路径读；不同的只是 .canvas-notes/录音 这一处是什么：
//   local  —— 库里一个普通文件夹，只在这台 Mac 上（主库的 .gitignore 跳过它，不进 Git）。默认。
//   lfs    —— 库里一个单独的 Git 仓库（「<库名>-录音」，Git LFS 管 *.webm、*.jpg），存好就提交、推到远端；别的设备拉下来只有指针，点 ▶ 才下那一节。
//   icloud —— 一个指向 iCloud 云盘文件夹的替身（符号链接），文件真身在 iCloud 里，跟着 iCloud 同步。
// 存法写进库里 .canvas-notes/meetcaption.json 的 audio（画布笔记按它找、按需下载：lfs 跑 git lfs pull --include，icloud 读 iCloud 那个文件夹）。
// 切换存法：migrate()，有进度、能取消；先拷、核对大小，全部拷好才换过去，原来的那份挪进废纸篓（trash 注入），失败或取消原文件一个不动。

export const AUDIO_DIR = '.canvas-notes/录音'
export const STORES = ['local', 'lfs', 'icloud']
const LFS_HEAD = 'version https://git-lfs.github.com/spec/v1'
const ATTRS = '*.webm filter=lfs diff=lfs merge=lfs -text\n*.jpg filter=lfs diff=lfs merge=lfs -text\n'
const IGNORE = '/.canvas-notes/录音/'
// 从 Dock 打开的应用 PATH 里没有 Homebrew：git-lfs 多半装在这两处
const PATH_EXTRA = ['/opt/homebrew/bin', '/usr/local/bin']

export const icloudDrive = () => path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
export const icloudDefault = (vaultName) => path.join(icloudDrive(), 'MeetCaption 录音', vaultName)

export function gitRun(cwd, args, { timeout = 120_000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const PATH = [...(process.env.PATH ?? '').split(path.delimiter), ...PATH_EXTRA].filter(Boolean).join(path.delimiter)
    execFile('git', args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH, GIT_TERMINAL_PROMPT: '0', ...env } }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(`git ${args[0]}：${String(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`), { stderr }))
      else resolve(stdout)
    })
  })
}

const isLink = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}
const isPointer = (abs) => {
  try {
    const fd = fs.openSync(abs, 'r')
    const b = Buffer.alloc(LFS_HEAD.length)
    fs.readSync(fd, b, 0, b.length, 0)
    fs.closeSync(fd)
    return b.toString('utf8') === LFS_HEAD
  } catch {
    return false
  }
}

/** 一个文件夹下的全部文件（相对路径），跳过 .git 和 .gitattributes */
export function listFiles(root) {
  const out = []
  const walk = (rel) => {
    let ents
    try {
      ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      if (e.name === '.git' || e.name === '.gitattributes' || e.name === '.DS_Store') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(r)
      else if (e.isFile()) out.push(r)
    }
  }
  walk('')
  return out.sort()
}

/** 主库的 .gitignore 跳过录音那一处（三种存法都不让主库提交它） */
export function ensureIgnored(vault) {
  const f = path.join(vault, '.gitignore')
  const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
  if (cur.split(/\r?\n/).some((l) => l.trim() === IGNORE)) return false
  fs.writeFileSync(f, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${IGNORE}\n`)
  return true
}

export class AudioStore {
  /**
   * vault：库的根；cfg：{ mode, remote（lfs 的远端，空就只提交不推）, icloudDir }；
   * trash(abs)：把一个文件夹挪进废纸篓（应用里是 shell.trashItem，测试里挪进临时文件夹）
   */
  constructor({ vault, cfg, trash }) {
    this.vault = vault
    this.cfg = { mode: 'local', remote: '', icloudDir: '', ...cfg }
    this.trash = trash
    this.pushing = Promise.resolve()
    this.lastPush = null // { ok, at, error }
  }

  get root() {
    return path.join(this.vault, AUDIO_DIR)
  }

  icloudDir() {
    return this.cfg.icloudDir || icloudDefault(path.basename(this.vault))
  }

  /** 现在 .canvas-notes/录音 实际是哪种：'icloud'（替身）| 'lfs'（有 .git）| 'local' | null（还没有） */
  actual() {
    if (isLink(this.root)) return 'icloud'
    if (!fs.existsSync(this.root)) return null
    return fs.existsSync(path.join(this.root, '.git')) ? 'lfs' : 'local'
  }

  /** 写录音之前：让这一处是设好的那种（还没有就建；和设的不一样说明迁移没做完，报错不乱动） */
  async prepare() {
    ensureIgnored(this.vault)
    const have = this.actual()
    const want = this.cfg.mode
    if (have && have !== want && !(have === 'local' && want === 'lfs' && !listFiles(this.root).length)) throw new Error(`录音那一处现在是「${have}」，设置里是「${want}」：先在设置里换存法`)
    if (want === 'icloud') {
      if (!have) {
        fs.mkdirSync(this.icloudDir(), { recursive: true })
        fs.mkdirSync(path.dirname(this.root), { recursive: true })
        fs.symlinkSync(this.icloudDir(), this.root, 'dir')
      }
      return
    }
    fs.mkdirSync(this.root, { recursive: true })
    if (want === 'lfs') await this.#initRepo()
  }

  async #initRepo() {
    const r = this.root
    if (!fs.existsSync(path.join(r, '.git'))) {
      await gitRun(r, ['init', '-q'])
      await gitRun(r, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    }
    await gitRun(r, ['lfs', 'install', '--local']).catch((e) => {
      throw new Error(`这台 Mac 上没有 git-lfs（brew install git-lfs）：${e.message}`)
    })
    const attrs = path.join(r, '.gitattributes')
    if (!fs.existsSync(attrs)) fs.writeFileSync(attrs, ATTRS)
    if (!(await gitRun(r, ['config', 'user.email']).catch(() => '')).trim()) {
      await gitRun(r, ['config', 'user.name', 'MeetCaption'])
      await gitRun(r, ['config', 'user.email', 'meetcaption@localhost'])
    }
    const remotes = (await gitRun(r, ['remote'])).split('\n').map((x) => x.trim())
    if (this.cfg.remote) await gitRun(r, remotes.includes('origin') ? ['remote', 'set-url', 'origin', this.cfg.remote] : ['remote', 'add', 'origin', this.cfg.remote])
  }

  /** 写好一批文件之后：lfs 就提交、推（排队，一次一个）；→ 推送的 Promise（不挡着调用的人） */
  saved(message) {
    if (this.cfg.mode !== 'lfs') return Promise.resolve(null)
    this.inflight = (this.inflight ?? 0) + 1
    const p = this.pushing.then(() => this.#commitPush(message)).finally(() => this.inflight--)
    this.pushing = p.catch(() => {})
    return p
  }

  async #commit(message) {
    const r = this.root
    // 只加不删：别的设备录的、这台 Mac 上还是指针或者没拉下来的，不能因为这里没有就提交成删掉
    await gitRun(r, ['add', '--ignore-removal', '.'])
    const staged = (await gitRun(r, ['diff', '--cached', '--name-only'])).trim()
    if (staged) await gitRun(r, ['commit', '-q', '-m', message])
  }

  /**
   * 和远端对齐（推送被拒、刚建的仓库对着已有历史的远端）：拉下来（只拿指针，旧录音不自动下载），
   * 有共同历史就 rebase 上去；没有（这台 Mac 上新建的仓库）就把本地这些文件当成远端之上的一次提交
   */
  async #sync() {
    const r = this.root
    const skip = { env: { GIT_LFS_SKIP_SMUDGE: '1' }, timeout: 10 * 60_000 }
    await gitRun(r, ['fetch', '-q', 'origin'], skip)
    if (!(await gitRun(r, ['rev-parse', '--verify', '-q', 'origin/main']).catch(() => '')).trim()) return
    const head = (await gitRun(r, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim()
    if (head && (await gitRun(r, ['merge-base', '--is-ancestor', 'origin/main', 'HEAD']).then(() => true, () => false))) return
    const base = head ? (await gitRun(r, ['merge-base', 'origin/main', 'HEAD']).catch(() => '')).trim() : ''
    if (base) return void (await gitRun(r, ['rebase', '-q', 'origin/main'], skip))
    await gitRun(r, ['reset', '-q', '--mixed', 'origin/main'])
    const gone = (await gitRun(r, ['ls-files', '--deleted', '-z'])).split('\0').filter(Boolean)
    for (let i = 0; i < gone.length; i += 200) await gitRun(r, ['checkout', '--', ...gone.slice(i, i + 200)], skip)
    await this.#commit('录音：接上远端')
  }

  async #commitPush(message, onProgress) {
    const r = this.root
    await this.#commit(message)
    if (!this.cfg.remote) return (this.lastPush = { ok: true, at: Date.now(), pushed: false })
    onProgress?.({ phase: 'push', done: 0, total: 1 })
    const push = () => gitRun(r, ['push', '-q', '-u', 'origin', 'HEAD:main'], { timeout: 30 * 60_000 })
    try {
      await push().catch(async (e) => {
        if (!/rejected|fetch first|non-fast-forward/i.test(String(e.stderr ?? e.message))) throw e
        await this.#sync()
        await push()
      })
      this.lastPush = { ok: true, at: Date.now(), pushed: true }
    } catch (e) {
      this.lastPush = { ok: false, at: Date.now(), error: e.message }
      throw e
    }
    onProgress?.({ phase: 'push', done: 1, total: 1 })
    return this.lastPush
  }

  /** 换成 lfs 之后推一次：推不上去（没网、远端不对）不算没换成，记在 lastPush 里，下次存录音、打开应用再推 */
  async #tryPush(onProgress) {
    try {
      await this.#commitPush('录音：换成 Git LFS 存', onProgress)
      return {}
    } catch (e) {
      return { pushError: e.message }
    }
  }

  /**
   * 换存法。to：'local' | 'lfs' | 'icloud'；next：新的 { remote, icloudDir }；
   * onProgress({ phase: 'download' | 'copy' | 'commit' | 'push', done, total, file })；signal：AbortSignal（拷的时候一个文件一查）。
   * → { files, moved }；取消抛 code 'cancelled'。
   */
  async migrate(to, next = {}, { onProgress = () => {}, signal } = {}) {
    if (!STORES.includes(to)) throw new Error(`不认识的存法 ${to}`)
    const from = this.actual() ?? this.cfg.mode
    const target = new AudioStore({ vault: this.vault, cfg: { ...this.cfg, ...next, mode: to }, trash: this.trash })
    const check = () => {
      if (signal?.aborted) throw Object.assign(new Error('已取消'), { code: 'cancelled' })
    }
    await this.pushing
    if (!fs.existsSync(this.root) && !isLink(this.root)) {
      this.cfg = target.cfg
      await this.prepare()
      return { files: 0, moved: false }
    }
    const files = listFiles(this.root)
    // lfs 里还是指针的（别的设备录的、没下过的）先下下来，不然拷过去的只是指针
    if (from === 'lfs' && to !== 'lfs') {
      const ptrs = files.filter((f) => isPointer(path.join(this.root, f)))
      if (ptrs.length) {
        onProgress({ phase: 'download', done: 0, total: ptrs.length })
        await gitRun(this.root, ['lfs', 'pull'], { timeout: 60 * 60_000 })
        const still = ptrs.filter((f) => isPointer(path.join(this.root, f)))
        if (still.length) throw new Error(`有 ${still.length} 段录音下不下来，没换`)
        onProgress({ phase: 'download', done: ptrs.length, total: ptrs.length })
      }
    }
    check()
    if (from === to) {
      this.cfg = target.cfg
      if (to === 'lfs') {
        await this.#initRepo()
        return { files: files.length, moved: false, ...(await this.#tryPush(onProgress)) }
      }
      return { files: files.length, moved: false }
    }
    const sameRoot = from !== 'icloud' && to !== 'icloud' // local ↔ lfs：文件就在原地
    if (sameRoot) {
      if (to === 'lfs') {
        this.cfg = target.cfg
        try {
          await this.#initRepo()
          onProgress({ phase: 'commit', done: 0, total: files.length })
          check()
          await this.#commit('录音：换成 Git LFS 存')
          onProgress({ phase: 'commit', done: files.length, total: files.length })
        } catch (e) {
          // 推不上去或取消：退回只存本机，仓库挪进废纸篓（文件一直在原地）
          await this.trash(path.join(this.root, '.git'))
          fs.rmSync(path.join(this.root, '.gitattributes'), { force: true })
          this.cfg = { ...this.cfg, mode: from }
          throw e
        }
        return { files: files.length, moved: false, ...(await this.#tryPush(onProgress)) }
      } else {
        await this.trash(path.join(this.root, '.git'))
        fs.rmSync(path.join(this.root, '.gitattributes'), { force: true })
        this.cfg = target.cfg
      }
      return { files: files.length, moved: false }
    }
    // 要拷：先拷进新地方（icloud 是那个文件夹；拷回库里时先拷进旁边的临时文件夹），全部核对完再换
    const dest = to === 'icloud' ? target.icloudDir() : path.join(this.vault, '.canvas-notes', '录音.迁移中')
    const made = []
    try {
      fs.mkdirSync(dest, { recursive: true })
      for (const [i, f] of files.entries()) {
        check()
        onProgress({ phase: 'copy', done: i, total: files.length, file: f })
        const src = path.join(this.root, f)
        const dst = path.join(dest, f)
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        if (!(fs.existsSync(dst) && fs.statSync(dst).size === fs.statSync(src).size)) {
          await fs.promises.copyFile(src, dst + '.拷贝中')
          made.push(dst + '.拷贝中')
          fs.renameSync(dst + '.拷贝中', dst)
          made[made.length - 1] = dst
        }
        if (fs.statSync(dst).size !== fs.statSync(src).size) throw new Error(`${f} 拷过去大小不对`)
      }
      check()
      onProgress({ phase: 'copy', done: files.length, total: files.length })
    } catch (e) {
      for (const f of made) fs.rmSync(f, { force: true })
      if (to !== 'icloud') fs.rmSync(dest, { recursive: true, force: true })
      throw e
    }
    // 换过去：原来的那份挪进废纸篓（iCloud 那份不动，留在 iCloud 里）
    if (from === 'icloud') fs.unlinkSync(this.root)
    else await this.trash(this.root)
    if (to === 'icloud') fs.symlinkSync(dest, this.root, 'dir')
    else fs.renameSync(dest, this.root)
    this.cfg = target.cfg
    if (to === 'lfs') {
      await this.#initRepo()
      await this.#commit('录音：换成 Git LFS 存')
      return { files: files.length, moved: true, ...(await this.#tryPush(onProgress)) }
    }
    return { files: files.length, moved: true }
  }
}
