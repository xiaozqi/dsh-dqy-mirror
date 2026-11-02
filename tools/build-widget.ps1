$src = 'C:\Users\admin\.dsh\plugins\dsh-phone-mirror\tools\widget.cs'
$out = 'C:\Users\admin\.dsh\plugins\dsh-phone-mirror\bin\PhoneMirrorWidget.exe'
if (-not (Test-Path (Split-Path $out))) { New-Item -ItemType Directory -Path (Split-Path $out) -Force | Out-Null }
Get-Process PhoneMirrorWidget -ErrorAction SilentlyContinue | Stop-Process -Force
if (Test-Path $out) { Remove-Item $out -Force }
Add-Type -TypeDefinition ([System.IO.File]::ReadAllText($src)) -ReferencedAssemblies System.Windows.Forms, System.Drawing, System.Net.Http -OutputAssembly $out -OutputType WindowsApplication -ErrorAction Stop
Get-Item $out | Select-Object Name, Length
