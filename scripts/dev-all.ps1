# openmaic dev-all.ps1
# One-command local dev stack for Windows host + NATIVE Windows PostgreSQL:
#   1. ensures the local PostgreSQL Windows service is present and running
#   2. points the app at PostgreSQL through the loopback (127.0.0.1:5432)
#   3. starts the Next.js dev server (detached, so it survives this shell)
#   4. verifies /api/health, /api/agent/runtime, /api/agent/sessions, /workspace
#
# Why 127.0.0.1 and not WSL: this used to reach a PostgreSQL inside WSL2 over the
# vEthernet IP, and that cross-NAT boundary flapped on this machine (connections
# died within a minute of boot -> ECONNREFUSED / "Connection terminated
# unexpectedly"). A native Windows server on the loopback has no such boundary.
#
# Notes:
#   * The dev server is launched via WMI Win32_Process.Create so it is NOT a
#     child of this shell. Closing this window (or the calling terminal) will
#     not kill it - earlier that teardown was the real reason /workspace looked
#     "unreachable" even though Next.js had printed "Ready".
#   * Endpoint checks bypass the Windows system proxy (Clash/VPN tools set
#     HKCU Internet Settings ProxyServer and break localhost HTTP clients).
#     They use HttpWebRequest with Proxy=$null, which is 127.0.0.1-only safe.
#   * Starting an unstarted service and installing Postgres need admin. This
#     script only starts an EXISTING service; install it first (see repo notes /
#     `winget install PostgreSQL.PostgreSQL.16`).
#
# Usage (from repo root):
#   powershell -File scripts/dev-all.ps1                 # start + verify, then wait
#   powershell -File scripts/dev-all.ps1 -NoWait         # start + verify, then exit
#   powershell -File scripts/dev-all.ps1 -Stop           # stop the dev server
#
# Ctrl+C stops the dev server (cleanup runs in the finally block).

param(
    [switch]$NoWait,
    [switch]$Stop
)

# ==== Config ====
$ErrorActionPreference = "Continue"
$ProgressPreference    = "SilentlyContinue"

$Root       = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$DbHost     = "127.0.0.1"
$DbUser     = "openmaic"
$DbPassword = "openmaic"
$DbName     = "openmaic"
$DbPort     = 5432
$AppPort    = 3000
$DbWaitSec  = 30
$AppWaitSec = 200
$PollMs     = 1500

# Service name is version-specific (postgresql-x64-16); probe by wildcard so a
# minor-version bump does not break this script.
$PgServicePattern = "postgresql*"

$LogsDir    = Join-Path $Root "logs"
$DevLogFile = Join-Path $LogsDir "dev.log"
$DevErrFile = Join-Path $LogsDir "dev.err.log"
$DevPidFile = Join-Path $LogsDir "dev.pid"

# ==== Pretty output ====
function Write-Step { param([string]$Msg) Write-Host ""; Write-Host ("==> " + $Msg) -ForegroundColor Cyan }
function Write-OK   { param([string]$Msg) Write-Host "    [OK]   $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "    [!!]   $Msg" -ForegroundColor Yellow }
function Write-Fail { param([string]$Msg) Write-Host "    [FAIL] $Msg" -ForegroundColor Red }

# ==== Helpers ====
function Test-Tcp {
    param([string]$TargetHost, [int]$Port, [int]$TimeoutMs = 1500)
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect($TargetHost, $Port, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
            $client.EndConnect($iar)
            $client.Close()
            return $true
        }
        $client.Close()
        return $false
    } catch { return $false }
}

function Wait-ForTcp {
    param([string]$TargetHost, [int]$Port, [int]$Seconds, [string]$Label)
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Tcp -TargetHost $TargetHost -Port $Port) { return $true }
        Start-Sleep -Milliseconds $PollMs
    }
    Write-Fail "$Label not reachable at ${TargetHost}:${Port} within ${Seconds}s"
    return $false
}

