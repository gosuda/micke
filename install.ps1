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
    # Resolve the way install.sh does: FOLLOW the redirect and read the FINAL
    # URL — its last path segment is the tag. Deliberately no
    # zero-redirect-refusal trick with its thrown-exception surgery: on real
    # Windows PowerShell 5.1 the refused redirect surfaces as a WebException
    # that carries NO response, so there is no Location to read and the
    # install died with nothing but a generic message (the v0.1.1 Windows
    # report). Following the redirect needs no version-specific handling:
    # PS 5.1 exposes the final URL as BaseResponse.ResponseUri, PS 7 as
    # BaseResponse.RequestMessage.RequestUri. (The suite pins the refusal
    # flag's absence — that parameter never comes back into this file.)
    try {
        $resp = Invoke-WebRequest -Uri "$Base/latest" -UseBasicParsing
    } catch {
        throw "micke: could not resolve the latest release from $Base/latest ($($_.Exception.Message)) — pin a version with -Version <tag>"
    }
    $finalUri = $null
    if ($resp.BaseResponse.ResponseUri) {
        $finalUri = [string]$resp.BaseResponse.ResponseUri                        # PS 5.1
    } elseif ($resp.BaseResponse.RequestMessage -and $resp.BaseResponse.RequestMessage.RequestUri) {
        $finalUri = [string]$resp.BaseResponse.RequestMessage.RequestUri          # PS 7
    }
    if (-not $finalUri) {
        throw "micke: could not read the final URL after following $Base/latest — pin a version with -Version <tag>"
    }
    $tag = ($finalUri.TrimEnd("/")) -split "/" | Select-Object -Last 1
    if (-not $tag -or $tag -eq "latest") {
        # A mirror that serves /latest as a plain page (no redirect): the
        # "tag" would be the literal segment "latest" — name it, don't
        # download a micke-latest-* asset that 404s later.
        throw "micke: $Base/latest did not redirect to a tag page (landed on '$finalUri') — pin a version with -Version <tag>"
    }
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
try {
    Move-Item -Path $NewExe -Destination $Exe
} catch {
    $moveError = $_ # capture first: a failed restore would clobber $_
    # Roll back: without micke.exe there is nothing to run — and this
    # installer is the repair path — so restore the old binary before
    # rethrowing.
    try { Rename-Item -Path $OldExe -NewName "micke.exe" } catch { }
    throw $moveError
}

# A non-Windows pwsh (the test suite runs this script under one) needs the
# exec bit Invoke-WebRequest -OutFile never sets: without it `& $Exe` below
# does not fail — it quietly hands the file to the desktop's document
# opener. On Windows $env:OS is Windows_NT and this is skipped entirely.
if ($env:OS -ne "Windows_NT" -and (Get-Command chmod -ErrorAction SilentlyContinue)) {
    & chmod 755 $Exe
    if ($LASTEXITCODE -ne 0) { throw "micke: chmod 755 failed on $Exe (exit $LASTEXITCODE)" }
}

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
    # Best-effort on purpose: a locked-down profile (or a non-Windows pwsh
    # running the script) must not abort an install whose binary already
    # landed — the user can add one PATH segment by hand.
    try {
        if ($userPath) {
            [Environment]::SetEnvironmentVariable("Path", "$userPath;$Dir", "User")
        } else {
            [Environment]::SetEnvironmentVariable("Path", $Dir, "User")
        }
        Write-Host "micke: added $Dir to your user PATH (open a new terminal for it)"
    } catch {
        Write-Warning "micke: could not update the user PATH ($($_.Exception.Message)) — add $Dir yourself to run micke from anywhere"
    }
}

# Register + start; re-running over an existing task re-creates and starts
# it on the new binary. PS 5.1 does NOT throw on a native command's nonzero
# exit, so check $LASTEXITCODE ourselves: a failed install aborts the script
# (install.sh's set -e), while status stays informational (its `|| true`) —
# a nonzero status must not fail the script.
& "$Exe" service install
if ($LASTEXITCODE -ne 0) { throw "micke: service install failed (exit $LASTEXITCODE)" }
& "$Exe" service status
Write-Host "micke: dashboard at http://127.0.0.1:7800/ (MICKE_PORT to change)"
