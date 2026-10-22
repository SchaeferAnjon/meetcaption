'use strict'
// 待办：所有项目的待办，按已逾期、今天、本周、以后、没有截止分组；可按项目筛选，默认隐藏已完成。

const TODO_FILTER = 'meetcaption.todos.project'
const TODO_DONE = 'meetcaption.todos.done'

VIEWS.todos = {
  mount(ctx) {
    let projectId = store(TODO_FILTER) || ''
    if (projectId && !projectOf(projectId)) projectId = ''
    let includeDone = store(TODO_DONE) === '1'

    const filter = ui.select({
      options: filterOptions(),
      value: projectId,
      width: 170,
      ariaLabel: '按项目筛选',
      onChange: (v) => {
        projectId = v
        store(TODO_FILTER, v || null)
        load()
      },
    })
    const doneToggle = ui.toggle({
      size: 'sm',
      checked: includeDone,
      label: '显示已完成',
      onChange: (v) => {
        includeDone = v
        store(TODO_DONE, v ? '1' : null)
        load()
      },
    })
    doneToggle.classList.add('header-toggle')
    doneToggle.title = '显示已完成'
    const count = el('span.count.num')
    ctx.header({ crumbs: [el('span.crumb.crumb-title', {}, '待办', count)], actions: [filter, doneToggle] })

    const list = el('div.list', { role: 'listbox', 'aria-label': '待办' })
    const hint = el('div.panel-toolbar.todos-hint', {}, el('span.text-2.text-sm', { text: '回车打开来源会议，空格勾选。点项目标签可以改归属。' }))
    const page = el('div.page.todos-page', {}, hint, list)
    ctx.body.append(el('div.pane-body', {}, page))
    const nav = navList(list, { onSelect: (item) => ctx.setParam('sel', item.dataset.id) })
    wireTodoKeys(list, nav)
    ctx.dispose(() => nav.destroy())

    function filterOptions() {
      return [{ value: '', label: '全部项目', icon: 'list-todo' }, ...state.projects.map((p) => ({ value: p.id, label: p.archived ? `${p.name}（已归档）` : p.name, icon: projectIconName(p), tint: projectTint(p) }))]
    }

    async function load() {
      const items = await call('listTodos', { projectId: projectId || undefined, includeDone })
      if (!ctx.alive()) return
      const keep = nav.selected()?.dataset.id ?? ctx.params.sel
      ui.clear(list)
      if (!Array.isArray(items)) {
        list.append(ui.emptyState({ icon: 'circle-alert', title: '读不到待办', description: items?.error }))
        return
      }
      const open = items.filter((t) => !t.done).length
      count.textContent = open ? String(open) : ''
      hint.hidden = !items.length
      if (!items.length) {
        list.append(
          ui.emptyState({
            icon: 'circle-check',
            title: projectId ? `「${projectName(projectId)}」没有要做的事` : '没有要做的事',
            description: '会后生成纪要时，AI 会把待办和 DDL 提取出来，每条归到对应的项目。',
          }),
        )
        return
      }
      renderTodoGroups(list, items, { showSource: true, showProject: !projectId })
      nav.refresh(keep)
      if (document.activeElement !== list && !ctx.params.sel) nav.select(-1)
    }

    const loadSoon = debounce(load, 250)
    load()
    ctx.on('todos', loadSoon)
    ctx.on('sessions', loadSoon)
    ctx.on('projects', () => {
      if (projectId && !projectOf(projectId)) {
        projectId = ''
        store(TODO_FILTER, null)
      }
      filter.setOptions(filterOptions(), projectId)
      loadSoon()
    })
    return { focus: () => list.focus({ preventScroll: true }) }
  },
}