# Run node with a script piped over stdin (no temp files). Resolves modules from $Root.
function Invoke-NodeStdin {
    param([string]$Script)
    Push-Location $Root
    try { $Script | & node - } finally { Pop-Location }
}

# HTTP GET that ignores the Windows system proxy. PowerShell 5.1's
# Invoke-WebRequest/Invoke-RestMethod honour the WinINET proxy (Clash/VPN set
# ProxyServer=127.0.0.1:<port>), which makes localhost calls fail/time out.
# HttpWebRequest with Proxy=$null is available on 5.1 and bypasses it.
function Invoke-Http {
    param([string]$Url, [int]$TimeoutSec = 10)
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.Proxy = $null
    $req.Timeout = $TimeoutSec * 1000
    $req.ReadWriteTimeout = $TimeoutSec * 1000
    $req.Method = "GET"
    try {
        $resp = $req.GetResponse()
        $code = [int]$resp.StatusCode
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $body = $sr.ReadToEnd(); $sr.Close(); $resp.Close()
        return @{ Code = $code; Body = $body; Error = $null }
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) {
            return @{ Code = [int]$_.Exception.Response.StatusCode; Body = ""; Error = $_.Exception.Message }
        }
        return @{ Code = -1; Body = ""; Error = $_.Exception.Message }
    } catch {
        return @{ Code = -2; Body = ""; Error = $_.Exception.Message }
    }
}

