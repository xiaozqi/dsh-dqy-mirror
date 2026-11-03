// DSH 手机投屏 · DSH 里的控制浮窗（普通 <script>，不依赖 React / 模块加载器）
//
// 两种形态：
//   胶囊  —— 固定在 DSH 顶部正中，不能拖（位置固定）
//   面板  —— 点胶囊展开；标题条可以拖到任意位置，位置会记住
//
// 面板里只有：投屏 / 置顶 两个开关、返回 / 主屏 / 多任务 三个键、一整行「一键解锁」。
// （桌面控制窗已经删了：它带来的进程、心跳、激活、点击被吃掉的问题比它解决的问题多。）
;(function () {
  if (window.__dshPhoneMirrorReady) return
  window.__dshPhoneMirrorReady = true

  var B = '/dsh-dfy-mirror'
  var STORE = 'dsh-dfy-mirror:v3'
  var Z = 2147483000

  var CSS = [
    // 胶囊：固定顶部正中
    '#dpm-mini{position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:' + Z + ';display:none;align-items:center;gap:5px;padding:4px 9px;',
    'border-radius:14px;background:#151821;border:1px solid rgba(255,255,255,.16);color:#dfe4ee;cursor:pointer;font:11px system-ui;',
    'box-shadow:0 6px 18px rgba(0,0,0,.4);-webkit-app-region:no-drag;app-region:no-drag}',
    '#dpm-mini.show{display:flex}',
    // 面板：默认顶部正中；拖动后 left/top 由脚本接管
    '#dpm-panel{position:fixed;top:8px;left:50%;transform:translateX(-50%);width:214px;max-width:90vw;background:#12141a;border:1px solid rgba(255,255,255,.14);',
    'border-radius:11px;box-shadow:0 10px 30px rgba(0,0,0,.5);font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e8eaef;',
    'overflow:hidden;z-index:' + Z + ';-webkit-app-region:no-drag;app-region:no-drag}',
    '#dpm-panel.dpm-hidden{display:none}',
    '#dpm-panel.dpm-dragged{transform:none}',
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
    '.dpm-btn[disabled]{opacity:.45;cursor:default}',
    '.dpm-btn[disabled]:hover{background:transparent;color:#cfd4dd}',
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
    '#dpm-keys{display:grid;grid-template-columns:1fr 1fr 1fr;gap:5px}',
    '#dpm-keys .dpm-btn{height:25px;background:rgba(255,255,255,.07);font-size:10.5px}',
    '#dpm-unlock{margin-top:6px;width:100%;height:28px;border:1px solid rgba(59,130,246,.38);border-radius:7px;',
    'background:rgba(59,130,246,.20);color:#dbeafe;font-size:11.5px;font-weight:600;letter-spacing:.3px}',
    '#dpm-unlock:hover{background:rgba(59,130,246,.34);color:#fff}',
    '#dpm-err{margin-top:6px;font-size:10.5px;line-height:1.4;color:#fca5a5;word-break:break-all;display:none}',
  ].join('\n')

  // 只记：收没收起、面板被拖到哪。胶囊位置写死，不存。
  var st = { hidden: true, x: null, y: null }
  try {
    var saved = JSON.parse(localStorage.getItem(STORE) || '{}')
    if (typeof saved.hidden === 'boolean') st.hidden = saved.hidden
    if (typeof saved.x === 'number' && typeof saved.y === 'number') {
      st.x = saved.x
      st.y = saved.y
    }
  } catch (e) {}
  // 截图 / 排查用：URL 上带 ?dpm=1 时强制展开
  try {
    if (/([?&])dpm=1(&|$)/.test(location.search)) st.hidden = false
  } catch (e) {}
  var save = function () {
    try {
      localStorage.setItem(STORE, JSON.stringify(st))
    } catch (e) {}
  }

  // 带超时的请求：宿主要是卡住 / 重启中，fetch 会一直挂着，
  // 轮询的 in-flight 标记就永远不回位，整个面板停在旧状态。
  function reqJSON(p, opts, timeoutMs) {
    var o = opts || {}
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
    var timer = null
    if (ctl) {
      o.signal = ctl.signal
      timer = setTimeout(function () {
        ctl.abort()
      }, timeoutMs || 12000)
    }
    var done = function () {
      if (timer) clearTimeout(timer)
    }
    return fetch(B + p, o)
      .then(function (r) {
        return r.json()
      })
      .then(
        function (v) {
          done()
          return v
        },
        function () {
          done()
          return null
        },
      )
  }
  function getJSON(p) {
    return reqJSON(p, { cache: 'no-store' }, 8000)
  }
  function postJSON(p, body) {
    return reqJSON(
      p,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) },
      20000,
    )
  }

  function boot() {
    if (document.getElementById('dpm-panel')) return

    var style = document.createElement('style')
    style.dataset.plugin = 'dfy-mirror'
    style.textContent = CSS
    document.head.appendChild(style)

    var panel = document.createElement('div')
    panel.id = 'dpm-panel'
    panel.innerHTML =
      '<div id="dpm-bar">' +
      '<span id="dpm-dot"></span>' +
      '<span id="dpm-title">手机</span>' +
      '<span id="dpm-state"></span>' +
      '<button class="dpm-btn" data-act="hide" title="收成胶囊">✕</button>' +
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
      '</div>' +
      '<button class="dpm-btn" id="dpm-unlock" data-act="unlock" title="一键解锁（唤醒 + 上滑 + 输 PIN）">一键解锁</button>' +
      '<div id="dpm-err"></div>' +
      '</div>'

    var mini = document.createElement('div')
    mini.id = 'dpm-mini'
    mini.title = '手机投屏'
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
    var unlockBtn = panel.querySelector('#dpm-unlock')

    var last = { running: false, busy: false, topmost: false }
    var unlocking = false
    var polling = false

    // 面板：拖过就按存的坐标放，没拖过就居中（transform 负责居中）
    function place() {
      if (st.x == null || st.y == null) {
        panel.classList.remove('dpm-dragged')
        panel.style.left = ''
        panel.style.top = ''
      } else {
        panel.classList.add('dpm-dragged')
        panel.style.left = st.x + 'px'
        panel.style.top = st.y + 'px'
      }
    }

    function layout() {
      panel.classList.toggle('dpm-hidden', !!st.hidden)
      mini.classList.toggle('show', !!st.hidden)
    }

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

      dot.className = s.error ? 'err' : s.busy ? 'busy' : s.running ? 'on' : ''
      dot2.style.background = s.error ? '#f87171' : s.busy ? '#fbbf24' : s.running ? '#34d399' : '#6b7280'
      title.textContent = s.device || '手机'
      if (!unlocking) stateEl.textContent = s.error ? '出错' : s.busy ? (s.state === 'starting' ? '启动中…' : '停止中…') : s.running ? '运行中' : '已停止'

      powerRow.classList.toggle('on', !!s.running)
      powerRow.classList.toggle('busy', !!s.busy)
      powerRow.title = s.running || s.busy ? '点击停止投屏' : '点击启动投屏'

      topRow.classList.toggle('on', !!s.alwaysOnTop)
      topRow.title = s.alwaysOnTop ? '窗口置顶：开（点一下取消）' : '窗口置顶：关（点一下打开）'

      if (s.error && !unlocking) {
        errEl.textContent = s.error
        errEl.style.display = 'block'
      } else if (!unlocking) {
        errEl.style.display = 'none'
      }
    }

    // 页面切到后台就别轮询了；一次没回来之前也不再发新的。
    function refresh() {
      if (polling) return
      polling = true
      getJSON('/status')
        .then(function (s) {
          render(s)
        })
        .catch(function () {})
        .then(function () {
          polling = false
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

    // 一键解锁：一次请求把「唤醒 → 上滑 → 输 PIN」全做完（约 2~8 秒）。
    function unlock() {
      if (unlocking) return
      unlocking = true
      unlockBtn.disabled = true
      unlockBtn.textContent = '解锁中…'
      stateEl.textContent = '解锁中…'
      errEl.style.display = 'none'
      postJSON('/unlock', {}).then(function (r) {
        unlocking = false
        unlockBtn.disabled = false
        unlockBtn.textContent = '一键解锁'
        if (!r || r.ok === false) {
          errEl.textContent = (r && r.error) || '解锁失败：宿主没响应'
          errEl.style.display = 'block'
        } else if (r.already) {
          stateEl.textContent = '已经解锁'
        }
        setTimeout(refresh, 300)
      })
    }

    function key(code) {
      postJSON('/key', { code: code })
    }

    // 面板拖动：只认标题条，按钮不触发。胶囊固定，不参与拖动。
    panel.querySelector('#dpm-bar').addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return
      var rect = panel.getBoundingClientRect()
      var ox = e.clientX - rect.left
      var oy = e.clientY - rect.top
      var moved = false
      function move(ev) {
        if (!moved && Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) < 3) return
        moved = true
        st.x = Math.round(Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - ox)))
        st.y = Math.round(Math.max(0, Math.min(window.innerHeight - 34, ev.clientY - oy)))
        place()
      }
      function up() {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        if (moved) save()
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    })

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
      else if (act === 'unlock') unlock()
    })

    powerRow.addEventListener('click', function (e) {
      e.stopPropagation()
      togglePower()
    })
    topRow.addEventListener('click', function (e) {
      e.stopPropagation()
      toggleTopmost()
    })

    // 胶囊：位置固定，点一下展开到上次拖到的地方（没拖过就居中）
    mini.addEventListener('click', function () {
      st.hidden = false
      layout()
      save()
      refresh()
    })

    place()
    layout()
    refresh()
    setInterval(function () {
      if (!document.hidden) refresh()
    }, 2000)
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refresh()
    })
    window.addEventListener('resize', function () {
      if (st.x != null && (st.x > window.innerWidth - 80 || st.y > window.innerHeight - 34)) {
        st.x = Math.max(0, Math.min(st.x, window.innerWidth - 80))
        st.y = Math.max(0, Math.min(st.y, window.innerHeight - 34))
        place()
        save()
      }
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true })
  else boot()
})()
