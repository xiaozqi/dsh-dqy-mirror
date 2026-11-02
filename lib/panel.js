// DSH 手机投屏 · DSH 里的控制浮窗（普通 <script>，不依赖 React / 模块加载器）
//
// 和桌面控制窗同一套交互：标题条 + 两个开关（投屏 / 置顶）+ 四个按键 + 桌面窗开关。
// 点 ✕ 收成右下角小胶囊；胶囊和面板共用位置，都可以拖。
;(function () {
  if (window.__dshPhoneMirrorReady) return
  window.__dshPhoneMirrorReady = true

  var B = '/dsh-phone-mirror'
  var STORE = 'dsh-phone-mirror:v6'
  var Z = 2147483000

  var CSS = [
    '#dpm-panel{position:fixed;right:14px;bottom:14px;width:214px;max-width:90vw;background:#12141a;border:1px solid rgba(255,255,255,.14);',
    'border-radius:11px;box-shadow:0 10px 30px rgba(0,0,0,.5);font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e8eaef;',
    'overflow:hidden;z-index:' + Z + ';-webkit-app-region:no-drag;app-region:no-drag}',
    '#dpm-panel.dpm-hidden{display:none}',
    '#dpm-bar{display:flex;align-items:center;gap:5px;padding:6px 8px;background:rgba(255,255,255,.06);cursor:move;user-select:none}',
    '#dpm-dot{width:7px;height:7px;border-radius:50%;background:#6b7280;flex:0 0 auto;transition:background .2s}',
    '#dpm-dot.on{background:#34d399;box-shadow:0 0 6px #34d399}',
    '#dpm-dot.busy{background:#fbbf24}',
    '#dpm-dot.err{background:#f87171}',
    '#dpm-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;font-size:11.5px}',
    '#dpm-state{font-size:10px;opacity:.55;white-space:nowrap;flex:0 0 auto}',
    '.dpm-btn{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;border:0;background:transparent;',
    'color:#cfd4dd;cursor:pointer;padding:0 4px;border-radius:5px;font-size:10.5px;line-height:1}',
    '.dpm-btn:hover{background:rgba(255,255,255,.12);color:#fff}',
    '#dpm-body{padding:7px}',
    '#dpm-switches{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px}',
    '.dpm-row{display:flex;align-items:center;gap:5px;padding:5px 6px;border-radius:7px;background:rgba(255,255,255,.05);',
    'cursor:pointer;user-select:none}',
    '.dpm-row:hover{background:rgba(255,255,255,.09)}',
    '.dpm-row .lab{font-size:11px;opacity:.92;white-space:nowrap}',
    '.dpm-row .sw{position:relative;width:30px;height:17px;border-radius:9px;background:rgba(255,255,255,.18);transition:background .15s;flex:0 0 auto;margin-left:auto}',
    '.dpm-row .sw i{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#e8eaef;transition:left .15s}',
    '.dpm-row.on .sw{background:#3b82f6}',
    '.dpm-row.on .sw i{left:15px}',
    '.dpm-row.busy .sw{background:#fbbf24}',
    '#dpm-keys{display:grid;grid-template-columns:1fr 1fr;gap:5px}',
    '#dpm-keys .dpm-btn{height:25px;background:rgba(255,255,255,.07);font-size:10.5px}',
    '#dpm-err{margin-top:6px;font-size:10.5px;line-height:1.4;color:#fca5a5;word-break:break-all;display:none}',
    '#dpm-mini{position:fixed;right:14px;bottom:14px;z-index:' + Z + ';display:none;align-items:center;gap:5px;padding:4px 8px;',
    'border-radius:14px;background:#151821;border:1px solid rgba(255,255,255,.16);color:#dfe4ee;cursor:pointer;font:11px system-ui;',
    'box-shadow:0 6px 18px rgba(0,0,0,.4);-webkit-app-region:no-drag;app-region:no-drag}',
    '#dpm-mini.show{display:flex}',
  ].join('\n')

  // 默认是收起来的小胶囊：DSH 一启动就摆一大块面板太挡视野。
  // 用户展开过之后才会记住展开状态。
  var st = { x: null, y: null, hidden: true }
  try {
    var saved = JSON.parse(localStorage.getItem(STORE) || '{}')
    if (typeof saved.x === 'number') st.x = saved.x
    if (typeof saved.y === 'number') st.y = saved.y
    if (typeof saved.hidden === 'boolean') st.hidden = saved.hidden
  } catch (e) {}
  var save = function () {
    try {
      localStorage.setItem(STORE, JSON.stringify(st))
    } catch (e) {}
  }

  function getJSON(p) {
    return fetch(B + p, { cache: 'no-store' })
      .then(function (r) {
        return r.json()
      })
      .catch(function () {
        return null
      })
  }
  function postJSON(p, body) {
    return fetch(B + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })
      .then(function (r) {
        return r.json()
      })
      .catch(function () {
        return null
      })
  }

  function boot() {
    if (document.getElementById('dpm-panel')) return

    var style = document.createElement('style')
    style.dataset.plugin = 'phone-mirror'
    style.textContent = CSS
    document.head.appendChild(style)

    var panel = document.createElement('div')
    panel.id = 'dpm-panel'
    panel.innerHTML =
      '<div id="dpm-bar">' +
      '<span id="dpm-dot"></span>' +
      '<span id="dpm-title">手机</span>' +
      '<span id="dpm-state"></span>' +
      '<button class="dpm-btn" data-act="hide" title="收成小胶囊">✕</button>' +
      '</div>' +
      '<div id="dpm-body">' +
      '<div id="dpm-switches">' +
      '<div class="dpm-row" id="dpm-power" title="启动 / 停止投屏"><span class="lab">投屏</span><span class="sw"><i></i></span></div>' +
      '<div class="dpm-row" id="dpm-top" title="窗口置顶"><span class="lab">置顶</span><span class="sw"><i></i></span></div>' +
      '</div>' +
      '<div id="dpm-keys">' +
      '<button class="dpm-btn" data-act="back" title="返回">◁ 返回</button>' +
      '<button class="dpm-btn" data-act="home" title="主屏">⌂ 主屏</button>' +
      '<button class="dpm-btn" data-act="recents" title="多任务">▣ 多任务</button>' +
      '<button class="dpm-btn" data-act="wake" title="点亮屏幕">☀ 唤醒</button>' +
      '</div>' +
      '<div class="dpm-row" id="dpm-widget" style="margin-top:6px" title="桌面控制窗（全局置顶，不依赖 DSH）">' +
      '<span class="lab">桌面窗</span><span class="sw"><i></i></span></div>' +
      '<div id="dpm-err"></div>' +
      '</div>'

    var mini = document.createElement('div')
    mini.id = 'dpm-mini'
    mini.innerHTML =
      '<span style="width:6px;height:6px;border-radius:50%;background:#6b7280"></span><span>手机</span>'

    document.body.appendChild(panel)
    document.body.appendChild(mini)

    var dot = panel.querySelector('#dpm-dot')
    var dot2 = mini.querySelector('span')
    var title = panel.querySelector('#dpm-title')
    var stateEl = panel.querySelector('#dpm-state')
    var errEl = panel.querySelector('#dpm-err')
    var powerRow = panel.querySelector('#dpm-power')
    var topRow = panel.querySelector('#dpm-top')
    var widgetRow = panel.querySelector('#dpm-widget')

    var last = { running: false, busy: false, topmost: false, widgetRunning: false }
    var widgetTried = false

    function layout() {
      if (st.x != null && st.y != null) {
        panel.style.left = st.x + 'px'
        panel.style.top = st.y + 'px'
        panel.style.right = 'auto'
        panel.style.bottom = 'auto'
        mini.style.left = st.x + 'px'
        mini.style.top = st.y + 'px'
        mini.style.right = 'auto'
        mini.style.bottom = 'auto'
      }
      panel.classList.toggle('dpm-hidden', !!st.hidden)
      mini.classList.toggle('show', !!st.hidden)
    }

    var bar = panel.querySelector('#dpm-bar')
    bar.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return
      var rect = panel.getBoundingClientRect()
      var ox = e.clientX - rect.left
      var oy = e.clientY - rect.top
      function move(ev) {
        st.x = Math.round(Math.max(0, Math.min(window.innerWidth - 100, ev.clientX - ox)))
        st.y = Math.round(Math.max(0, Math.min(window.innerHeight - 34, ev.clientY - oy)))
        layout()
      }
      function up() {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        save()
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    })

    function render(s) {
      if (!s || s.ok === false) {
        dot.className = ''
        dot2.style.background = '#6b7280'
        stateEl.textContent = '连不上'
        title.textContent = '手机'
        errEl.style.display = 'none'
        return
      }
      last.running = !!s.running
      last.busy = !!s.busy
      last.topmost = !!s.alwaysOnTop
      last.widgetRunning = !!s.widgetRunning

      dot.className = s.error ? 'err' : s.busy ? 'busy' : s.running ? 'on' : ''
      dot2.style.background = s.error ? '#f87171' : s.busy ? '#fbbf24' : s.running ? '#34d399' : '#6b7280'
      title.textContent = s.device || '手机'
      stateEl.textContent = s.error ? '出错' : s.busy ? (s.state === 'starting' ? '启动中…' : '停止中…') : s.running ? '运行中' : '已停止'

      powerRow.classList.toggle('on', !!s.running)
      powerRow.classList.toggle('busy', !!s.busy)
      powerRow.title = s.running || s.busy ? '点击停止投屏' : '点击启动投屏'

      topRow.classList.toggle('on', !!s.alwaysOnTop)
      topRow.title = s.alwaysOnTop ? '窗口置顶：开（点一下取消，会重启窗口）' : '窗口置顶：关（点一下打开，会重启窗口）'

      widgetRow.classList.toggle('on', !!s.widgetRunning)
      widgetRow.title = s.widgetRunning ? '桌面控制窗：开着（点一下关掉）' : '桌面控制窗：关着（点一下打开）'

      if (s.error) {
        errEl.textContent = s.error
        errEl.style.display = 'block'
      } else {
        errEl.style.display = 'none'
      }
    }

    function refresh() {
      getJSON('/status').then(function (s) {
        render(s)
        if (!widgetTried && s && s.widget) {
          widgetTried = true
          postJSON('/widget', {})
        }
      })
    }

    function togglePower() {
      if (last.running || last.busy) {
        postJSON('/stop', {}).then(function () {
          setTimeout(refresh, 400)
        })
      } else {
        stateEl.textContent = '启动中…'
        postJSON('/start', {}).then(function (r) {
          if (r && r.ok === false) {
            errEl.textContent = r.error || '启动失败'
            errEl.style.display = 'block'
          }
          setTimeout(refresh, 400)
        })
      }
    }

    function toggleTopmost() {
      stateEl.textContent = '切换置顶…'
      postJSON('/topmost', { on: !last.topmost }).then(function (r) {
        if (r && r.ok === false) {
          errEl.textContent = r.error || '置顶切换失败'
          errEl.style.display = 'block'
        } else {
          errEl.style.display = 'none'
        }
        setTimeout(refresh, 600)
      })
    }

    function toggleWidget() {
      if (last.widgetRunning) {
        postJSON('/widget/close', {}).then(function () {
          setTimeout(refresh, 400)
        })
      } else {
        postJSON('/widget', {}).then(function (r) {
          if (r && r.ok === false) {
            errEl.textContent = r.error || '打不开桌面控制窗'
            errEl.style.display = 'block'
          }
          setTimeout(refresh, 900)
        })
      }
    }

    function key(code) {
      postJSON('/key', { code: code })
    }

    panel.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]')
      if (!btn) return
      var act = btn.getAttribute('data-act')
      if (act === 'hide') {
        st.hidden = true
        layout()
        save()
        return
      }
      if (act === 'back') key(4)
      else if (act === 'home') key(3)
      else if (act === 'recents') key(187)
      else if (act === 'wake') key(224)
    })

    powerRow.addEventListener('click', function (e) {
      e.stopPropagation()
      togglePower()
    })
    topRow.addEventListener('click', function (e) {
      e.stopPropagation()
      toggleTopmost()
    })
    widgetRow.addEventListener('click', function (e) {
      e.stopPropagation()
      toggleWidget()
    })

    // 胶囊：拖动换位置，轻点展开
    var miniMoved = false
    mini.addEventListener('pointerdown', function (e) {
      var r = mini.getBoundingClientRect()
      var sx = e.clientX
      var sy = e.clientY
      var left = r.left
      var top = r.top
      var moved = false
      function move(ev) {
        var dx = ev.clientX - sx
        var dy = ev.clientY - sy
        if (!moved && Math.abs(dx) + Math.abs(dy) > 3) moved = true
        if (!moved) return
        st.x = Math.round(Math.max(0, Math.min(window.innerWidth - 60, left + dx)))
        st.y = Math.round(Math.max(0, Math.min(window.innerHeight - 26, top + dy)))
        layout()
      }
      function up() {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        if (moved) {
          miniMoved = true
          save()
          setTimeout(function () {
            miniMoved = false
          }, 0)
        }
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    })

    mini.addEventListener('click', function () {
      if (miniMoved) return
      st.hidden = false
      layout()
      save()
      refresh()
    })

    layout()
    refresh()
    setInterval(refresh, 1000)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true })
  else boot()
})()
