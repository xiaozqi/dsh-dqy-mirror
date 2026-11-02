// DSH 手机投屏 · 网页半边：设置页（React）
// 控制面板本体在 panel.js，由宿主注入页面；这里只做「DSH 设置 → 手机投屏」那一块。
window.__ModuleLoader__.load({
  id: 'dsh-phone-mirror',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const B = '/dsh-phone-mirror'

    const getJSON = (p) =>
      fetch(B + p, { cache: 'no-store' })
        .then((r) => r.json())
        .catch(() => null)
    const postJSON = (p, body) =>
      fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        .then((r) => r.json())
        .catch(() => null)

    // 控制入口：桌面控制窗（全局）+ 这个设置页。
    // 页面加载时按配置决定要不要把桌面控制窗拉起来（widget=false 就不开）。
    let widgetTried = false
    const ensureWidget = async () => {
      if (widgetTried) return
      widgetTried = true
      const c = await getJSON('/config')
      if (c && c.ok && c.config && c.config.widget === false) return
      fetch(B + '/widget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null)
    }

    function apply(ctx) {
      setTimeout(ensureWidget, 1500)

      const slots = ctx.get('slots')
      if (slots && typeof slots.inject === 'function') {
        try {
          slots.inject('settings.section', () =>
            slots.register({ name: 'settings.section', id: 'phone-mirror', order: 72, label: '手机投屏' }, SettingsPage),
          )
        } catch (e) {}
      }
    }

    function SettingsPage() {
      const [cfg, setCfg] = React.useState(null)
      const [stt, setStt] = React.useState(null)
      const [devices, setDevices] = React.useState([])
      const [note, setNote] = React.useState('')

      React.useEffect(() => {
        let alive = true
        const load = async () => {
          const [c, s, d] = await Promise.all([getJSON('/config'), getJSON('/status'), getJSON('/devices')])
          if (!alive) return
          if (c && c.ok) setCfg(c.config)
          if (s) setStt(s)
          if (d && d.ok) setDevices(d.devices || [])
        }
        load()
        const timer = setInterval(async () => {
          const s = await getJSON('/status')
          if (alive && s) setStt(s)
        }, 2500)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      const set = (k, v) => setCfg((prev) => ({ ...(prev || {}), [k]: v }))
      const flash = (t) => {
        setNote(t)
        setTimeout(() => setNote(''), 2200)
      }
      const save = async () => {
        const r = await postJSON('/config', cfg || {})
        if (r && r.ok) {
          setCfg(r.config)
          flash('已保存')
        } else flash('保存失败')
      }

      const refreshDevices = async () => {
        const d = await getJSON('/devices')
        if (d && d.ok) {
          setDevices(d.devices || [])
          flash((d.devices || []).length ? '设备列表已刷新' : '没有找到设备，先连一下手机')
        } else flash('刷新失败')
      }

      const box = { padding: 12, borderRadius: 10, background: 'rgba(127,127,127,.08)', display: 'flex', flexDirection: 'column', gap: 10 }
      const row = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }
      const label = { width: 96, opacity: 0.75, fontSize: 12, flex: '0 0 auto' }
      const input = { padding: '5px 9px', borderRadius: 6, border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit', fontSize: 12, width: 260 }
      const btn = { padding: '5px 12px', borderRadius: 7, border: '1px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 }
      const Row = (name, node) => React.createElement('div', { style: row }, React.createElement('div', { style: label }, name), node)

      if (!cfg) return React.createElement('div', { style: { padding: 12, opacity: 0.7 } }, '读取配置中…')

      const stateText = !stt
        ? '状态未知'
        : stt.error
          ? '出错：' + stt.error
          : stt.busy
            ? stt.state === 'starting'
              ? '启动中…'
              : '停止中…'
            : stt.running
              ? '运行中' + (stt.device ? '（' + stt.device + '）' : '')
              : '未运行'

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14, padding: '2px 2px 24px' } },
        React.createElement(
          'div',
          { style: { fontSize: 12, opacity: 0.7, lineHeight: 1.7 } },
          '启动后桌面上会出现一个 scrcpy 原生窗口（可选置顶），点画面就是点手机；',
          '控制入口是**桌面上的控制窗**（全局置顶、能拖到任何地方、能最小化），DSH 里不再塞浮窗。',
          React.createElement('br'),
          '任何开了 adb 调试的 Android 手机都能用：把它连上（USB 或 ip:5555），在下面选设备就行。',
          React.createElement('br'),
          '刻意不做「在面板里再显示一份画面」：那需要额外的视频管线，之前大部分崩溃和黑屏都出在那上面。',
        ),

        React.createElement(
          'div',
          { style: box },
          Row(
            '设备地址',
            React.createElement('input', {
              style: input,
              placeholder: 'ip:5555 或 USB 序列号',
              value: cfg.serial || '',
              onChange: (e) => set('serial', e.target.value),
            }),
          ),
          Row(
            '在线设备',
            React.createElement(
              'div',
              { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
              React.createElement(
                'select',
                { style: input, value: cfg.serial || '', onChange: (e) => set('serial', e.target.value) },
                React.createElement('option', { value: '' }, '— 选择设备 —'),
                devices.map((d) =>
                  React.createElement('option', { key: d.serial, value: d.serial }, d.serial + ' (' + d.state + ')'),
                ),
              ),
              React.createElement('button', { style: btn, onClick: refreshDevices }, '刷新'),
            ),
          ),
          Row(
            '窗口宽度',
            React.createElement('input', {
              style: input,
              type: 'number',
              value: cfg.windowWidth || 460,
              onChange: (e) => set('windowWidth', Number(e.target.value)),
            }),
          ),
          Row(
            '置顶',
            React.createElement(
              'label',
              { style: { fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' } },
              React.createElement('input', {
                type: 'checkbox',
                checked: cfg.alwaysOnTop !== false,
                onChange: (e) => set('alwaysOnTop', e.target.checked),
              }),
              '手机窗口一直浮在其它程序上面',
            ),
          ),
          Row(
            '投屏时关屏幕',
            React.createElement(
              'label',
              { style: { fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' } },
              React.createElement('input', {
                type: 'checkbox',
                checked: cfg.turnScreenOff !== false,
                onChange: (e) => set('turnScreenOff', e.target.checked),
              }),
              '手机面板关掉省电，窗口里照常显示',
            ),
          ),
          Row(
            '启动时投屏',
            React.createElement(
              'label',
              { style: { fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' } },
              React.createElement('input', {
                type: 'checkbox',
                checked: !!cfg.autoStart,
                onChange: (e) => set('autoStart', e.target.checked),
              }),
              'DSH 打开后自动把投屏窗口拉起来',
            ),
          ),
          Row(
            '启动时开桌面窗',
            React.createElement(
              'label',
              { style: { fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' } },
              React.createElement('input', {
                type: 'checkbox',
                checked: cfg.widget !== false,
                onChange: (e) => set('widget', e.target.checked),
              }),
              'DSH 打开后自动放一个全局置顶的控制窗（关掉就不挡视野）',
            ),
          ),
          Row(
            '断线自动重连',
            React.createElement(
              'label',
              { style: { fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' } },
              React.createElement('input', {
                type: 'checkbox',
                checked: cfg.reconnect !== false,
                onChange: (e) => set('reconnect', e.target.checked),
              }),
              '网络抖动 / 手机休眠掉线后，每 10 秒自动重试一次（最多 6 次）',
            ),
          ),
          Row(
            'adb 路径',
            React.createElement('input', {
              style: input,
              placeholder: '留空 = 自动找',
              value: cfg.adb || '',
              onChange: (e) => set('adb', e.target.value),
            }),
          ),
          Row(
            'scrcpy 路径',
            React.createElement('input', {
              style: input,
              placeholder: '留空 = 自动找',
              value: cfg.scrcpy || '',
              onChange: (e) => set('scrcpy', e.target.value),
            }),
          ),
          React.createElement(
            'div',
            { style: { ...row, marginTop: 4 } },
            React.createElement('button', { style: btn, onClick: save }, '保存'),
            React.createElement(
              'button',
              { style: btn, onClick: async () => { await postJSON('/start', {}); flash('正在启动…') } },
              '启动投屏',
            ),
            React.createElement(
              'button',
              { style: btn, onClick: async () => { await postJSON('/stop', {}); flash('已停止') } },
              '停止投屏',
            ),
            React.createElement('span', { style: { fontSize: 12, opacity: 0.7 } }, note),
          ),
          React.createElement('div', { style: { fontSize: 12, opacity: 0.72, lineHeight: 1.7 } }, stateText),
          React.createElement(
            'div',
            { style: { fontSize: 11, opacity: 0.5, lineHeight: 1.6 } },
            '日志：~/.dsh/phone-mirror.log（在浏览器里打开 ' + B + '/log 也能看最后 120 行）',
          ),
        ),
      )
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
