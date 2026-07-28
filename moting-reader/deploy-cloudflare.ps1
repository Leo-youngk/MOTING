$ErrorActionPreference = "Stop"

Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw "未找到 Node.js。请先安装 Node.js 22.13 或更高版本，然后重新运行。"
}

$nodeMajor = [int](node.exe -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22) {
  throw "当前 Node.js 版本过低。请安装 Node.js 22.13 或更高版本。"
}

$accountId = (Read-Host "请输入 Cloudflare Account ID").Trim()
if ($accountId -notmatch "^[a-fA-F0-9]{32}$") {
  throw "Account ID 格式不正确，应为 32 位十六进制字符。"
}

$secureToken = Read-Host "请输入新建的 Cloudflare API Token（输入内容不会显示）" -AsSecureString
$tokenPointer = [IntPtr]::Zero
$plainToken = $null

try {
  $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)

  if ([string]::IsNullOrWhiteSpace($plainToken)) {
    throw "API Token 不能为空。"
  }

  $env:CLOUDFLARE_ACCOUNT_ID = $accountId
  $env:CLOUDFLARE_API_TOKEN = $plainToken

  Write-Host ""
  Write-Host "正在安装锁定版本的依赖……"
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) {
    throw "依赖安装失败，退出代码：$LASTEXITCODE"
  }

  Write-Host ""
  Write-Host "正在构建、校验并部署到 Cloudflare Workers……"
  & npm.cmd run deploy
  if ($LASTEXITCODE -ne 0) {
    throw "Cloudflare 部署失败，退出代码：$LASTEXITCODE"
  }

  Write-Host ""
  Write-Host "部署完成。请保存上方 Wrangler 输出的 workers.dev 地址。"
}
finally {
  Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue
  $plainToken = $null

  if ($tokenPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
  }
}
