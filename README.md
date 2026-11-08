# Detect Idle

Two Windows desktop apps:

- **Detect Idle Client**: monitors freelancers, sets its own idle limit, and shows a red alert popup when a freelancer is idle.
- **Detect Idle Freelancer**: reports when the freelancer has no keyboard or mouse activity.

There is no server. The Client and Freelancer PCs must be on the **same network** (office or home LAN/Wi-Fi).

## How it works

1. **One project, several clients.** The first client opens **Detect Idle Client** and gets a **project code** (for example `K7M2QX`). Other clients open their Client app, go to **Project settings → Join another client's project**, and enter that code.
2. **The freelancer joins once.** In **Detect Idle Freelancer** they enter their name and the project code. The app finds **every** client in the project on the network automatically, including clients who join later. A freelancer can be in several projects (**Join project**).
3. **The clients control monitoring.** Each client has a **Monitoring ON/OFF switch** per freelancer and **its own idle limit**. The freelancer has no on/off control. The Freelancer app shows each client's status ("Monitoring" or "Paused") and limit.
4. Every 10 seconds the Freelancer app reads the Windows idle time (seconds since the last keyboard or mouse input) and sends it to every client of its projects. It never records keystrokes or screen content.
5. While monitoring is ON, that client gets a red alert popup with sound when:
   - **Idle**: no input for longer than that client's limit
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

## Build the installers

```bash
cd app
npm run dist
```

Output:

- `app/dist/client/Detect Idle Client Setup 1.0.0.exe`
- `app/dist/freelancer/Detect Idle Freelancer Setup 1.0.0.exe`
