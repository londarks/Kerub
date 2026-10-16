# Compila o meter e deixa só o exe em dist\, pronto para copiar para outro PC.
# A pasta target\ é o cache do compilador: não precisa mexer nela.
Set-Location $PSScriptRoot

# O motor de captura fica ao lado desta pasta. Se ainda não estiver lá, vem a
# versão com que o Kerub foi testado.
$motor = Join-Path $PSScriptRoot "..\A2Tools-DPS-Meter"
$motorRepo = "https://github.com/taengu/A2Tools-DPS-Meter.git"
$motorCommit = "71868460c0ee3b286427bd51d5d862e45276ee42"
if (-not (Test-Path $motor)) {
    git clone --quiet $motorRepo $motor
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    git -C $motor checkout --quiet $motorCommit
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

# Correções nossas no motor (patches\). Depois de atualizar o motor, elas são
# aplicadas de novo aqui.
foreach ($patch in Get-ChildItem patches\*.patch) {
    git -C $motor apply --reverse --check $patch.FullName 2>$null
    if ($LASTEXITCODE -eq 0) { continue }
    git -C $motor apply $patch.FullName
    if ($LASTEXITCODE -ne 0) {
        Write-Host "A correção $($patch.Name) não encaixa mais no motor: ele mudou nesse trecho e ela precisa ser refeita."
        exit 1
    }
    Write-Host "Correção aplicada no motor: $($patch.Name)"
}

cargo build --release
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
New-Item -ItemType Directory -Force dist | Out-Null
try {
    Copy-Item target\release\kerub.exe dist\kerub.exe -Force -ErrorAction Stop
} catch {
    Write-Host "Não deu para copiar: o Kerub da pasta dist está aberto. Feche ele e rode o build.ps1 de novo."
    exit 1
}
Write-Host "Pronto: $PSScriptRoot\dist\kerub.exe"
