param(
    [string]$ProxyIP = "127.0.0.1",
    [int]$ProxyPort = 1080,
    [string]$ProxyType = "SOCKS5",
    [string]$ProxyUser = "",
    [string]$ProxyPass = ""
)

$ErrorActionPreference = "Stop"

function Show-Notification {
    param([string]$Message)
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($Message, "UltraAuto Setup", "OK", "Information")
}

try {
    Write-Host "--- BAT DAU CAI DAT PROXY ZALO ---" -ForegroundColor Cyan
    
    # 1. Thu muc lam viec
    Write-Host "[1/4] Dang chuan bi thu muc (25%)..." -ForegroundColor Yellow
    $WorkDir = "C:\Temp\ZaloSetup"
    if (!(Test-Path $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }
    Set-Location $WorkDir

    # 2. Tai Proxifier
    $ProxifierExe = "$WorkDir\Proxifier\Proxifier.exe"
    if (!(Test-Path $ProxifierExe)) {
        Write-Host "[2/4] Dang tai Proxifier Portable (50%)..." -ForegroundColor Yellow
        $ProxifierUrl = "https://www.proxifier.com/download/ProxifierPE.zip"
        Invoke-WebRequest -Uri $ProxifierUrl -OutFile "$WorkDir\Proxifier.zip" -UseBasicParsing
        Write-Host "      Dang giai nen..." -ForegroundColor Gray
        Expand-Archive -Path "$WorkDir\Proxifier.zip" -DestinationPath "$WorkDir\Proxifier" -Force
        Remove-Item "$WorkDir\Proxifier.zip" -Force
    } else {
        Write-Host "[2/4] Da co Proxifier, bo qua buoc tai (50%)." -ForegroundColor Green
    }

    # 3. Profile Proxifier
    Write-Host "[3/4] Dang cau hinh Proxy va Rules (75%)..." -ForegroundColor Yellow
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
        "HTTP"   { "HTTP" }
        "HTTPS"  { "HTTPS" }
        default  { "SOCKS5" }
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

    $ProfileXml | Out-File -FilePath $ProfilePath -Encoding UTF8 -Force

    # 4. Chay Proxifier
    if (Test-Path $ProfilePath) {
        Write-Host "[4/4] Dang khoi chay Proxifier (90%)..." -ForegroundColor Green
        Get-Process Proxifier -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Process -FilePath $ProxifierExe -ArgumentList "`"$ProfilePath`""
        
        # Startup
        $WshShell = New-Object -ComObject WScript.Shell
        $Shortcut = $WshShell.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\ProxifierZalo.lnk")
        $Shortcut.TargetPath = $ProxifierExe
        $Shortcut.Arguments = "`"$ProfilePath`""
        $Shortcut.Save()

        Write-Host "`n--- HOAN TAT 100% ---" -ForegroundColor Green -BackgroundColor DarkGreen
        Show-Notification "Cài đặt Proxy cho Zalo THÀNH CÔNG!"
    } else {
        throw "Khong the tao file cau hinh .ppx"
    }
}
catch {
    Write-Host "`n************************************" -ForegroundColor Red
    Write-Host "LOI: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "************************************" -ForegroundColor Red
    Show-Notification "LỖI: $($_.Exception.Message)"
}
finally {
    Write-Host "`nNhan phim ENTER de ket thuc va dong cua so nay..." -ForegroundColor White
    Read-Host
}
