# ---------------------------------------------------------------------------
# One-shot deploy for "IT News for NSCT Team".
# Run this in your OWN PowerShell terminal (where you can complete the
# GitHub browser login). Usage:  ./deploy.ps1
# ---------------------------------------------------------------------------
$ErrorActionPreference = "Stop"
$RepoName = "IT-news-for-NSCT-team"
$User     = "jack020619"

Write-Host "==> Checking GitHub auth..." -ForegroundColor Cyan
gh auth status
if ($LASTEXITCODE -ne 0) {
    Write-Host "==> Not logged in. Starting login (follow the browser prompts)..." -ForegroundColor Yellow
    gh auth login --hostname github.com --git-protocol https --web
}

Write-Host "==> Creating the repo (skips if it already exists)..." -ForegroundColor Cyan
gh repo create "$User/$RepoName" --public --source . --remote origin --push 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "    Repo may already exist; wiring up remote + pushing instead." -ForegroundColor Yellow
    git remote remove origin 2>$null
    git remote add origin "https://github.com/$User/$RepoName.git"
    git push -u origin main
}

Write-Host "==> Enabling GitHub Pages (source = GitHub Actions)..." -ForegroundColor Cyan
try {
    gh api -X POST "repos/$User/$RepoName/pages" -f "build_type=workflow" | Out-Null
} catch {
    # Already enabled — update it instead.
    gh api -X PUT "repos/$User/$RepoName/pages" -f "build_type=workflow" | Out-Null
}

Write-Host "==> Triggering the first build..." -ForegroundColor Cyan
gh workflow run "daily.yml" 2>$null

Write-Host ""
Write-Host "Done! Your site will be live in ~1-2 minutes at:" -ForegroundColor Green
Write-Host "   https://$User.github.io/$RepoName/" -ForegroundColor Green
Write-Host "Watch the build: gh run watch" -ForegroundColor DarkGray
