# 把手机投屏插件装进 DSH（可重复运行；改之前会自动备份 package.json）
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ''
Write-Host '=== 手机投屏插件 · 安装到 DSH ==='
Write-Host ''

$pluginPkg = Join-Path $here 'package.json'
if (-not (Test-Path $pluginPkg)) {
    Write-Host '× 这个脚本要放在插件文件夹里（和 package.json 同一层）。'
    Read-Host '按回车退出'
    exit 1
}
$plugin = Get-Content $pluginPkg -Raw -Encoding UTF8 | ConvertFrom-Json
$name = $plugin.name
if (-not $name) {
    Write-Host '× 插件的 package.json 里没有 name 字段。'
    Read-Host '按回车退出'
    exit 1
}

# 1) 找 DSH 的 profile 目录
$profileDir = $env:DSH_PROFILE_DIR
if (-not $profileDir -or -not (Test-Path $profileDir)) {
    $root = Join-Path $env:USERPROFILE '.dsh\profiles'
    $dirs = @(Get-ChildItem $root -Directory -ErrorAction SilentlyContinue)
    if ($dirs.Count -eq 1) {
        $profileDir = $dirs[0].FullName
    }
    elseif ($dirs.Count -gt 1) {
        $names = ($dirs | ForEach-Object { $_.Name }) -join '、'
        Write-Host "找到多个 profile：$names"
        $pick = Read-Host '要装到哪个？（直接回车 = desktop）'
        if (-not $pick) { $pick = 'desktop' }
        $profileDir = Join-Path $root $pick
    }
}
$profilePkg = if ($profileDir) { Join-Path $profileDir 'package.json' } else { '' }
if (-not $profilePkg -or -not (Test-Path $profilePkg)) {
    Write-Host '× 没找到 DSH 的 profile（一般在这里：C:\Users\你的用户名\.dsh\profiles\desktop）'
    Write-Host '  先把 DSH 打开一次，再运行这个脚本。'
    Read-Host '按回车退出'
    exit 1
}
Write-Host "profile：$profileDir"

# 2) 读出来，看是不是已经装过
$raw = Get-Content $profilePkg -Raw -Encoding UTF8
$obj = $raw | ConvertFrom-Json
$depPath = 'file:' + ($here -replace '\\', '/')

if (-not $obj.PSObject.Properties['dependencies']) {
    $obj | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
}
if (-not $obj.PSObject.Properties['dsh']) {
    $obj | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{})
}
if (-not $obj.dsh.PSObject.Properties['profile']) {
    $obj.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{})
}
if (-not $obj.dsh.profile.PSObject.Properties['bundles']) {
    $obj.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @()
}

$depNow = if ($obj.dependencies.PSObject.Properties[$name]) { $obj.dependencies.$name } else { '' }
$bundles = @($obj.dsh.profile.bundles | Where-Object { $_ })
$hasBundle = $bundles -contains $name

$changed = $false
if ($depNow -ne $depPath) {
    $obj.dependencies | Add-Member -NotePropertyName $name -NotePropertyValue $depPath -Force
    $changed = $true
}
if (-not $hasBundle) {
    $obj.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @($bundles + $name) -Force
    $changed = $true
}

# 3) 只有真的变了才写；写之前备份
if (-not $changed) {
    Write-Host ''
    Write-Host '√ 已经装过了，不用重复安装。'
}
else {
    $bak = "$profilePkg.bak-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
    Copy-Item $profilePkg $bak -Force
    $new = $obj | ConvertTo-Json -Depth 12
    [IO.File]::WriteAllText($profilePkg, $new, (New-Object Text.UTF8Encoding($false)))
    Write-Host ''
    Write-Host '√ 已写入 DSH 配置。'
    Write-Host "  （改之前的文件备份在：$bak）"
}

# 4) 在 profile 的 node_modules 里建一个链接，等价于 pnpm 对本地包的链接。
#    没有这一步，DSH 按名字找不到这个包。
$nm = Join-Path $profileDir 'node_modules'
$link = Join-Path $nm $name
if (-not (Test-Path $nm)) { New-Item -ItemType Directory -Path $nm -Force | Out-Null }
if (Test-Path $link) {
    Write-Host "√ 链接已存在：$link"
}
else {
    try {
        New-Item -ItemType Junction -Path $link -Target $here -ErrorAction Stop | Out-Null
        Write-Host "√ 已链接到：$link"
    }
    catch {
        Write-Host "× 建链接失败（需要管理员权限？）：$($_.Exception.Message)"
        Write-Host '  可以在「以管理员身份运行」的 PowerShell 里重新双击本脚本。'
    }
}

Write-Host ''
Write-Host '下一步：'
Write-Host '  1) 完全退出 DSH（右下角托盘图标也要退出）'
Write-Host '  2) 重新打开 DSH'
Write-Host '  3) 看窗口顶部正中间，应该出现「● 手机」胶囊'
Write-Host ''
Read-Host '按回车关闭'