# Launch the app server out-of-process via WMI so it is NOT tied to this
# shell's process tree (a job/terminal teardown would otherwise kill it).
# Production mode (`pnpm start`) on purpose: the dev server on Windows kept
# dying with 0xC000013A right after a generation session completed (on-demand
# compilation + pnpm/next process wrapping receiving console Ctrl events).
function Start-DetachedDevServer {
    param([string]$PnpmPath, [string]$WorkingDir, [string]$LogFile, [string]$ErrFile)
    Remove-Item $LogFile, $ErrFile -Force -ErrorAction SilentlyContinue
    $inner   = "& '$PnpmPath' start > '$LogFile' 2> '$ErrFile'"
    $cmdline = "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command `"$inner`""
    $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
        -Arguments @{ CommandLine = $cmdline; CurrentDirectory = $WorkingDir }
    if ($res.ReturnValue -ne 0) { return $null }
    return [int]$res.ProcessId
}

# Kill whatever is listening on the app port (and its child tree).
function Stop-DevServerOnPort {
    param([int]$Port)
    $killed = @()
    $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $listeners) {
        $owner = $c.OwningProcess
        if ($owner -and $owner -gt 0 -and $killed -notcontains $owner) {
            & taskkill /PID $owner /T /F 2>&1 | Out-Null
            $killed += $owner
        }
    }
    if (Test-Path $DevPidFile) {
        $savedPid = (Get-Content $DevPidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($savedPid -match '^\d+$' -and $killed -notcontains [int]$savedPid) {
            & taskkill /PID ([int]$savedPid) /T /F 2>&1 | Out-Null
            $killed += [int]$savedPid
        }
        Remove-Item $DevPidFile -Force -ErrorAction SilentlyContinue
    }
    return $killed
}

# ==== Stage 0: -Stop shortcut ====
if ($Stop) {
    Write-Step "Stopping any dev server on port $AppPort"
    $killed = Stop-DevServerOnPort -Port $AppPort
    if ($killed.Count -gt 0) { Write-OK "Stopped pid(s): $($killed -join ', ')" }
    else { Write-Warn "No listener found on port $AppPort" }
    exit 0
}

# ==== Stage 1: PostgreSQL service present ====
Write-Step "Stage 1/6 - Locating the local PostgreSQL Windows service"
$pgSvc = Get-Service -Name $PgServicePattern -ErrorAction SilentlyContinue |
    Sort-Object Name | Select-Object -First 1
if (-not $pgSvc) {
    Write-Fail "No 'postgresql*' Windows service found."
    Write-Host "    Install native PostgreSQL first, e.g.:" -ForegroundColor Yellow
    Write-Host "      winget install -e --id PostgreSQL.PostgreSQL.16 ``" -ForegroundColor Yellow
    Write-Host "        --override '--mode unattended --superpassword openmaic'" -ForegroundColor Yellow
    exit 1
}
Write-OK "Service [$($pgSvc.Name)] state = $($pgSvc.Status)"

# ==== Stage 2: ensure the service is running and the loopback port is open ====
Write-Step "Stage 2/6 - Ensuring PostgreSQL is running and listening on ${DbHost}:${DbPort}"
if ($pgSvc.Status -ne "Running") {
    Write-Warn "Service is not running - attempting Start-Service (needs admin if it was never started)..."
    try {
        Start-Service -Name $pgSvc.Name -ErrorAction Stop
        Write-OK "Start-Service issued for [$($pgSvc.Name)]"
    } catch {
        Write-Fail "Could not start [$($pgSvc.Name)]: $($_.Exception.Message)"
        Write-Host "    Start it manually (admin): Start-Service $($pgSvc.Name)" -ForegroundColor Yellow
        exit 1
    }
}
$dbUrl = "postgres://${DbUser}:${DbPassword}@${DbHost}:${DbPort}/${DbName}"
if (-not (Wait-ForTcp -TargetHost $DbHost -Port $DbPort -Seconds $DbWaitSec -Label "PostgreSQL")) {
    Write-Fail "PostgreSQL service is up but nothing is listening on ${DbHost}:${DbPort}."
    Write-Host "    Check listen_addresses in postgresql.conf and that the service reached 'Running'." -ForegroundColor Yellow
    exit 1
}
Write-OK "TCP open: ${DbHost}:${DbPort}"

# ==== Stage 3: verify DB credentials from the Windows side (real pg driver) ====
Write-Step "Stage 3/6 - Verifying database credentials (real pg driver)"
$env:DATABASE_URL = $dbUrl
$pgProbe = @'
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 6000 });
  try {
    await c.connect();
    const r = await c.query("select count(*)::int as n from information_schema.tables where table_schema='public'");
    console.log("PG_OK tables=" + r.rows[0].n);
  } catch (e) {
    console.log("PG_FAIL " + e.message);
    process.exitCode = 1;
  } finally { try { await c.end(); } catch (e) {} }
})();
'@
$pgOut = (Invoke-NodeStdin $pgProbe) -join "`n"
if ($pgOut -match "PG_OK tables=(\d+)") {
    # tables=0 is EXPECTED on a fresh database - the app bootstraps its schema on
    # first real connection (lib/persistence/server-provider.ts ensure*Schema).
    Write-OK "Connected. public tables = $($Matches[1]) (0 on a fresh DB is fine)"
} else {
    Write-Fail "Database check failed: $($pgOut.Trim())"
    Write-Host "    Ensure role '$DbUser' and database '$DbName' exist:" -ForegroundColor Yellow
    Write-Host "      psql -h 127.0.0.1 -U postgres -c `"CREATE ROLE $DbUser LOGIN PASSWORD '$DbPassword';`"" -ForegroundColor Yellow
    Write-Host "      psql -h 127.0.0.1 -U postgres -c `"CREATE DATABASE $DbName OWNER $DbUser;`"" -ForegroundColor Yellow
    exit 1
}

# ==== Stage 4: sync .env.local to the fixed loopback DATABASE_URL ====
Write-Step "Stage 4/6 - Syncing DATABASE_URL in .env.local to ${DbHost}:${DbPort}"
$envLocal = Join-Path $Root ".env.local"
if (-not (Test-Path $envLocal)) {
    Write-Fail ".env.local not found. Copy .env.example to .env.local first."
    exit 1
}
$lines = [System.IO.File]::ReadAllLines($envLocal)
$found = $false
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*DATABASE_URL\s*=') {
        if ($lines[$i] -ne "DATABASE_URL=$dbUrl") { $lines[$i] = "DATABASE_URL=$dbUrl" }
        $found = $true
        break
    }
}
if (-not $found) {
    $lines += "DATABASE_URL=$dbUrl"
}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($envLocal, $lines, $utf8NoBom)
Write-OK "DATABASE_URL -> postgres://${DbUser}:***@${DbHost}:${DbPort}/${DbName}"

