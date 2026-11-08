# Detect Idle

Two Windows desktop apps:

- **Detect Idle Client**: monitors freelancers, sets its own idle limit, and shows a red alert popup when a freelancer is idle.
- **Detect Idle Freelancer**: reports when the freelancer has no keyboard or mouse activity.

There is no server. The Client and Freelancer PCs must be on the **same network** (office or home LAN/Wi-Fi).

## How it works

1. **One project, several clients.** The first client opens **Detect Idle Client** and gets a **project code** (for example `K7M2QX`). Other clients open their Client app, go to **Project settings → Join another client's project**, and enter that code.
2. **The freelancer joins once.** In **Detect Idle Freelancer** they enter their name and the project code. The app finds **every** client in the project on the network automatically, including clients who join later. A freelancer can be in several projects (**Join project**).
3. **The clients control monitoring.** Each client has a **Monitoring ON/OFF switch** per freelancer and **its own idle limit**. The freelancer has no on/off control. The Freelancer app shows each client's status ("Monitoring" or "Paused") and limit.
4. Every 10 seconds the Freelancer app sends every client of its projects the time since the freelancer's last *real* keyboard or mouse activity (see step 5). It never records which keys are pressed, what is typed, or screen content.
5. **Sleeping detection.** Only *real* activity counts: fresh key presses, clicks, scrolling and real mouse movement. A key held down (for example, someone asleep with their head on the keyboard) or tiny mouse twitches do **not** count, so the idle time keeps growing. If input looks automatic for 2 minutes, the freelancer sees a small, non-blocking **"Still there?"** card in the corner. Moving the mouse, typing or clicking **I'm here** closes it. No answer within 60 seconds sends the clients a **"Possibly asleep"** alert. A freelancer who is working normally never sees the card.
6. While monitoring is ON, that client gets a red alert popup with sound when:
   - **Idle**: no real input for longer than that client's limit
   - **Possibly asleep**: input looked automatic and there was no answer to "Still there?"
   - **Offline**: the Freelancer app was closed, or the PC slept or left the network
   - **Back**: the freelancer is active again

Each client can set the name freelancers see under **Project settings**.

Both apps run in the system tray when the window is closed and start with Windows.

## Network notes

- The Client app uses TCP port **47800** and UDP port **47801** (for auto-discovery).
- The first time the Client app runs, Windows Firewall asks for permission. Click **Allow** (Private networks).
- If auto-discovery doesn't find the client (some routers block broadcast), enter the Client PC's IP under **Advanced: client PC address** in the Freelancer app. The Client app shows its IP under **Project settings**.

## Development

```bash
cd app
npm install
npm run start:client        # Client app  (dev: --profile=NAME --port=N to run several on one PC)
npm run start:freelancer    # Freelancer app (both can run on one PC for testing)
```

## Build

```bash
cd app
npm run dist
```

Output in `release/` (temporary build folders are removed automatically):

- `Detect-Idle-Client-Setup-<version>.exe` and `Detect-Idle-Freelancer-Setup-<version>.exe` (installers)
- `Detect-Idle-Client-Portable.exe` and `Detect-Idle-Freelancer-Portable.exe` (no install needed)
- `client.yml`, `freelancer.yml`, `portable-client.json`, `portable-freelancer.json` (update info)

## Automatic updates

Installed and portable apps check [GitHub Releases](https://github.com/swan1213/detect-idle/releases) shortly after starting and then every 4 hours. When a newer version exists, they download it in the background, check its SHA-512, and restart into the new version on their own (installed: silent reinstall; portable: the `.exe` file is replaced). The Client and Freelancer apps each install only their own update. A Freelancer restarting for an update shows as **Updating…** to its clients instead of triggering an offline alert.

### Publish a new version

1. Raise `"version"` in `app/package.json` (for example `1.0.0` → `1.0.1`).
2. Sign in to GitHub once: `gh auth login`
3. Build and publish:

   ```bash
   cd app
   npm run release
   ```

This builds all four apps and creates the GitHub Release `v<version>` with every file from `release/`. All running apps pick it up within about 4 hours, or at their next start.
