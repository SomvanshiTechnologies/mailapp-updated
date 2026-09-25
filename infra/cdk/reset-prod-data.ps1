<#
.SYNOPSIS
  Wipes all campaign data in production and starts fresh, keeping configuration.

.DESCRIPTION
  1. Runs apps/api/scripts/reset-data.cjs inside the production image as a one-off ECS task
     (the migrate task definition with a command override, so no deploy is needed). That truncates
     campaigns, leads, emails, events, files, audit log, suppressions and queued jobs; users,
     settings, services, instruction documents and the link page are kept.
  2. Deletes the uploaded lead sheets and stored inbound mail from the two S3 buckets.
  3. Restarts the api and worker services so in-process counters on the System page start at zero.
  4. Deletes the CloudWatch log streams of tasks that are no longer running.

  The suppression list is printed to the task log (line "SUPPRESSIONS_BACKUP") before deletion and
  the whole task log is saved next to this script's log directory in %TEMP%\mailapp-reset.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File infra/cdk/reset-prod-data.ps1 -Yes
#>
param(
  [switch]$Yes,
  [string]$Region = "ap-south-1",
  [string]$Cluster = "mailapp-prod",
  [string]$EnvName = "prod",
  [switch]$SkipLogs
)

$ErrorActionPreference = "Stop"
if (-not $Yes) {
  Write-Host "This deletes every campaign, lead, email, event, upload, audit entry and suppression in production."
  Write-Host "Re-run with -Yes to proceed."
  exit 2
}

$repo = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$script = [string][IO.File]::ReadAllText((Join-Path $repo "apps\api\scripts\reset-data.cjs"))
$outDir = Join-Path $env:TEMP "mailapp-reset"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Invoke-Aws { $out = & aws.exe @args --region $Region --output json; if ($LASTEXITCODE -ne 0) { throw "aws $($args[0]) $($args[1]) failed" }; if ($out) { $out | ConvertFrom-Json } }

# ---- 1. database reset via one-off task ----
$stack = Invoke-Aws cloudformation describe-stacks --stack-name "MailApp-$EnvName-Compute"
$runCmd = ($stack.Stacks[0].Outputs | Where-Object OutputKey -eq "RunMigrationsCommand").OutputValue
if (-not $runCmd) { throw "RunMigrationsCommand output not found" }
$netcfg = [regex]::Match($runCmd, '--network-configuration "([^"]+)"').Groups[1].Value
$taskDef = [regex]::Match($runCmd, '--task-definition (\S+)').Groups[1].Value

$td = Invoke-Aws ecs describe-task-definition --task-definition $taskDef
$env = @{}; foreach ($e in $td.taskDefinition.containerDefinitions[0].environment) { $env[$e.name] = $e.value }
$storageBucket = $env["STORAGE_S3_BUCKET"]; $storagePrefix = $env["STORAGE_S3_PREFIX"]
$inboundBucket = $env["SES_INBOUND_BUCKET"]; $inboundPrefix = $env["SES_INBOUND_PREFIX"]

$overrides = @{ containerOverrides = @(@{ name = "migrate"; command = @("node", "-e", $script) }) } | ConvertTo-Json -Depth 5 -Compress
$ovFile = Join-Path $outDir "overrides.json"
[IO.File]::WriteAllText($ovFile, $overrides)

Write-Host "[reset] starting reset task ($taskDef)"
$run = Invoke-Aws ecs run-task --cluster $Cluster --launch-type FARGATE --task-definition $taskDef --network-configuration $netcfg --overrides "file://$ovFile"
if ($run.failures) { throw ("run-task failed: " + ($run.failures | ConvertTo-Json -Compress)) }
$taskArn = $run.tasks[0].taskArn
$taskId = $taskArn.Split("/")[-1]
Write-Host "[reset] task $taskId; waiting"
& aws.exe ecs wait tasks-stopped --cluster $Cluster --tasks $taskArn --region $Region
$desc = Invoke-Aws ecs describe-tasks --cluster $Cluster --tasks $taskArn
$container = $desc.tasks[0].containers[0]
$logFile = Join-Path $outDir ("reset-{0}-{1}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"), $taskId)
Start-Sleep -Seconds 5
$events = Invoke-Aws logs get-log-events --log-group-name "/mailapp/$EnvName/migrate" --log-stream-name "migrate/migrate/$taskId" --start-from-head
$events.events | ForEach-Object { $_.message } | Set-Content $logFile
Write-Host "[reset] task log saved to $logFile"
Get-Content $logFile | Where-Object { $_ -notmatch "^SUPPRESSIONS_BACKUP|^JOBS_BEFORE" } | ForEach-Object { Write-Host "  $_" }
if ($container.exitCode -ne 0 -or -not (Select-String -Path $logFile -Pattern "RESET DONE" -Quiet)) {
  throw "reset task did not complete (exit code $($container.exitCode)); see $logFile"
}

# ---- 2. S3 objects ----
Write-Host "[reset] emptying s3://$storageBucket/$storagePrefix and s3://$inboundBucket/$inboundPrefix"
& aws.exe s3 rm "s3://$storageBucket/$storagePrefix" --recursive --region $Region --only-show-errors
& aws.exe s3 rm "s3://$inboundBucket/$inboundPrefix" --recursive --region $Region --only-show-errors

# ---- 3. restart services so in-memory counters reset ----
$svcs = (Invoke-Aws ecs list-services --cluster $Cluster).serviceArns | ForEach-Object { $_.Split("/")[-1] }
foreach ($s in $svcs) {
  Write-Host "[reset] restarting service $s"
  Invoke-Aws ecs update-service --cluster $Cluster --service $s --force-new-deployment | Out-Null
}
Write-Host "[reset] waiting for services to stabilise"
& aws.exe ecs wait services-stable --cluster $Cluster --services @($svcs) --region $Region

# ---- 4. old log streams ----
if (-not $SkipLogs) {
  $running = (Invoke-Aws ecs list-tasks --cluster $Cluster).taskArns | ForEach-Object { $_.Split("/")[-1] }
  foreach ($g in "/mailapp/$EnvName/api", "/mailapp/$EnvName/worker", "/mailapp/$EnvName/migrate") {
    $streams = (Invoke-Aws logs describe-log-streams --log-group-name $g).logStreams | ForEach-Object { $_.logStreamName }
    foreach ($st in $streams) {
      $id = $st.Split("/")[-1]
      if ($running -contains $id -or $id -eq $taskId) { continue }
      & aws.exe logs delete-log-stream --log-group-name $g --log-stream-name $st --region $Region
    }
    Write-Host "[reset] cleared old streams in $g"
  }
}

Write-Host "[reset] done. Suppression backup and full output: $logFile"