# ==== Stage 5: .env.local Pro-mode flags ====
Write-Step "Stage 5/6 - Checking Pro-mode requirements in .env.local"
$envContent = [System.IO.File]::ReadAllText($envLocal)
$missing = @()
if ($envContent -notmatch "(?m)^\s*NEXT_PUBLIC_PRO_WORKBENCH_ENABLED\s*=\s*true") { $missing += "NEXT_PUBLIC_PRO_WORKBENCH_ENABLED=true" }
if ($envContent -notmatch "(?m)^\s*OPENMAIC_AGENT_RUNTIME_ENABLED\s*=\s*true")   { $missing += "OPENMAIC_AGENT_RUNTIME_ENABLED=true" }
if ($envContent -notmatch "(?m)^\s*DATABASE_URL\s*=\s*postgres://")             { $missing += "DATABASE_URL" }
if ($envContent -notmatch "(?m)^\s*MODEL_ROUTES\s*=.*maic-agent-driver")        { $missing += "MODEL_ROUTES (maic-agent-driver)" }
if ($missing.Count -gt 0) {
    Write-Fail ".env.local is missing: $($missing -join ', ')"
    exit 1
}
Write-OK "Pro-mode config present (workbench + runtime + DB + model route)"

# ==== Stage 6: toolchain + start dev server + health verification ====
Write-Step "Stage 6/6 - Starting Next.js production server on port $AppPort"
$nodeVer = (& node -v 2>&1).Trim()
$pnpmCmd = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if (-not $pnpmCmd) { $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue }
if (-not $pnpmCmd) { Write-Fail "pnpm not found on PATH"; exit 1 }
Write-OK "Node $nodeVer, pnpm $(& pnpm -v 2>&1)"

if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    Write-Warn "node_modules missing - running pnpm install (may take a while)..."
    Push-Location $Root; & pnpm install; Pop-Location
}

# Production start needs a build. NEXT_PUBLIC_* values are inlined at build
# time, so re-run `pnpm build` after changing them in .env.local.
if (-not (Test-Path (Join-Path $Root ".next\BUILD_ID"))) {
    Write-Fail "No production build found (.next missing). Run: pnpm build"
    exit 1
}

$stale = Stop-DevServerOnPort -Port $AppPort
if ($stale.Count -gt 0) {
    Write-Warn "Killed stale listener pid(s): $($stale -join ', ')"
    Start-Sleep -Seconds 1
}

if ($pnpmCmd.CommandType -eq "ExternalScript") {
    Write-Warn "pnpm resolved to $($pnpmCmd.Source) (ExternalScript) - will run via a PowerShell host"
}

