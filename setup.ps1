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
    Write-Host "--- Bat dau cau hinh Proxy Zalo ---" -ForegroundColor Cyan
    
    # 1. Tao thu muc lam viec
    $WorkDir = "C:\Temp\ZaloSetup"
    if (!(Test-Path $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }
    Set-Location $WorkDir

    # 2. Kiem tra va Tai Proxifier
    $ProxifierExe = "$WorkDir\Proxifier\Proxifier.exe"
    if (!(Test-Path $ProxifierExe)) {
        Write-Host "Dang tai Proxifier Portable..." -ForegroundColor Yellow
        $ProxifierUrl = "https://www.proxifier.com/download/ProxifierPE.zip"
        Invoke-WebRequest -Uri $ProxifierUrl -OutFile "$WorkDir\Proxifier.zip" -UseBasicParsing
        Expand-Archive -Path "$WorkDir\Proxifier.zip" -DestinationPath "$WorkDir\Proxifier" -Force
        Remove-Item "$WorkDir\Proxifier.zip" -Force
    } else {
        Write-Host "Da co Proxifier, bo qua buoc tai." -ForegroundColor Green
    }

    # 3. Tao profile Proxifier (.ppx)
    Write-Host "Dang cau hinh Proxy va Rules..." -ForegroundColor Yellow
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

    # 4. Kiem tra file cau hinh va Chay Proxifier
    if (Test-Path $ProfilePath) {
        Write-Host "Dang khoi chay Proxifier..." -ForegroundColor Green
        # Tat Proxifier cu neu dang chay de ap dung profile moi
        Get-Process Proxifier -ErrorAction SilentlyContinue | Stop-Process -Force
        
        Start-Process -FilePath $ProxifierExe -ArgumentList "`"$ProfilePath`""
        
        # 5. Dang ky Startup
        $WshShell = New-Object -ComObject WScript.Shell
        $Shortcut = $WshShell.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\ProxifierZalo.lnk")
        $Shortcut.TargetPath = $ProxifierExe
        $Shortcut.Arguments = "`"$ProfilePath`""
        $Shortcut.Save()

        Show-Notification "Cài đặt Proxy cho Zalo THÀNH CÔNG!`n`nProxy: $ProxyIP : $ProxyPort`nRules: Chỉ áp dụng cho Zalo.exe"
    } else {
        throw "Khong the tao file cau hinh .ppx"
    }
}
catch {
    $ErrorMsg = "LOI: $($_.Exception.Message)"
    Write-Host $ErrorMsg -ForegroundColor Red
    Show-Notification $ErrorMsg
}
