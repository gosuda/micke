# install.ps1 — one command to a background micke on Windows.
#
# WHY a PS 5.1 script: 5.1 ships in the box on every Windows 10/11, so the
# `irm ... | iex` path needs nothing installed. The install is download ->
# verify -> swap -> register; the swap is the Windows dance: a RUNNING exe
# may be renamed but not overwritten, so micke.exe steps aside as
# micke.old.exe before the verified candidate takes its name — the same
# mechanics as `micke upgrade` (src/selfupdate.ts). Re-running the script IS
# the upgrade path: the new binary lands at the same path and
# `micke service install` re-registers and starts it.
#
# Usage:
#   irm https://raw.githubusercontent.com/gosuda/micke/main/install.ps1 | iex
#   & .\install.ps1 -Version v0.2.0
#
# Params/env: -Version (default latest), -Repo (default gosuda/micke);
#   $env:MICKE_RELEASE_BASE overrides the whole releases base URL
#   (mirrors, air-gapped hosts) and wins over -Repo.
#
# PS 5.1 only: no ?? operator, no ternary — both are PS 7+ syntax.

param(
    [string]$Version = "latest",
    [string]$Repo = "gosuda/micke"
)

$ErrorActionPreference = "Stop"

# PS 5.1 on older Windows does not enable TLS 1.2 by default; github.com
# (and most mirrors) refuse anything older.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Base = if ($env:MICKE_RELEASE_BASE) { $env:MICKE_RELEASE_BASE } else { "https://github.com/$Repo/releases" }

switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" { $Arch = "amd64" }
    "ARM64" { $Arch = "arm64" }
    default { throw "micke: unsupported processor architecture '$env:PROCESSOR_ARCHITECTURE' — no micke release for it" }
}

$tag = $Version
if ($Version -eq "latest") {
    # /releases/latest answers 302 -> <base>/tag/<tag>. With
    # -MaximumRedirection 0, PS 5.1 THROWS on the redirect, and the Location
    # header rides on the thrown WebException's response — read it there.
    # GitHub sends an absolute Location; a mirror may send a relative one, so
    # rebase relative values against $Base. Fallback if a mirror serves the
    # URL as a plain 200 page: no tag can be discovered — this script fails
    # and the user pins one with -Version <tag>.
    $location = $null
    $notRedirect = $null
    try {
        $resp = Invoke-WebRequest -Uri "$Base/releases/latest" -MaximumRedirection 0 -UseBasicParsing
        $notRedirect = "HTTP $($resp.StatusCode)" # 200 page, not a redirect
    } catch {
        $response = $_.Exception.Response
        if ($response -and $response.Headers) {
            # PS 5.1 (.NET Framework): the header collection is a plain
            # WebHeaderCollection — index it by name. PS 7 exposes typed
            # HttpResponseMessageHeaders where .Location is a property; try
            # both so the script runs under either PowerShell.
            $location = $response.Headers["Location"]
            if (-not $location -and $response.Headers.Location) {
                $location = [string]$response.Headers.Location
            }
        }
    }
    if (-not $location) {
        if ($notRedirect) {
            throw "micke: $Base/releases/latest answered $notRedirect, expected a redirect — pin a version with -Version <tag>"
        }
        throw "micke: could not read the latest tag from $Base/releases/latest — pin a version with -Version <tag>"
    }
    if ($location -notmatch "^https?://") {
        $origin = $Base.TrimEnd("/") -replace "/releases$", ""
        $location = "$origin/" + $location.TrimStart("/")
    }
    $tag = ($location.TrimEnd("/")) -split "/" | Select-Object -Last 1
    if (-not $tag) { throw "micke: no tag in redirect location '$location'" }
    Write-Host "micke: latest release is $tag"
}

$Asset = "micke-$tag-windows-$Arch.exe"
$Dir = Join-Path $env:LOCALAPPDATA "micke"
$Exe = Join-Path $Dir "micke.exe"
$NewExe = Join-Path $Dir "micke.new.exe"
$OldExe = Join-Path $Dir "micke.old.exe"
$Sums = Join-Path $Dir "SHA256SUMS"

New-Item -ItemType Directory -Force -Path $Dir | Out-Null

Invoke-WebRequest -Uri "$Base/download/$tag/SHA256SUMS" -OutFile $Sums -UseBasicParsing
Invoke-WebRequest -Uri "$Base/download/$tag/$Asset" -OutFile $NewExe -UseBasicParsing

# Each sums line is `<64-hex>  <filename>`; whitespace-split and match on the
# exact filename (the line may carry a \r from a CRLF sums file — Trim it).
$expected = $null
foreach ($line in ((Get-Content -Raw $Sums) -split "`n")) {
    $parts = $line.Trim() -split "\s+"
    if ($parts.Count -ge 2 -and $parts[1] -eq $Asset) { $expected = $parts[0].ToLower(); break }
}
if (-not $expected) { throw "micke: SHA256SUMS for $tag has no entry for $Asset" }

$got = (Get-FileHash -Path $NewExe -Algorithm SHA256).Hash.ToLower()
if ($got -ne $expected) {
    Remove-Item $NewExe -Force -ErrorAction SilentlyContinue
    throw "micke: sha256 mismatch for $Asset — nothing installed (got $got, want $expected)"
}
Remove-Item $Sums -Force
Write-Host "micke: verified $Asset against the release's SHA256SUMS"

# Swap-while-running: a running exe may be renamed but not overwritten.
if (Test-Path $Exe) {
    if (Test-Path $OldExe) { Remove-Item $OldExe -Force }
    Rename-Item -Path $Exe -NewName "micke.old.exe"
    Write-Host "micke: replaced existing micke.exe (this run is an upgrade)"
}
Move-Item -Path $NewExe -Destination $Exe

# Add $Dir to the USER Path when missing (exact-segment check, idempotent).
# The value is read expanded and written back expanded: the effective Path is
# preserved verbatim even though %VARIABLE% references become inline. Never
# touch the Machine Path — that needs elevation micke does not require.
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$onPath = $false
if ($userPath) {
    foreach ($segment in ($userPath -split ";")) {
        if ($segment -eq $Dir) { $onPath = $true }
    }
}
if (-not $onPath) {
    if ($userPath) {
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$Dir", "User")
    } else {
        [Environment]::SetEnvironmentVariable("Path", $Dir, "User")
    }
    Write-Host "micke: added $Dir to your user PATH (open a new terminal for it)"
}

# Register + start; re-running over an existing task re-creates and starts
# it on the new binary. Status is informational on purpose.
& "$Exe" service install
& "$Exe" service status
Write-Host "micke: dashboard at http://127.0.0.1:7800/ (MICKE_PORT to change)"
