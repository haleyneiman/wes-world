<#
Creates every Azure resource Wes World needs, on the currently signed-in
subscription, with the cost-safe options baked in.

    az login                      # must show a subscription first
    ./tools/provision-azure.ps1

Safe to re-run: every step checks for an existing resource before creating one,
so a partial run can simply be repeated.

Nothing here provisions anything outside the always-free tiers:
  • Cosmos DB account with the free-tier discount applied (1000 RU/s + 25 GB)
  • the database at 400 RU/s manual shared throughput, inside that grant
  • Static Web App on the Free SKU
The script refuses to continue rather than silently creating a billable Cosmos
account if the free tier is unavailable.
#>

[CmdletBinding()]
param(
  [string]$ResourceGroup = 'wes-world-rg',
  [string]$Location      = 'eastus2',        # also a valid Static Web Apps region
  [string]$CosmosAccount = '',               # default: wesworld-db-<random>
  [string]$SwaName       = 'wes-world',
  [string]$DatabaseName  = 'wesworld',
  [string]$ContainerName = 'entries',
  [string]$Repo          = 'haleyneiman/wes-world',
  [switch]$SkipGitHubSecret
)

$ErrorActionPreference = 'Stop'

# az is often installed without being on PATH.
$az = (Get-Command az -ErrorAction SilentlyContinue).Source
if (-not $az) {
  $candidate = "C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd"
  if (Test-Path $candidate) { $az = $candidate } else { throw "Azure CLI not found." }
}

function Invoke-Az {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  $out = & $az @Args 2>&1
  if ($LASTEXITCODE -ne 0) { throw "az $($Args -join ' ')`n$out" }
  return ($out | Out-String)
}

# "does this resource exist?" — a non-zero exit is the answer, not a failure.
function Test-Az {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  & $az @Args -o none 2>$null | Out-Null
  return ($LASTEXITCODE -eq 0)
}

Write-Host "`n=== Account ===" -ForegroundColor Cyan
$acct = Invoke-Az account show -o json | ConvertFrom-Json
Write-Host ("Subscription : {0}" -f $acct.name)
Write-Host ("Signed in as : {0}" -f $acct.user.name)

# One free-tier Cosmos account is allowed per subscription. Creating a second
# silently drops the discount, which is the single most expensive mistake here.
Write-Host "`n=== Checking for an existing free-tier Cosmos account ===" -ForegroundColor Cyan
$existingFree = (Invoke-Az cosmosdb list --query "[?enableFreeTier].{name:name,rg:resourceGroup}" -o json | ConvertFrom-Json)
if ($existingFree -and $existingFree.Count -gt 0) {
  Write-Host "This subscription already has a free-tier Cosmos account:" -ForegroundColor Yellow
  $existingFree | ForEach-Object { Write-Host ("  {0} (rg: {1})" -f $_.name, $_.rg) -ForegroundColor Yellow }
  Write-Host "Re-run with -CosmosAccount <that name> to reuse it, or delete it first." -ForegroundColor Yellow
  if (-not $CosmosAccount) { throw "Refusing to create a second Cosmos account that would not be free." }
}

if (-not $CosmosAccount) {
  $CosmosAccount = "wesworld-db-" + ([guid]::NewGuid().ToString('N').Substring(0, 8))
}

Write-Host "`n=== Resource group: $ResourceGroup ===" -ForegroundColor Cyan
Invoke-Az group create --name $ResourceGroup --location $Location -o none | Out-Null
Write-Host "ok"

Write-Host "`n=== Cosmos account: $CosmosAccount ===" -ForegroundColor Cyan
$cosmosExists = Test-Az cosmosdb show --name $CosmosAccount --resource-group $ResourceGroup
if ($cosmosExists) {
  Write-Host "already exists, reusing"
} else {
  Write-Host "creating (a few minutes)..."
  Invoke-Az cosmosdb create --name $CosmosAccount --resource-group $ResourceGroup `
    --locations "regionName=$Location" --enable-free-tier true `
    --default-consistency-level Session -o none | Out-Null
  Write-Host "ok"
}

