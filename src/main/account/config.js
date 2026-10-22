import fs from 'node:fs'

// 账号平台（Supabase）的连接信息不进源码：发布的安装包打包时用 electron-builder 的 extraMetadata 写进 package.json 的
// supabase { url, anonKey }，开发时可以用环境变量 MEETCAPTION_SUPABASE_URL / MEETCAPTION_SUPABASE_ANON_KEY。
// 都没有（自己从源码编的版本）就不用账号：不登录、不统计。anon key 是公开的客户端 key，数据安全靠 RLS；service key 绝不进应用。
const pkg = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))
export const SUPABASE_URL = process.env.MEETCAPTION_SUPABASE_URL || pkg.supabase?.url || ''
export const SUPABASE_ANON_KEY = process.env.MEETCAPTION_SUPABASE_ANON_KEY || pkg.supabase?.anonKey || ''

/** 看板（analytics.events）里的产品名。 */
export const PRODUCT = 'meetcaption'

/** 桌面端登录回调：打包版走深链，开发版走本机回环（Supabase Auth 的 Redirect URLs 里两个都加了）。 */
export const SCHEME = 'meetcaption'
export const DEEP_LINK_CALLBACK = 'meetcaption://auth-callback'
export const LOOPBACK_HOST = '127.0.0.1'
export const LOOPBACK_PATH = '/auth-callback'
