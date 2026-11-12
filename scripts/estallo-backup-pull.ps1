$ErrorActionPreference = 'Stop'
$backupRoot = 'C:\Users\junio\OneDrive\Documentos\backup-estallo-crm'
$logPath = 'C:\Users\junio\.estallo-crm\backup-external.log'
$server = 'root@177.153.68.124'
$sshKey = Join-Path $env:USERPROFILE '.ssh\estallo-crm'
$listScript = @'
from pathlib import Path
import re
for path in sorted(Path('/opt/stacks/estallo-crm/backups').iterdir()):
    if path.is_dir() and re.fullmatch(r'\d{8}T\d{12}Z', path.name) and (path/'database.dump').exists():
        print(path.name)
'@
try {
    $backupNames = $listScript | & ssh.exe -i $sshKey -o BatchMode=yes -o ConnectTimeout=10 $server python3 -
    if ($LASTEXITCODE -ne 0) { throw 'Servidor indisponivel para copiar os backups.' }
    $copied = 0
    foreach ($backupName in $backupNames) {
        if ($backupName -notmatch '^\d{8}T\d{12}Z$') { throw 'Nome de backup inesperado.' }
        $destination = Join-Path $backupRoot $backupName
        $receipt = Join-Path $destination '.copied.json'
        if (Test-Path -LiteralPath $receipt) { continue }
        & scp.exe -q -r -i $sshKey -o BatchMode=yes -o ConnectTimeout=10 "${server}:/opt/stacks/estallo-crm/backups/$backupName" $backupRoot 2>> $logPath
        if ($LASTEXITCODE -ne 0) { throw 'Copia incompleta; sera tentada novamente.' }
        if (-not (Test-Path -LiteralPath (Join-Path $destination 'database.dump'))) { throw 'Dump nao encontrado na copia.' }
        @{ copied_at = (Get-Date).ToUniversalTime().ToString('o'); source = $server } | ConvertTo-Json | Set-Content -LiteralPath $receipt -Encoding UTF8
        $copied++
    }
    Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) OK: $copied backup(s) copiado(s)."
} catch {
    Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) FALHA: $($_.Exception.Message)"
    exit 1
}