# Verify the discount actually applied — it can only be set at creation time.
$freeTier = (Invoke-Az cosmosdb show --name $CosmosAccount --resource-group $ResourceGroup --query enableFreeTier -o tsv).Trim()
if ($freeTier -ne 'true') {
  throw "Cosmos account $CosmosAccount does NOT have the free tier applied (enableFreeTier=$freeTier). " +
        "It cannot be added later. Delete the account and re-run."
}
Write-Host "free tier: applied" -ForegroundColor Green

Write-Host "`n=== Database: $DatabaseName (400 RU/s manual, shared) ===" -ForegroundColor Cyan
$dbExists = Test-Az cosmosdb sql database show --account-name $CosmosAccount --resource-group $ResourceGroup --name $DatabaseName
if ($dbExists) { Write-Host "already exists" } else {
  Invoke-Az cosmosdb sql database create --account-name $CosmosAccount --resource-group $ResourceGroup `
    --name $DatabaseName --throughput 400 -o none | Out-Null
  Write-Host "ok"
}

Write-Host "`n=== Container: $ContainerName (partition key /kind) ===" -ForegroundColor Cyan
$cExists = Test-Az cosmosdb sql container show --account-name $CosmosAccount --resource-group $ResourceGroup --database-name $DatabaseName --name $ContainerName
if ($cExists) { Write-Host "already exists" } else {
  Invoke-Az cosmosdb sql container create --account-name $CosmosAccount --resource-group $ResourceGroup `
    --database-name $DatabaseName --name $ContainerName --partition-key-path "/kind" -o none | Out-Null
  Write-Host "ok"
}

Write-Host "`n=== Static Web App: $SwaName (Free) ===" -ForegroundColor Cyan
$swaExists = Test-Az staticwebapp show --name $SwaName --resource-group $ResourceGroup
if ($swaExists) { Write-Host "already exists, reusing" } else {
  Invoke-Az staticwebapp create --name $SwaName --resource-group $ResourceGroup `
    --location $Location --sku Free -o none | Out-Null
  Write-Host "ok"
}
$swaHost = (Invoke-Az staticwebapp show --name $SwaName --resource-group $ResourceGroup --query defaultHostname -o tsv).Trim()

Write-Host "`n=== Wiring the connection string into the app ===" -ForegroundColor Cyan
$conn = (Invoke-Az cosmosdb keys list --name $CosmosAccount --resource-group $ResourceGroup `
  --type connection-strings --query "connectionStrings[?keyKind=='Primary'].connectionString | [0]" -o tsv).Trim()
if (-not $conn) { throw "Could not read the Cosmos connection string." }
Invoke-Az staticwebapp appsettings set --name $SwaName --resource-group $ResourceGroup `
  --setting-names "COSMOS_CONNECTION_STRING=$conn" -o none | Out-Null
Write-Host "COSMOS_CONNECTION_STRING set (value not printed)"

if (-not $SkipGitHubSecret) {
  Write-Host "`n=== Deployment token -> GitHub secret ===" -ForegroundColor Cyan
  $token = (Invoke-Az staticwebapp secrets list --name $SwaName --resource-group $ResourceGroup `
    --query "properties.apiKey" -o tsv).Trim()
  if (-not $token) { throw "Could not read the deployment token." }
  # Piped, never echoed, so the token stays out of the console and shell history.
  $token | & gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN --repo $Repo
  if ($LASTEXITCODE -ne 0) { throw "gh secret set failed. Is gh installed and authenticated?" }
  Write-Host "AZURE_STATIC_WEB_APPS_API_TOKEN updated (value not printed)"
}

Write-Host "`n=== Done ===" -ForegroundColor Green
Write-Host ("Site        : https://{0}" -f $swaHost)
Write-Host ("Cosmos      : {0} / {1} / {2}" -f $CosmosAccount, $DatabaseName, $ContainerName)
Write-Host ("Resource gp : {0}" -f $ResourceGroup)
Write-Host @"

Next:
  1. gh workflow run "Deploy to Azure Static Web Apps" --ref azure-backend
  2. Open the site, sign in, and invite yourself:
       az staticwebapp users invite --name $SwaName --resource-group $ResourceGroup ``
         --authentication-provider AAD --user-details <your-email> --role family ``
         --domain $swaHost --invitation-expiration-in-hours 24
  3. Migrate Firebase data (see AZURE-SETUP.md step 4)
"@
