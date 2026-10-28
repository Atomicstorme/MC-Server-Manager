# One-time setup (run as administrator) for running Minecraft servers under
# a limited local account, "mcserver", that can only reach its own folders.
#
#  1. Creates (or re-keys) the hidden standard account "mcserver" and saves
#     its random password DPAPI-encrypted for the invoking user, where
#     mc-runas.exe reads it.
#  2. Copies the Java runtime to a folder the account can read.
#  3. Grants it modify on the server folders and read on the Java copy.
#  4. Denies it every top-level folder under each -DenyRoots drive/folder
#     (on these drives every account can otherwise modify everything).
#     One icacls run per folder: a single run over a whole drive did not
#     finish reliably.
#  5. Lets it list (names only) the folders above the server folders, which
#     Java needs to resolve real paths.
param(
  [Parameter(Mandatory)] [string[]] $ServerDirs,
  [Parameter(Mandatory)] [string] $JavaSrc,
  [Parameter(Mandatory)] [string] $RuntimeDir,
  [Parameter(Mandatory)] [string] $CredFile,
  [Parameter(Mandatory)] [string[]] $DenyRoots,
  [string[]] $DenyPaths = @(),
  [Parameter(Mandatory)] [string] $Log
)
$user = 'mcserver'
$skip = '^(\$RECYCLE\.BIN|System Volume Information|WindowsApps|WpSystem|Config\.Msi|DeliveryOptimization|WUDownloadCache|\.GamingRoot)$'
function Step($msg) { "$(Get-Date -Format HH:mm:ss) $msg" | Out-File $Log -Append -Encoding utf8 }
function Icacls([string[]] $a) {
  $out = Join-Path $env:TEMP 'mcsm-icacls.txt'
  $p = Start-Process icacls.exe -ArgumentList ($a | ForEach-Object { "`"$_`"" }) -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError "$out.err"
  "exit $($p.ExitCode): " + ((Get-Content $out, "$out.err" -ErrorAction SilentlyContinue | Where-Object { $_.Trim() }) -join ' | ')
}

try {
  Step 'Creating the mcserver account'
  $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#%+=?@'.ToCharArray()
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $password = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
  $secure = ConvertTo-SecureString $password -AsPlainText -Force
  if (Get-LocalUser -Name $user -ErrorAction SilentlyContinue) {
    Set-LocalUser -Name $user -Password $secure -PasswordNeverExpires $true
  } else {
    New-LocalUser -Name $user -Password $secure -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires `
      -Description 'Runs Minecraft servers for MC Server Manager' | Out-Null
  }
  $usersGroup = (New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-545').Translate([Security.Principal.NTAccount]).Value.Split('\')[-1]
  if (-not (Get-LocalGroupMember -Group $usersGroup -Member $user -ErrorAction SilentlyContinue)) { Add-LocalGroupMember -Group $usersGroup -Member $user }
  $key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -Path $key -Name $user -Value 0 -PropertyType DWord -Force | Out-Null
  Add-Type -AssemblyName System.Security
  $blob = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes("$user`n$password"), $null, 'CurrentUser')
  New-Item -ItemType Directory -Force -Path (Split-Path $CredFile) | Out-Null
  [IO.File]::WriteAllBytes($CredFile, $blob)

  Step "Copying Java to $RuntimeDir"
  robocopy $JavaSrc $RuntimeDir /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }

  # Explicit allows sit ahead of the inherited denies, so they win.
  foreach ($d in $ServerDirs) { Step "Allow modify $d -> $(Icacls @($d, '/grant', "${user}:(OI)(CI)M", '/C', '/Q'))" }
  Step "Allow read $RuntimeDir -> $(Icacls @($RuntimeDir, '/grant', "${user}:(OI)(CI)RX", '/C', '/Q'))"

  $targets = @($DenyPaths) + @($DenyRoots | ForEach-Object { Get-ChildItem -LiteralPath $_ -Force -ErrorAction SilentlyContinue } |
    Where-Object { $_.Name -notmatch $skip } | ForEach-Object { $_.FullName })
  foreach ($t in $targets) { Step "Deny $t -> $(Icacls @($t, '/deny', "${user}:(OI)(CI)F", '/C', '/Q'))" }

  # Each folder above a server folder: list names only. An explicit deny on
  # the folder itself would beat the allow, so it becomes inherit-only, and
  # writes to the folder are denied separately (without Synchronize, which
  # icacls would add and which blocks every open).
  $sid = (New-Object Security.Principal.NTAccount $user).Translate([Security.Principal.SecurityIdentifier])
  $parents = @($ServerDirs + $RuntimeDir | ForEach-Object {
    $p = Split-Path $_
    while ($p -and (Split-Path $p)) { $p; $p = Split-Path $p }
  } | Sort-Object -Unique)
  $listRights = [Security.AccessControl.FileSystemRights]'ReadData, ReadExtendedAttributes, ReadAttributes, ExecuteFile, Synchronize'
  $writeRights = [Security.AccessControl.FileSystemRights]'WriteData, AppendData, WriteExtendedAttributes, WriteAttributes, DeleteSubdirectoriesAndFiles, Delete, ChangePermissions, TakeOwnership'
  foreach ($p in $parents) {
    $acl = Get-Acl -LiteralPath $p
    $explicitDeny = @($acl.Access | Where-Object { -not $_.IsInherited -and $_.AccessControlType -eq 'Deny' -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]) -eq $sid })
    if ($explicitDeny.Count) {
      $explicitDeny | ForEach-Object { [void]$acl.RemoveAccessRuleSpecific($_) }
      $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'InheritOnly', 'Deny')))
      $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, $writeRights, 'None', 'None', 'Deny')))
    }
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, $listRights, 'None', 'None', 'Allow')))
    Set-Acl -LiteralPath $p $acl
    Step "List-only access on $p"
  }
  Step 'DONE'
} catch {
  Step "FAILED: $($_.Exception.Message)"
  exit 1
}
