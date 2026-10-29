Get-CimInstance Win32_Process -Filter "name='chrome.exe'" | ForEach-Object {
    $cl = $_.CommandLine
    if ($cl -and $cl.Length -gt 200) { $cl = $cl.Substring(0, 200) }
    "{0}  {1}" -f $_.ProcessId, $cl
}
