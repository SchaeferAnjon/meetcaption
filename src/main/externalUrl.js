// 界面里的按钮和链接能让系统打开什么：https 网页，和一个不带参数的 mailto 邮箱地址（设置里「关于我们」的发邮件）
export function externalUrl(url) {
  if (typeof url !== 'string') return null
  if (/^https:\/\/\S+$/.test(url)) return url
  if (/^mailto:[^\s@?&#]+@[^\s@?&#]+$/.test(url)) return url
  return null
}
