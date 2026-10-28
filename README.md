# MC Server Manager

Desktop app (Electron) for running Minecraft servers on Windows: start/stop/restart, live console,
monitoring (CPU, RAM, heap, TPS, players), server.properties editor, config file editor,
players/ops/whitelist/bans, backups with schedule + restore, plugins/mods (Modrinth search,
Modrinth + SpigotMC update checks), Paper/Purpur version updates, Java auto-install,
scheduled restarts, auto-start with Windows, automatic updates during scheduled restarts,
and a system tray.

Download the installer from [Releases](https://github.com/Atomicstorme/MC-Server-Manager-releases/releases).

## Run servers under a limited account (optional)

Servers can run as a separate standard Windows account, `mcserver`, that can only reach its own
server folders, so a compromised plugin can't read or change the rest of the PC.
`tools/setup-isolation.ps1` (run once as administrator) creates the account, copies Java where
it can read it, and sets the folder permissions; `tools/mc-runas` is the small launcher that
starts the server as that account and relays its console. Then tick
"Run as the limited mcserver Windows account" in a server's Launch settings.

## Develop

Needs Windows, Node.js 20+, and the .NET Framework 4.x C# compiler that ships with Windows.

    npm install
    npm run build:runas   # compiles tools/mc-runas -> build/bin/mc-runas.exe
    npm start

## Build the installer

    npm run dist          -> dist/MC-Server-Manager-Setup-<version>.exe

## Release an update

Installed copies check GitHub Releases on `Atomicstorme/MC-Server-Manager-releases`
at launch and every 6 hours, download in the background, and offer "Restart & install".

1. Bump `version` in package.json.
2. `$env:GH_TOKEN = (gh auth token); npm run release`
   This builds and uploads the .exe, .blockmap and latest.yml as a published
   GitHub release, so installed copies see it right away.

Settings live in `%APPDATA%\MC Server Manager\config.json`; Java installed by the app
lives in `%APPDATA%\MC Server Manager\java`.

## Contributing

Issues and pull requests are welcome. Contributions are accepted under the same licence as the
project (GPL-3.0-or-later).

## Licence

Copyright (C) 2026 Atomicstorme

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
[LICENSE](LICENSE) file for details.
