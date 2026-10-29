# Kill every process whose command line contains the given marker (e.g. a temp profile dir).
param([string]$Marker)
if ([string]::IsNullOrWhiteSpace($Marker)) {
    Write-Error "usage: ps_kill_marker.ps1 -Marker <substring>  (refusing to run without a marker -- it would kill every chrome.exe)"
    exit 1
}
$EscapedMarker = [WildcardPattern]::Escape($Marker)
Get-CimInstance Win32_Process -Filter "name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$EscapedMarker*" } | ForEach-Object {
    "killing $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