# $env:DATABASE_URL is inherited by the child process as well (belt and braces).
$devPid = Start-DetachedDevServer -PnpmPath $pnpmCmd.Source `
    -WorkingDir $Root -LogFile $DevLogFile -ErrFile $DevErrFile
if (-not $devPid) {
    Write-Fail "Failed to launch the dev server (WMI Win32_Process.Create error)"
    exit 1
}
$devPid | Set-Content $DevPidFile -Encoding ascii
Write-OK "Server started (detached production mode, pid=$devPid)  (logs/dev.log)"

# ==== Health verification (proxy-agnostic) ====
Write-Step "Verifying endpoints (timeout ${AppWaitSec}s)"
$healthOk  = $false
$runtimeOk = $false
$agentsOk  = $false
$wsOk      = $false
$base      = "http://127.0.0.1:$AppPort"
$deadline  = (Get-Date).AddSeconds($AppWaitSec)

while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds $PollMs

    if (-not $healthOk) {
        $r = Invoke-Http "$base/api/health" 4
        if ($r.Code -eq 200) {
            try { $j = $r.Body | ConvertFrom-Json } catch { $j = $null }
            if ($j -and $j.status -eq "ok") { $healthOk = $true; Write-OK "GET /api/health -> 200 ($($j.status), v$($j.version))" }
        }
    }
    if ($healthOk -and -not $runtimeOk) {
        $r = Invoke-Http "$base/api/agent/runtime" 4
        if ($r.Code -eq 200) {
            try { $j = $r.Body | ConvertFrom-Json } catch { $j = $null }
            if ($j -and $j.enabled -eq $true -and $j.runtimeEnabled -eq $true) {
                $runtimeOk = $true; Write-OK "GET /api/agent/runtime -> enabled=true, runtimeEnabled=true (Pro runtime ON)"
            }
        }
    }
    if ($healthOk -and -not $agentsOk) {
        $r = Invoke-Http "$base/api/agent/sessions" 5
        if ($r.Code -eq 200) { $agentsOk = $true; Write-OK "GET /api/agent/sessions -> 200 (DB reachable through Pro runtime)" }
    }
    if ($healthOk -and -not $wsOk) {
        $r = Invoke-Http "$base/workspace" 30
        if ($r.Code -eq 200) { $wsOk = $true; Write-OK "GET /workspace -> 200 (Pro workbench reachable)" }
    }
    if ($healthOk -and $runtimeOk -and $agentsOk -and $wsOk) { break }
}

if (-not $healthOk) {
    Write-Fail "Dev server never answered /api/health at $base"
    Write-Host "--- logs/dev.err.log (tail) ---" -ForegroundColor DarkGray
    Get-Content $DevErrFile -Tail 25 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    Write-Host "--- logs/dev.log (tail) ---" -ForegroundColor DarkGray
    Get-Content $DevLogFile -Tail 25 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    Stop-DevServerOnPort -Port $AppPort | Out-Null
    exit 1
}
if (-not $runtimeOk) { Write-Warn "Agent runtime endpoint not fully up yet (schema may still be initializing)" }
if (-not $agentsOk)  { Write-Warn "/api/agent/sessions did not return 200" }
if (-not $wsOk)      { Write-Warn "/workspace did not return 200" }

# ==== Summary ====
Write-Host ""
Write-Host "================================================" -ForegroundColor Magenta
Write-Host "  openmaic dev stack is UP" -ForegroundColor Magenta
Write-Host "  App:      http://localhost:$AppPort" -ForegroundColor White
Write-Host "  Pro:      http://localhost:$AppPort/workspace" -ForegroundColor White
Write-Host "  DB:       postgres://${DbUser}:***@${DbHost}:${DbPort}/${DbName}  (native Windows, loopback)" -ForegroundColor White
Write-Host "  health=$(if($healthOk){'OK'}else{'FAIL'})  runtime=$(if($runtimeOk){'OK'}else{'DEGRADED'})  sessions=$(if($agentsOk){'OK'}else{'FAIL'})  workspace=$(if($wsOk){'OK'}else{'FAIL'})" -ForegroundColor White
Write-Host "  Dev logs: logs/dev.log  |  logs/dev.err.log  (pid in logs/dev.pid)" -ForegroundColor DarkGray
if ($NoWait) {
    Write-Host "  Server left running detached. Stop it with: scripts/dev-all.ps1 -Stop" -ForegroundColor DarkGray
} else {
    Write-Host "  Press Ctrl+C to stop the stack." -ForegroundColor DarkGray
}
Write-Host "================================================" -ForegroundColor Magenta

if ($NoWait) { exit 0 }

# ==== Stay alive; clean up on exit ====
try {
    Wait-Process -Id $devPid -ErrorAction SilentlyContinue
    Write-Warn "Dev server launcher (pid=$devPid) exited - last log lines:"
    Get-Content $DevLogFile -Tail 30 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
} finally {
    Write-Host ""
    Write-Host "Cleaning up..." -ForegroundColor Yellow
    Stop-DevServerOnPort -Port $AppPort | Out-Null
    Write-Host "Done." -ForegroundColor Green
}
