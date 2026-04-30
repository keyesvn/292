# setup.ps1 - Được generate bởi app C# và paste qua UltraViewer

param(
    [string]$ProxyIP = "127.0.0.1",
    [int]$ProxyPort = 1080,
    [string]$ProxyType = "SOCKS5",
    [string]$ProxyUser = "",
    [string]$ProxyPass = ""
)

$ErrorActionPreference = "Stop"
Start-Transcript -Path "C:\Temp\setup.log"

try {
    # 1. Tạo thư mục làm việc
    $WorkDir = "C:\Temp\ZaloSetup"
    New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
    Set-Location $WorkDir

    # 2. Download Proxifier (Portable nếu có, hoặc installer)
    $ProxifierUrl = "https://www.proxifier.com/download/ProxifierPE.zip"  # Portable Edition
    # Hoặc dùng link portable đã upload lên server của bạn
    
    Write-Host "Downloading Proxifier..."
    Invoke-WebRequest -Uri $ProxifierUrl -OutFile "$WorkDir\Proxifier.zip"
    Expand-Archive -Path "$WorkDir\Proxifier.zip" -DestinationPath "$WorkDir\Proxifier" -Force

    # 3. Tạo profile Proxifier (.ppx)
    $ProfilePath = "$WorkDir\ZaloProfile.ppx"
    
    $AuthXml = if ($ProxyUser -and $ProxyPass) {
        @"
      <Authentication>
        <Enabled>1</Enabled>
        <Username>$ProxyUser</Username>
        <Password>$ProxyPass</Password>
      </Authentication>
"@
    } else {
        "      <Authentication><Enabled>0</Enabled></Authentication>"
    }

    $Protocol = switch ($ProxyType) {
        "SOCKS5" { "SOCKS5" }
        "HTTP" { "HTTP" }
        "HTTPS" { "HTTPS" }
        default { "SOCKS5" }
    }

    $ProfileXml = @"
<?xml version="1.0" encoding="UTF-8"?>
<ProxifierProfile version="101" platform="Windows">
  <Options>
    <Resolve>1</Resolve>
  </Options>
  <ProxyList>
    <Proxy id="100">
      <Address>$ProxyIP</Address>
      <Port>$ProxyPort</Port>
      <Protocol>$Protocol</Protocol>
$AuthXml
    </Proxy>
  </ProxyList>
  <RuleList>
    <Rule enabled="true">
      <Name>Zalo Only</Name>
      <Applications>zalo.exe</Applications>
      <Action type="Proxy">100</Action>
    </Rule>
    <Rule enabled="true">
      <Name>Default - Direct</Name>
      <Applications></Applications>
      <Action type="Direct"></Action>
    </Rule>
  </RuleList>
</ProxifierProfile>
"@

    $ProfileXml | Out-File -FilePath $ProfilePath -Encoding UTF8

    # 4. Launch Proxifier với profile
    $ProxifierExe = "$WorkDir\Proxifier\Proxifier.exe"
    if (Test-Path $ProxifierExe) {
        Start-Process -FilePath $ProxifierExe -ArgumentList "`"$ProfilePath`""
        Write-Host "Proxifier đã khởi động với proxy $ProxyIP`:$ProxyPort"
    } else {
        throw "Không tìm thấy Proxifier.exe"
    }

    # 5. Tạo shortcut khởi động cùng Windows (optional)
    $WshShell = New-Object -ComObject WScript.Shell
    $Shortcut = $WshShell.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\ProxifierZalo.lnk")
    $Shortcut.TargetPath = $ProxifierExe
    $Shortcut.Arguments = "`"$ProfilePath`""
    $Shortcut.Save()

    Write-Host "HOÀN TẤT! Zalo sẽ chạy qua proxy."
}
catch {
    Write-Error "LỖI: $_"
}
finally {
    Stop-Transcript
}