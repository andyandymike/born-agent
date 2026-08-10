[CmdletBinding()]
param(
  [Parameter()]
  [ValidatePattern('^[^/]+/[^/]+$')]
  [string] $Repository = 'andyandymike/born-agent',

  [Parameter()]
  [ValidatePattern('^https://')]
  [string] $PagesUrl = 'https://andyandymike.github.io/born-agent/',

  [Parameter()]
  [string] $InvariantRulesetName = 'Protect default branch invariants',

  [Parameter()]
  [string] $ContributionRulesetName = 'Require reviewed default branch changes',

  [Parameter()]
  [string] $LocalDeployKeyTitle = 'BornAgent local main push',

  [Parameter()]
  [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$apiHeaders = @(
  '-H', 'Accept: application/vnd.github+json',
  '-H', 'X-GitHub-Api-Version: 2022-11-28'
)

function Assert-GitHubAuthentication {
  & gh auth status *> $null
  if ($LASTEXITCODE -ne 0) {
    throw 'GitHub CLI authentication is required. Set GH_TOKEN or authenticate with `gh auth login --with-token`, then rerun this script.'
  }
}

function Invoke-GitHubApi {
  param(
    [Parameter(Mandatory)]
    [ValidateSet('GET', 'POST', 'PUT', 'PATCH')]
    [string] $Method,

    [Parameter(Mandatory)]
    [string] $Endpoint,

    [Parameter()]
    [AllowNull()]
    [object] $Body = $null
  )

  if ($null -eq $Body) {
    $output = & gh api --method $Method @apiHeaders $Endpoint
  }
  else {
    $json = $Body | ConvertTo-Json -Depth 24 -Compress
    $output = $json | & gh api --method $Method @apiHeaders $Endpoint --input -
  }

  if ($LASTEXITCODE -ne 0) {
    throw "GitHub API request failed: $Method $Endpoint"
  }

  if ([string]::IsNullOrWhiteSpace(($output -join "`n"))) {
    return $null
  }

  return (($output -join "`n") | ConvertFrom-Json)
}

function Invoke-GitHubEmptyPut {
  param(
    [Parameter(Mandatory)]
    [string] $Endpoint
  )

  & gh api --method PUT @apiHeaders $Endpoint --silent
  if ($LASTEXITCODE -ne 0) {
    throw "GitHub API request failed: PUT $Endpoint"
  }
}

function Test-GitHubEndpoint {
  param(
    [Parameter(Mandatory)]
    [string] $Endpoint
  )

  & gh api --method GET @apiHeaders $Endpoint --silent 2>$null
  return ($LASTEXITCODE -eq 0)
}

$repositorySettings = [ordered]@{
  description = 'A learning-first, local-first coding agent with explicit authority and durable evidence.'
  homepage = $PagesUrl
  has_issues = $true
  has_projects = $false
  has_wiki = $false
  has_discussions = $false
  allow_squash_merge = $true
  allow_merge_commit = $false
  allow_rebase_merge = $true
  allow_auto_merge = $true
  delete_branch_on_merge = $true
  allow_update_branch = $true
  squash_merge_commit_title = 'PR_TITLE'
  squash_merge_commit_message = 'PR_BODY'
  web_commit_signoff_required = $true
}

$topics = [ordered]@{
  names = @(
    'ai-agent',
    'coding-agent',
    'developer-tools',
    'local-first',
    'ollama',
    'typescript'
  )
}

$workflowPermissions = [ordered]@{
  default_workflow_permissions = 'read'
  can_approve_pull_request_reviews = $false
}

$pagesSource = [ordered]@{
  source = [ordered]@{
    branch = 'main'
    path = '/docs'
  }
}

if ($DryRun) {
  [ordered]@{
    repository = $Repository
    repository_settings = $repositorySettings
    topics = $topics
    workflow_permissions = $workflowPermissions
    pages = $pagesSource
    rulesets = @(
      [ordered]@{
        name = $InvariantRulesetName
        target = 'branch'
        enforcement = 'active'
        bypass_actor = 'none'
        target_ref = '~DEFAULT_BRANCH'
        rules = @('deletion', 'non_fast_forward', 'required_linear_history')
      },
      [ordered]@{
        name = $ContributionRulesetName
        target = 'branch'
        enforcement = 'active'
        bypass_actor = "write deploy key '$LocalDeployKeyTitle'"
        target_ref = '~DEFAULT_BRANCH'
        rules = @('pull_request', 'required_status_checks:quality')
      }
    )
    security = @('vulnerability alerts', 'automated security fixes', 'private vulnerability reporting', 'secret scanning', 'push protection')
  } | ConvertTo-Json -Depth 12
  exit 0
}

Assert-GitHubAuthentication

$repositoryState = Invoke-GitHubApi -Method GET -Endpoint "repos/$Repository"
if (-not $repositoryState.permissions.admin) {
  throw "The authenticated GitHub account does not have admin permission for $Repository."
}

if (-not (Test-GitHubEndpoint -Endpoint "repos/$Repository/contents/docs/index.html?ref=main")) {
  throw 'docs/index.html is not present on remote main. Commit and push the local open-source setup before applying Pages and branch rules.'
}

if (-not (Test-GitHubEndpoint -Endpoint "repos/$Repository/contents/.github/workflows/ci.yml?ref=main")) {
  throw 'The CI workflow is not present on remote main. Push it before requiring the quality status check.'
}

$completedCiRuns = Invoke-GitHubApi -Method GET -Endpoint "repos/$Repository/actions/workflows/ci.yml/runs?branch=main&status=completed&per_page=1"
$latestCiRun = @($completedCiRuns.workflow_runs) | Select-Object -First 1
if ($null -eq $latestCiRun -or $latestCiRun.conclusion -ne 'success') {
  throw 'The CI workflow has no successful completed run on main. Wait for quality to pass before applying the required status check.'
}

$deployKeys = @(Invoke-GitHubApi -Method GET -Endpoint "repos/$Repository/keys")
$writeDeployKeys = @($deployKeys | Where-Object { $_.read_only -eq $false })
$localDeployKeys = @($writeDeployKeys | Where-Object { $_.title -eq $LocalDeployKeyTitle })
if ($writeDeployKeys.Count -ne 1 -or $localDeployKeys.Count -ne 1) {
  throw "Exactly one write-enabled deploy key named '$LocalDeployKeyTitle' is required before enabling the local-machine bypass."
}

$invariantRuleset = [ordered]@{
  name = $InvariantRulesetName
  target = 'branch'
  enforcement = 'active'
  bypass_actors = @()
  conditions = [ordered]@{
    ref_name = [ordered]@{
      include = @('~DEFAULT_BRANCH')
      exclude = @()
    }
  }
  rules = @(
    [ordered]@{ type = 'deletion' },
    [ordered]@{ type = 'non_fast_forward' },
    [ordered]@{ type = 'required_linear_history' }
  )
}

$contributionRuleset = [ordered]@{
  name = $ContributionRulesetName
  target = 'branch'
  enforcement = 'active'
  bypass_actors = @(
    [ordered]@{
      actor_id = $null
      actor_type = 'DeployKey'
      bypass_mode = 'always'
    }
  )
  conditions = [ordered]@{
    ref_name = [ordered]@{
      include = @('~DEFAULT_BRANCH')
      exclude = @()
    }
  }
  rules = @(
    [ordered]@{
      type = 'pull_request'
      parameters = [ordered]@{
        allowed_merge_methods = @('squash', 'rebase')
        dismiss_stale_reviews_on_push = $true
        require_code_owner_review = $false
        require_last_push_approval = $false
        required_approving_review_count = 1
        required_review_thread_resolution = $true
      }
    },
    [ordered]@{
      type = 'required_status_checks'
      parameters = [ordered]@{
        do_not_enforce_on_create = $true
        required_status_checks = @(
          [ordered]@{ context = 'quality' }
        )
        strict_required_status_checks_policy = $true
      }
    }
  )
}

Write-Host "Configuring repository settings for $Repository..."
$null = Invoke-GitHubApi -Method PATCH -Endpoint "repos/$Repository" -Body $repositorySettings
$null = Invoke-GitHubApi -Method PUT -Endpoint "repos/$Repository/topics" -Body $topics
$null = Invoke-GitHubApi -Method PUT -Endpoint "repos/$Repository/actions/permissions/workflow" -Body $workflowPermissions

Write-Host 'Configuring GitHub Pages from main:/docs...'
if (Test-GitHubEndpoint -Endpoint "repos/$Repository/pages") {
  $null = Invoke-GitHubApi -Method PUT -Endpoint "repos/$Repository/pages" -Body $pagesSource
}
else {
  $null = Invoke-GitHubApi -Method POST -Endpoint "repos/$Repository/pages" -Body $pagesSource
}

Write-Host 'Enabling repository security features...'
Invoke-GitHubEmptyPut -Endpoint "repos/$Repository/vulnerability-alerts"
Invoke-GitHubEmptyPut -Endpoint "repos/$Repository/automated-security-fixes"
Invoke-GitHubEmptyPut -Endpoint "repos/$Repository/private-vulnerability-reporting"

try {
  $securitySettings = [ordered]@{
    security_and_analysis = [ordered]@{
      secret_scanning = [ordered]@{ status = 'enabled' }
      secret_scanning_push_protection = [ordered]@{ status = 'enabled' }
    }
  }
  $null = Invoke-GitHubApi -Method PATCH -Endpoint "repos/$Repository" -Body $securitySettings
}
catch {
  Write-Warning 'Secret scanning or push protection could not be changed for this repository or plan. Other settings remain applied.'
}

Write-Host 'Creating or updating default-branch rulesets...'
$existingRulesets = @(Invoke-GitHubApi -Method GET -Endpoint "repos/$Repository/rulesets")
foreach ($ruleset in @($invariantRuleset, $contributionRuleset)) {
  $existingRuleset = $existingRulesets | Where-Object { $_.name -eq $ruleset.name } | Select-Object -First 1
  if ($null -eq $existingRuleset) {
    $null = Invoke-GitHubApi -Method POST -Endpoint "repos/$Repository/rulesets" -Body $ruleset
  }
  else {
    $null = Invoke-GitHubApi -Method PUT -Endpoint "repos/$Repository/rulesets/$($existingRuleset.id)" -Body $ruleset
  }
}

$finalRepository = Invoke-GitHubApi -Method GET -Endpoint "repos/$Repository"
$finalPages = Invoke-GitHubApi -Method GET -Endpoint "repos/$Repository/pages"
$finalRulesets = @(Invoke-GitHubApi -Method GET -Endpoint "repos/$Repository/rulesets")
$finalDeployKeys = @(Invoke-GitHubApi -Method GET -Endpoint "repos/$Repository/keys")

[ordered]@{
  repository = $finalRepository.full_name
  visibility = $finalRepository.visibility
  homepage = $finalRepository.homepage
  pages_url = $finalPages.html_url
  pages_source = "$($finalPages.source.branch):$($finalPages.source.path)"
  rulesets = @($finalRulesets | ForEach-Object { $_.name })
  write_deploy_keys = @($finalDeployKeys | Where-Object { $_.read_only -eq $false } | ForEach-Object { $_.title })
  default_workflow_permissions = 'read'
  private_vulnerability_reporting = 'enabled'
} | ConvertTo-Json -Depth 8
