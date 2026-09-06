$ErrorActionPreference = 'Stop'
$installRoot = (Get-Location).ProviderPath
$configFile = Join-Path $installRoot 'config.yaml'
$pluginParent = Join-Path $installRoot 'plugins'
$pluginDir = Join-Path $pluginParent 'Omniscene'
function Assert-PlainPath([string]$target, [bool]$directory) {
    $item = Get-Item -LiteralPath $target -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.PSIsContainer -ne $directory) {
        throw '安装暂停：目标包含链接或非预期文件，请从真实安装目录运行。'
    }
}
if (-not $installRoot -or $installRoot -eq [IO.Path]::GetPathRoot($installRoot) -or -not (Test-Path -LiteralPath $configFile -PathType Leaf)) {
    throw '请在 SillyTavern 根目录运行（需有 config.yaml）。'
}
Assert-PlainPath $installRoot $true
Assert-PlainPath $configFile $false
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw '安装失败：未找到 Git。' }
if ($env:QIANMU_SERVER_STOPPED -ne '1') {
    $answer = Read-Host '请先等待生成结束并停止 ST 后端。确认已停止后输入 STOPPED（关闭网页不算）'
    if ($answer -cne 'STOPPED') { throw '安装已暂停，未修改配置或插件。' }
}
# Operator confirmation is a prerequisite, not proof that arbitrary processes stopped.
$installLock = Join-Path $installRoot '.qianmu-installer.lock'
try { New-Item -ItemType Directory -Path $installLock | Out-Null }
catch { throw '另一个安装正在进行或留下维护锁；请先核查，不要同时安装。' }
$lockOwner = Join-Path $installLock ([guid]::NewGuid().ToString('N'))
try {
[IO.File]::WriteAllText($lockOwner, [string]$PID)
if (Test-Path -LiteralPath $pluginParent) { Assert-PlainPath $pluginParent $true }
$previousCommit = ''
if (Test-Path -LiteralPath $pluginDir) {
    Assert-PlainPath $pluginDir $true
    if (-not (Test-Path -LiteralPath (Join-Path $pluginDir '.git') -PathType Container)) { throw '原插件不是 Git 安装，未覆盖。' }
    Assert-PlainPath (Join-Path $pluginDir '.git') $true
    $dirty = & git -C $pluginDir status --porcelain
    if ($LASTEXITCODE -ne 0 -or $dirty) { throw '插件有本地改动或无法核查，未覆盖。' }
    $previousCommit = & git -C $pluginDir rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $previousCommit -notmatch '^[a-f0-9]{40,64}$') { throw '无法确认原插件版本。' }
}
$originalBytes = [IO.File]::ReadAllBytes($configFile)
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$content = $utf8.GetString($originalBytes).TrimStart([char]0xFEFF)
$keys = [regex]::Matches($content, '(?m)^["'']?enableServerPlugins["'']?[ \t]*:')
if ($keys.Count -gt 1 -or $content -match '(?m)^\.\.\.\s*$' -or [regex]::Matches($content, '(?m)^---\s*$').Count -gt 1 -or $content -match '(?m)^[ \t]*[\{\[]') {
    throw '配置含重复开关或多文档格式，未自动重写。'
}
if ($keys.Count -eq 1) {
    if ($content -notmatch '(?m)^["'']?enableServerPlugins["'']?[ \t]*:[ \t]*(true|false)[ \t]*(?:#[^\r\n]*)?\r?$') { throw 'enableServerPlugins 不是普通布尔值，请先核查配置。' }
    $content = [regex]::Replace($content, '(?m)^["'']?enableServerPlugins["'']?[ \t]*:[ \t]*(true|false)([ \t]*(?:#[^\r\n]*)?)(\r?)$', 'enableServerPlugins: true$2$3')
} else {
    $newline = if ($content.Contains([string][char]13 + [char]10)) { [string][char]13 + [char]10 } else { [string][char]10 }
    $content = $content.TrimEnd([char[]]@(13,10)) + $newline + 'enableServerPlugins: true' + $newline
}
$hasBom = $originalBytes.Length -ge 3 -and $originalBytes[0] -eq 239 -and $originalBytes[1] -eq 187 -and $originalBytes[2] -eq 191
$encoding = New-Object System.Text.UTF8Encoding($hasBom)
$nodeId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss') + '-' + [guid]::NewGuid().ToString('N')
$backupFile = $configFile + '.qianmu-backup.' + $nodeId
$tempFile = $configFile + '.qianmu-new.' + $nodeId
$originalAcl = Get-Acl -LiteralPath $configFile
[IO.File]::WriteAllBytes($backupFile, $originalBytes)
Set-Acl -LiteralPath $backupFile -AclObject $originalAcl
[IO.File]::WriteAllText($backupFile + '.ref', [string]$previousCommit, $utf8)
Set-Acl -LiteralPath ($backupFile + '.ref') -AclObject $originalAcl
if ($previousCommit) {
    & git -c core.hooksPath="$backupFile.hooks-disabled" -C $pluginDir pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw "更新失败，ST 配置未修改。备份：$backupFile" }
} else {
    $stage = Join-Path $installRoot ('.qianmu-install.' + $nodeId)
    New-Item -ItemType Directory -Path $stage | Out-Null
    $stagedPlugin = Join-Path $stage 'source'
    & git clone https://github.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut.git $stagedPlugin
    if ($LASTEXITCODE -ne 0) { throw "下载失败，未启用插件；暂存保留于 $stage" }
    foreach ($file in @('server-plugin.js','package.json')) { Assert-PlainPath (Join-Path $stagedPlugin $file) $false }
    if (-not (Test-Path -LiteralPath $pluginParent)) { New-Item -ItemType Directory -Path $pluginParent | Out-Null }
    Assert-PlainPath $pluginParent $true
    if (Test-Path -LiteralPath $pluginDir) { throw '插件目录在下载期间已变化，未覆盖。' }
    # Fixed absolute descendants of the verified install root, no directory merging.
    [IO.Directory]::Move($stagedPlugin, $pluginDir)
}
foreach ($file in @('server-plugin.js','package.json')) { Assert-PlainPath (Join-Path $pluginDir $file) $false }
$installedCommit = & git -C $pluginDir rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $installedCommit -notmatch '^[a-f0-9]{40,64}$') { throw '无法确认安装版本，配置尚未修改。' }
try {
    Assert-PlainPath $configFile $false
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($configFile)) -cne [Convert]::ToBase64String($originalBytes)) { throw '配置在安装期间已修改，保留改动，未覆盖。' }
    [IO.File]::WriteAllText($tempFile, $content, $encoding)
    Set-Acl -LiteralPath $tempFile -AclObject $originalAcl
    Assert-PlainPath $installRoot $true
    Assert-PlainPath $configFile $false
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($configFile)) -cne [Convert]::ToBase64String($originalBytes)) { throw '配置在写入前发生变化，未覆盖。' }
    [IO.File]::Replace($tempFile, $configFile, [System.Management.Automation.Language.NullString]::Value)
} catch {
    throw "代码准备完成，但配置未完成写入，不能当作安装成功。备份：$backupFile。$($_.Exception.Message)"
} finally {
    if (Test-Path -LiteralPath $tempFile -PathType Leaf) { Remove-Item -LiteralPath $tempFile }
}
Write-Host "千幕服务端已安装/更新，版本节点：$installedCommit" -ForegroundColor Green
Write-Host "配置备份：$backupFile；原插件节点保存在同名 .ref 文件（首次安装为空）。"
Write-Host '请按原方式启动 SillyTavern 后端，再刷新网页；本脚本不会停止或重启进程。'
Write-Host '健康检查：ST 地址后加 /api/plugins/qianmu-tts/health；它不代表上游生图已验收。'
} finally {
    Assert-PlainPath $installLock $true
    Assert-PlainPath $lockOwner $false
    if ([IO.File]::ReadAllText($lockOwner) -cne [string]$PID) { throw '安装锁归属已变化，请核查。' }
    Remove-Item -LiteralPath $lockOwner
    # Non-recursive: unexpected files keep the directory in place for inspection.
    [IO.Directory]::Delete($installLock)
}
