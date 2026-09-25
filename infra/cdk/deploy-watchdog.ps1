<#
.SYNOPSIS
  Runs `cdk deploy` with a stall watchdog.

.DESCRIPTION
  From this machine the CDK asset publisher intermittently hangs forever on its first call to
  the ECR API (an HTTPS connection that never answers; the AWS SDK has no request timeout).
  The symptom is a log that stops right after a "check: Check 176032258686.dkr.ecr..." line.
  This script starts the deploy, watches its log, kills the whole process tree when the log
  has not moved for -StallSeconds, clears cdk.out lock files and retries. A deploy that
  actually progresses (CloudFormation events, docker build) writes to the log continuously,
  so real work is never interrupted.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File infra/cdk/deploy-watchdog.ps1
  powershell -ExecutionPolicy Bypass -File infra/cdk/deploy-watchdog.ps1 -Stacks "MailApp-prod-Compute"
#>
param(
  [string]$Stacks = "MailApp-prod-Data MailApp-prod-Messaging MailApp-prod-Compute",
  [int]$MaxAttempts = 6,
  [int]$StallSeconds = 120,
  # Test hook: run this command line instead of cdk (e.g. "ping -n 400 127.0.0.1").
  [string]$CommandOverride = ""
)

$ErrorActionPreference = "Stop"
$cdkDir = $PSScriptRoot
$logDir = Join-Path $env:TEMP "cdk-deploy-logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
  $log = Join-Path $logDir ("deploy-{0}-{1}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"), $attempt)
  Write-Host ("[watchdog] attempt {0}/{1}: cdk deploy {2}  (log: {3})" -f $attempt, $MaxAttempts, $Stacks, $log)
  Get-ChildItem (Join-Path $cdkDir "cdk.out") -Filter "*.lock" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

  $inner = if ($CommandOverride) { $CommandOverride } else { "npx cdk deploy $Stacks --require-approval never --progress events -v" }
  $cmd = "$inner > `"$log`" 2>&1"
  $proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $cmd -WorkingDirectory $cdkDir -PassThru -WindowStyle Hidden
  $lastSize = -1
  $lastChange = Get-Date
  $stalled = $false

  # NTFS reports a stale size for a file another process holds open, so measure the readable
  # content instead of the directory entry.
  function Get-LogLength([string]$path) {
    try {
      $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
      try { return $fs.Length } finally { $fs.Dispose() }
    } catch { return 0 }
  }

  while (-not $proc.HasExited) {
    Start-Sleep -Seconds 10
    $size = Get-LogLength $log
    if ($size -ne $lastSize) {
      $lastSize = $size
      $lastChange = Get-Date
      $tail = Get-Content $log -Tail 1 -ErrorAction SilentlyContinue
      if ($tail) { Write-Host ("[watchdog] " + $tail.Substring(0, [Math]::Min(140, $tail.Length))) }
    } else {
      $idle = [int]((Get-Date) - $lastChange).TotalSeconds
      if ($idle -ge $StallSeconds) {
        Write-Warning ("[watchdog] no log output for {0}s; killing the stalled deploy and retrying" -f $idle)
        taskkill /PID $proc.Id /T /F | Out-Null
        $stalled = $true
        break
      }
      if ($idle -ge 60) { Write-Host ("[watchdog] quiet for {0}s" -f $idle) }
    }
  }

  if (-not $stalled) {
    $proc.WaitForExit()
    if ($proc.ExitCode -eq 0) {
      Write-Host "[watchdog] deploy succeeded"
      Get-Content $log | Select-String -Pattern "✅|Outputs|Total time|InboundMxRecord|RunMigrationsCommand" | ForEach-Object { $_.Line }
      exit 0
    }
    Write-Warning ("[watchdog] cdk exited with code {0}; last lines:" -f $proc.ExitCode)
    Get-Content $log -Tail 25
    exit $proc.ExitCode
  }
  Start-Sleep -Seconds 5
}

Write-Error ("[watchdog] gave up after {0} stalled attempts" -f $MaxAttempts)
exit 1
