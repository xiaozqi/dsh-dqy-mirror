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
    // 已经解锁时按钮转绿：没有要做的动作
    '#dpm-unlock.ok{background:rgba(52,211,153,.14);border-color:rgba(52,211,153,.36);color:#d1fae5}',
    '#dpm-unlock.ok:hover{background:rgba(52,211,153,.26);color:#ecfdf5}',
    // 还没配手机时：隐藏所有控制，只留「查找手机」
    '#dpm-setup{display:none;padding:2px 0 4px}',
    '#dpm-panel.dpm-unconfigured #dpm-switches,#dpm-panel.dpm-unconfigured #dpm-keys,#dpm-panel.dpm-unconfigured #dpm-unlock{display:none}',
    '#dpm-panel.dpm-unconfigured #dpm-setup{display:block}',
    '.dpm-hint{font-size:11px;line-height:1.55;opacity:.82;margin-bottom:6px;white-space:pre-line}',
    '#dpm-setup .dpm-btn{height:26px;width:100%;background:rgba(59,130,246,.18);border:1px solid rgba(59,130,246,.36);',
    'border-radius:7px;color:#dbeafe;font-size:11.5px}',
    '#dpm-setup .dpm-btn+.dpm-btn{margin-top:6px}',
    '#dpm-setup .dpm-btn:hover{background:rgba(59,130,246,.3);color:#fff}',
    // 手机有锁屏密码、配置里又没有 PIN 时，就地要一次
    '#dpm-pin{display:none;margin-top:6px}',
    '#dpm-pin.show{display:block}',
    '#dpm-pin input{width:100%;box-sizing:border-box;height:26px;border-radius:7px;border:1px solid rgba(255,255,255,.18);',
    'background:rgba(255,255,255,.06);color:#e8eaef;font-size:11.5px;padding:0 8px;outline:none}',
    '#dpm-pin input:focus{border-color:rgba(59,130,246,.6)}',
    '#dpm-pin .dpm-btn{width:100%;height:26px;margin-top:5px;border:1px solid rgba(59,130,246,.36);border-radius:7px;',
    'background:rgba(59,130,246,.2);color:#dbeafe;font-size:11.5px}',
    '#dpm-pin .dpm-btn:hover{background:rgba(59,130,246,.32);color:#fff}',
    '#dpm-err{margin-top:6px;font-size:10.5px;line-height:1.4;color:#fca5a5;word-break:break-all;display:none;',
    'max-height:96px;overflow:auto;user-select:text;white-space:pre-wrap;cursor:copy}',
  ].join('\n')

  // 胶囊固定在顶部正中；面板每次打开也回到这里（下方正中），
  // 打开期间可以拖走，收起再打开就复位——位置不落盘。
  var st = { hidden: true, x: null, y: null }
  // 截图 / 排查用：URL 上带 ?dpm=1 时强制展开
  try {
    if (/([?&])dpm=1(&|$)/.test(location.search)) st.hidden = false
  } catch (e) {}

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
  // winget 安装可能要几分钟，别用 20 秒的超时
  function postJSONSlow(p, body) {
    return reqJSON(
      p,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) },
      600000,
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
      '<div id="dpm-setup"></div>' +
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
      '<div id="dpm-pin">' +
      '<input id="dpm-pin-input" type="password" inputmode="numeric" maxlength="12" placeholder="锁屏 PIN（4~12 位数字）" />' +
      '<button class="dpm-btn" id="dpm-pin-save">保存并解锁</button>' +
      '</div>' +
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
    var pinEl = panel.querySelector('#dpm-pin')
    var pinInput = panel.querySelector('#dpm-pin-input')
    var pinSave = panel.querySelector('#dpm-pin-save')
    var setupEl = panel.querySelector('#dpm-setup')

    var last = { running: false, busy: false, topmost: false, locked: null, awake: null, phoneOk: null, serial: null }
    var unlocking = false
    var polling = false
    var phonePolling = false
    var setupBusy = false
    var deps = null // {adb:{found}, scrcpy:{found}, winget:bool, installing:string}
    var setupMode = '' // '' | 'deps' | 'device'

    // 还没配好：藏起所有控制，只留引导区。
    // 新用户第一反应是「按钮坏了」，所以这里要直接告诉他缺什么、下一步点什么。
    function hint(text) {
      var d = document.createElement('div')
      d.className = 'dpm-hint'
      d.textContent = text
      return d
    }
    function setupBtn(text, onClick) {
      var b = document.createElement('button')
      b.className = 'dpm-btn'
      b.textContent = text
      b.addEventListener('click', onClick)
      return b
    }

    function depsMissing() {
      return !!deps && (deps.adb.found === false || deps.scrcpy.found === false)
    }

    function renderDeps() {
      var names = []
      if (deps.adb.found === false) names.push('adb')
      if (deps.scrcpy.found === false) names.push('scrcpy')
      if (deps.installing) {
        setupEl.appendChild(hint('正在安装 ' + deps.installing + '…\n可能要一两分钟；弹 UAC 就点「是」。'))
        setTimeout(function () {
          if (setupMode === 'deps' && deps && deps.installing) checkDeps()
        }, 3000)
        return
      }
      setupEl.appendChild(
        hint(
          '缺少 ' + names.join(' / ') + '\n' +
            (deps.winget ? '可以点下面用 winget 自动装。' : '这台机器没有 winget，需要手动安装。'),
        ),
      )
      if (deps.winget) {
        if (deps.adb.found === false) setupEl.appendChild(setupBtn('安装 adb', function () { installDep('adb') }))
        if (deps.scrcpy.found === false) setupEl.appendChild(setupBtn('安装 scrcpy', function () { installDep('scrcpy') }))
      }
      setupEl.appendChild(setupBtn('重新检测', function () { checkDeps() }))
    }

    function checkDeps() {
      getJSON('/deps').then(function (d) {
        deps = d && d.ok ? d : null
        renderSetup()
      })
    }

    function installDep(what) {
      if (setupBusy) return
      setupBusy = true
      postJSONSlow('/deps/install', { what: what }).then(function (r) {
        setupBusy = false
        if (r && r.ok === false && r.error) {
          setupEl.textContent = ''
          setupEl.appendChild(hint(r.error))
          setupEl.appendChild(setupBtn('重新检测', function () { checkDeps() }))
          return
        }
        checkDeps()
      })
      // 宿主那边的 installing 状态会驱动进度文案
      setTimeout(function () { checkDeps() }, 1500)
    }

    function discover() {
      if (setupBusy) return
      setupBusy = true
      setupEl.textContent = ''
      setupEl.appendChild(hint('正在查找手机…'))
      getJSON('/devices').then(function (d) {
        setupBusy = false
        setupEl.textContent = ''
        var list = (d && d.devices) || []
        var dev = null
        var unauthorized = false
        var offline = false
        for (var i = 0; i < list.length; i++) {
          if (list[i].state === 'device') {
            dev = list[i]
            break
          }
          if (list[i].state === 'unauthorized') unauthorized = true
          if (list[i].state === 'offline') offline = true
        }
        if (!dev) {
          if (unauthorized) {
            setupEl.appendChild(hint('手机插着，但还没授权。\n在手机上点「允许 USB 调试」，然后重新查找。'))
          } else if (offline) {
            setupEl.appendChild(hint('设备显示离线。\n拔掉 USB 重插一次，或者 adb kill-server 后再试。'))
          } else {
            setupEl.appendChild(hint('没找到手机。\n插 USB 并在手机上打开「USB 调试」，或先 adb connect ip:5555。'))
          }
          setupEl.appendChild(setupBtn('重新查找', discover))
          return
        }
        setupEl.appendChild(hint('发现 ' + (dev.model || '手机') + '\n' + dev.serial))
        setupEl.appendChild(
          setupBtn('用它', function () {
            if (setupBusy) return
            setupBusy = true
            setupEl.textContent = ''
            setupEl.appendChild(hint('正在保存…'))
            postJSON('/config', { serial: dev.serial }).then(function () {
              setupBusy = false
              refresh()
            })
          }),
        )
      })
    }

    function renderSetup() {
      var missing = depsMissing()
      var need = missing || !last.serial
      panel.classList.toggle('dpm-unconfigured', need)
      if (!need) {
        setupMode = ''
        return
      }
      if (missing) {
        setupMode = 'deps'
        setupEl.textContent = ''
        renderDeps()
        return
      }
      if (setupMode === 'device') return
      setupMode = 'device'
      setupEl.textContent = ''
      discover()
    }

    // 解锁按钮上显示手机当前状态：锁屏中 / 已解锁 / 息屏。
    // locked === null 表示还没问到（或者没填设备地址），就退回纯「一键解锁」。
    function renderUnlock() {
      if (unlocking) return
      var label = '一键解锁'
      var ok = false
      if (last.locked === false && last.awake !== false) {
        label = '已解锁 · 点一下锁屏'
        ok = true
      } else if (last.awake === false) {
        label = '一键解锁 · 息屏'
      } else if (last.locked === true) {
        label = '一键解锁 · 锁屏中'
      }
      unlockBtn.textContent = label
      unlockBtn.className = 'dpm-btn' + (ok ? ' ok' : '')
      unlockBtn.title =
        last.locked === null
          ? '一键解锁（唤醒 + 上滑 + 输 PIN）'
          : last.locked
            ? '手机现在锁着，点一下解锁'
            : last.awake === false
              ? '手机现在息屏，点一下唤醒并解锁'
              : '手机现在已解锁，点一下锁屏'
    }

    function refreshPhone() {
      if (phonePolling || st.hidden || document.hidden) return
      phonePolling = true
      getJSON('/phone')
        .then(function (p) {
          if (p && p.ok) {
            last.phoneOk = true
            last.locked = !!p.locked
            last.awake = !!p.awake
          } else {
            last.phoneOk = false
            last.locked = null
            last.awake = null
          }
          renderUnlock()
          // 未配置/缺依赖时状态栏有自己的文案（未配置 / 缺依赖），别被这里覆盖
          if (last.phoneOk === false && !panel.classList.contains('dpm-unconfigured')) stateEl.textContent = '手机未连接'
        })
        .catch(function () {})
        .then(function () {
          phonePolling = false
        })
    }

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
      last.serial = s.serial || ''

      // 缺依赖 / 没配手机：切到引导区
      renderSetup()
      var unconfigured = panel.classList.contains('dpm-unconfigured')
      if (unconfigured) {
        stateEl.textContent = depsMissing() ? '缺依赖' : '未配置'
        title.textContent = '手机'
      }

      dot.className = s.error ? 'err' : s.busy ? 'busy' : s.running ? 'on' : ''
      dot2.style.background = s.error ? '#f87171' : s.busy ? '#fbbf24' : s.running ? '#34d399' : '#6b7280'
      if (!unconfigured) title.textContent = s.device || '手机'
      if (!unlocking && !unconfigured) {
        stateEl.textContent = s.error
          ? '出错'
          : s.busy
            ? s.state === 'starting'
              ? '启动中…'
              : '停止中…'
            : s.running
              ? '运行中'
              : last.phoneOk === false
                ? '手机未连接'
                : '已停止'
      }

      powerRow.classList.toggle('on', !!s.running)
      powerRow.classList.toggle('busy', !!s.busy)
      powerRow.title = s.running || s.busy ? '点击停止投屏' : '点击启动投屏'

      topRow.classList.toggle('on', !!s.alwaysOnTop)
      topRow.title = s.alwaysOnTop ? '窗口置顶：开（点一下取消，会重启窗口）' : '窗口置顶：关（点一下打开，会重启窗口）'

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

    // 解锁 / 锁屏：同一个按钮，按手机当前状态决定发哪个请求。
    //   已解锁 → /lock（KEYCODE_SLEEP，关屏即锁）
    //   锁屏 / 息屏 → /unlock（唤醒 + 上滑 + 输 PIN）
    function toggleLock() {
      if (unlocking) return
      var doLock = last.locked === false && last.awake !== false
      unlocking = true
      unlockBtn.disabled = true
      unlockBtn.textContent = doLock ? '锁屏中…' : '解锁中…'
      stateEl.textContent = doLock ? '锁屏中…' : '解锁中…'
      errEl.style.display = 'none'
      postJSON(doLock ? '/lock' : '/unlock', {}).then(function (r) {
        unlocking = false
        unlockBtn.disabled = false
        if (r && r.ok) {
          last.locked = doLock
          last.awake = !doLock
          hidePin()
        }
        renderUnlock()
        if (r && r.needPin) {
          // 手机设了锁屏密码、配置里又没有 PIN——就地要一次，别瞎按
          showPin(r.error || '手机设了锁屏密码，需要你提供 PIN')
          return
        }
        if (!r || r.ok === false) {
          errEl.textContent = (r && r.error) || (doLock ? '锁屏失败：宿主没响应' : '解锁失败：宿主没响应')
          errEl.style.display = 'block'
        } else if (!doLock && r.already) {
          stateEl.textContent = '已经解锁'
        }
        setTimeout(refresh, 300)
        setTimeout(refreshPhone, 800)
      })
    }

    // 手机有锁屏密码时，面板里直接输入 PIN（写进配置，下次就不用再问）
    function showPin(msg) {
      pinEl.classList.add('show')
      if (msg) {
        errEl.textContent = msg
        errEl.style.display = 'block'
      }
      setTimeout(function () {
        try {
          pinInput.focus()
        } catch (e) {}
      }, 50)
    }
    function hidePin() {
      pinEl.classList.remove('show')
      pinInput.value = ''
    }
    function savePin() {
      var v = (pinInput.value || '').replace(/\D/g, '')
      if (!/^\d{4,12}$/.test(v)) {
        errEl.textContent = 'PIN 只能是 4~12 位数字'
        errEl.style.display = 'block'
        return
      }
      pinSave.disabled = true
      postJSON('/config', { pin: v }).then(function (r) {
        pinSave.disabled = false
        if (!r || r.ok === false) {
          errEl.textContent = '保存失败，再试一次'
          errEl.style.display = 'block'
          return
        }
        hidePin()
        errEl.style.display = 'none'
        toggleLock()
      })
    }
    pinSave.addEventListener('click', savePin)
    pinInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') savePin()
    })

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
        return
      }
      if (act === 'back') key(4)
      else if (act === 'home') key(3)
      else if (act === 'recents') key(187)
      else if (act === 'unlock') toggleLock()
    })

    // 错误太长时面板里看不全：点一下复制走，方便贴出来排查
    errEl.title = '点一下复制'
    errEl.addEventListener('click', function () {
      var text = errEl.textContent || ''
      if (!text || !navigator.clipboard) return
      navigator.clipboard.writeText(text).then(
        function () {
          errEl.style.opacity = '.5'
          setTimeout(function () {
            errEl.style.opacity = ''
          }, 260)
        },
        function () {},
      )
    })

    powerRow.addEventListener('click', function (e) {
      e.stopPropagation()
      togglePower()
    })
    topRow.addEventListener('click', function (e) {
      e.stopPropagation()
      toggleTopmost()
    })

    // 打开面板：永远回到上方正中（拖走的位置只在这一次打开期间有效）
    function openPanel() {
      st.hidden = false
      st.x = null
      st.y = null
      place()
      layout()
      refresh()
      refreshPhone()
    }

    // 胶囊：位置固定，点一下展开到屏幕上方正中
    mini.addEventListener('click', openPanel)

    // 快捷键：Ctrl+Shift+M 开合面板（只在 DSH 窗口有焦点时生效）
    window.addEventListener('keydown', function (e) {
      if (!e.ctrlKey || !e.shiftKey || String(e.key).toLowerCase() !== 'm') return
      e.preventDefault()
      if (st.hidden) {
        openPanel()
      } else {
        st.hidden = true
        layout()
      }
    })

    place()
    layout()
    renderUnlock()
    checkDeps()
    refresh()
    refreshPhone()
    setInterval(function () {
      if (!document.hidden) refresh()
    }, 2000)
    // 锁屏状态单独一条：只在面板展开时问（收起时没必要每 3 秒花一次 adb）
    setInterval(function () {
      if (!document.hidden && !st.hidden) refreshPhone()
    }, 3000)
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        refresh()
        refreshPhone()
      }
    })
    window.addEventListener('resize', function () {
      if (st.x != null && (st.x > window.innerWidth - 80 || st.y > window.innerHeight - 34)) {
        st.x = Math.max(0, Math.min(st.x, window.innerWidth - 80))
        st.y = Math.max(0, Math.min(st.y, window.innerHeight - 34))
        place()
      }
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true })
  else boot()
})()
