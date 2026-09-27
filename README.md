# Vision-Bot-Pro

*Formerly VisionClaw. Server service names and internal package names keep
the old name, so existing installs are unaffected.*

![Vision-Bot-Pro](assets/teaserimage.png)

**An AI employee in your phone — powered by Gemini Live + Claude Sonnet 5.**
Point your camera at something and talk. It
sees what you show it, hears you and answers out loud -- and it takes work off
your hands: researching, using websites (you can watch it and take the browser
over), comparing prices across suppliers, texting and calling people, and
ordering materials once you approve the exact total. Work carries on after the
conversation moves on, and you can always see what it is doing, what it needs
from you and what it finished, with evidence.

It is phone-first: a web app, installable as a PWA, for iPhone and Android.
Ray-Ban Meta glasses are optional, through the native apps, and share the same
employee, memory and tasks.

## How it fits together

```
 Phone web app (PWA)          optional: glasses via the native apps
   camera · microphone · speaker · touch
        │                                   ▲
        ▼                                   │ spoken and on-screen result
 Realtime conversation: Gemini Live over LiveKit          (agent/)
        │ execute(task, context)
        ▼
 Agent gateway: one owner-scoped employee                 (gateway/)
   durable runs · approvals · memory · evidence · live events
        │
        ├── runtime, swappable per deployment:
        │     Hermes (Codex, OpenAI, Gemini, OpenRouter, ...)
        │     Claude Code on your own Claude subscription
        │     Anthropic Managed Agents
        ▼
 Governed tools: typed, classified, permissioned, audited
   web reading · browsers you can watch (Browser Use, Browserbase)
   MCP · files · memory · SMS (Twilio) · calls (Retell)
   suppliers, carts and checkout · workflows
```

- **The employee is not the model.** Profile, transcript, memory, tasks,
  permissions and evidence live in the gateway. Hermes, Claude Code or Managed
  Agents is the brain for a run, and changing it is one setting.
- **Nothing consequential happens silently.** Spending, messaging, calling and
  deleting stop for your approval with the exact details; a purchase needs
  approval of its exact total every time.
- **General-purpose.** Personal errands and work use the same employee; real
  estate and property management are optional skills, not the product.

## Get it running

### On your computer, with your Claude subscription

```bash
git clone https://github.com/WaltLuv/Vision-Bot-Pro.git && cd Vision-Bot-Pro
bash deploy/local.sh
```

It needs Node 22 or newer and [Claude Code](https://code.claude.com/docs/en/quickstart),
and no root. It is written for macOS and Linux; so far it has been run on Linux. The first run has you sign in to Claude Code
with your Claude subscription -- Anthropic's own sign-in, which Vision-Bot-Pro never
sees -- then writes private settings to `gateway/.env`, builds the app and
starts it. Open `http://127.0.0.1:8788` on the same computer and type the
access code it prints. Ctrl-C stops it; the same command starts it again, in
seconds, with the same code.

**What your subscription covers.** Every task runs through Claude Code with the
same governed tools and approvals as any other engine: reading the web, memory,
documents, contacts and workflows, plus -- once you add their keys to
`gateway/.env` -- text messages, calls, suppliers, a browser you can watch
(`BROWSERBASE_API_KEY`) and MCP servers. A subscription is for one person, so
only your own account's tasks run on it.

**What it does not.** The Gmail, Google Calendar, Slack and Notion connections
belong to Anthropic's Managed Agents, which is an API product: they need an
`ANTHROPIC_API_KEY` and `AGENT_RUNTIME=anthropic`, not a subscription.

It listens on this computer only (`HOST=127.0.0.1`). The phone's camera and
microphone need https, so to use it from your phone, give it a private https
address such as Tailscale Serve pointed at port 8788. Voice also needs LiveKit,
a Gemini key and the `agent/` worker, which the local setup does not start yet.

### On a server

On a Linux VM you control, run `sudo bash deploy/install.sh`. It asks only for
what it cannot know, writes a private `.env` and installs the services. Then
`bash deploy/doctor.sh` tells you, in plain words, what works and what does
not.

| Doc | What it covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the pieces fit, and the boundaries between them |
| [docs/SETUP.md](docs/SETUP.md) | Configuration and environment variables |
| [docs/SECURITY.md](docs/SECURITY.md) | What protects what |
| [docs/TESTING.md](docs/TESTING.md) | How to run the tests, and what is actually verified |
| [docs/BUILD-STATUS.md](docs/BUILD-STATUS.md) | Every capability, honestly labelled |
| [docs/OWNER-ACTIONS.md](docs/OWNER-ACTIONS.md) | Accounts and keys only you can provide |

Built from [Intent-Lab/VisionClaw](https://github.com/Intent-Lab/VisionClaw), on
the [Gemini Live API](https://ai.google.dev/gemini-api/docs/live) and, for the
glasses, the [Meta Wearables Device Access Toolkit](https://github.com/facebook/meta-wearables-dat-ios).

---

## The app asks for an access code

The first screen asks for an access code. The code is not something the author issues -- it is a token from **whichever gateway the app points at**, and the gate verifies it against that gateway before unlocking.

- The default gateway (`api.visionagents.app`) is a small private pilot instance for a user study, not a public service, so its codes are not handed out.
- **Self-hosting:** run the gateway in [`gateway/`](gateway/README.md) and set `GATEWAY_TOKENS="<any-secret>:<your-name>"` in its `.env` -- that secret is your access code. Point the app at your gateway either in `Secrets.swift` / `Secrets.kt` (`gatewayBaseUrl`) before building, or at runtime with **"Using your own gateway?"** on the access-code screen.
- **Voice needs the whole stack:** the gateway only mints room tickets and runs tasks. Calls also need the `agent/` worker running against a [LiveKit Cloud](https://livekit.io) project (free tier works), with the same LiveKit credentials on both the gateway and the worker -- otherwise the app connects and waits on "Waiting for agent" forever.
- **Ray-Ban Meta glasses** need Developer Mode enabled in the Meta AI app on the phone; without it the glasses link is rejected ("Error opening link").

Details for the gateway, tokens and app connections: [gateway/README.md](gateway/README.md).

## Quick Start (phone, no install)

The gateway serves a phone-first web app, so the fastest way in is a browser --
no Xcode, no Android Studio, no glasses.

```bash
cd gateway && npm ci && cp .env.example .env   # set GATEWAY_TOKENS
cd ../web && npm ci && npm run build
cd ../gateway && npm start
```

Open the gateway's URL on your phone and sign in with the access code above.
"Add to home screen" installs it like an app.

You get the camera with front/rear switching, freeze-frame and photo capture, a
voice conversation when LiveKit is configured, live transcript and cards, typed
tasks as a fallback that always works, task status with evidence, approvals for
anything that spends or sends, and the employee's memory and contacts.

Materials are priced across every supplier you connect -- Home Depot, Lowe's,
Amazon, Walmart, and any local yard or specialty vendor you configure -- searched
in parallel and compared in one model. The phone always says which suppliers
answered, which did not, and when each price was checked, so a short list is
never mistaken for the market. Nothing is bought without you authorising an
exact quote.

The camera and microphone need an HTTPS origin -- browsers do not expose them
otherwise -- and voice needs the `agent/` worker and LiveKit credentials. Typing,
photos and tasks work without either.

Setup and environment: [docs/SETUP.md](docs/SETUP.md). How to run the tests and
what is actually verified: [docs/TESTING.md](docs/TESTING.md). Boundaries and
what enforces them: [docs/SECURITY.md](docs/SECURITY.md). What still needs a
credential you have to supply: [docs/OWNER-ACTIONS.md](docs/OWNER-ACTIONS.md).

The native apps below remain the way to use Ray-Ban Meta glasses, and share the
same gateway, employee, tasks and memory as the phone.

## Quick Start (iOS)

### 1. Clone and open

```bash
cd samples/CameraAccess
open CameraAccess.xcodeproj
```

### 2. Add your secrets

Copy the example file and fill in your values:

```bash
cp CameraAccess/Secrets.swift.example CameraAccess/Secrets.swift
```

Set `cloudGatewayURL` in `Secrets.swift` to your gateway and leave the token
empty: the app asks for your access code on first launch. The Gemini key and
the self-hosted fields in that file are upstream leftovers the app no longer
uses for conversations -- Gemini runs in the `agent/` worker, reached through
LiveKit, so the phone never holds a model key.

### 3. Build and run

Select your iPhone as the target device and hit Run (Cmd+R).

### 4. Try it out

**Without glasses (iPhone mode):**
1. Tap **"Start on iPhone"** -- uses your iPhone's back camera
2. Tap the **AI button** to start a voice session (Gemini Live, through your gateway's LiveKit worker)
3. Talk to the AI -- it can see through your iPhone camera

**With Meta Ray-Ban glasses:**

First, enable Developer Mode in the Meta AI app:

1. Open the **Meta AI** app on your iPhone
2. Go to **Settings** (gear icon, bottom left)
3. Tap **App Info**
4. Tap the **App version** number **5 times** -- this unlocks Developer Mode
5. Go back to Settings -- you'll now see a **Developer Mode** toggle. Turn it on.

![How to enable Developer Mode](assets/dev_mode.png)

Then in VisionClaw:
1. Tap **"Start Streaming"** in the app
2. Tap the **AI button** for voice + vision conversation

---

## Quick Start (Android)

### 1. Clone and open

Open `samples/CameraAccessAndroid/` in Android Studio.

### 2. Configure GitHub Packages (DAT SDK)

The Meta DAT Android SDK is distributed via GitHub Packages. You need a GitHub Personal Access Token with `read:packages` scope.

1. Go to [GitHub > Settings > Developer Settings > Personal Access Tokens](https://github.com/settings/tokens) and create a **classic** token with `read:packages` scope
2. In `samples/CameraAccessAndroid/local.properties`, add:

```properties
github_token=YOUR_GITHUB_TOKEN
```

> **Tip:** If you have the `gh` CLI installed, you can run `gh auth token` to get a valid token. Make sure it has `read:packages` scope -- if not, run `gh auth refresh -s read:packages`.
>
> **Note:** GitHub Packages requires authentication even for public repositories. The 401 error means your token is missing or invalid.

### 3. Add your secrets

```bash
cd samples/CameraAccessAndroid/app/src/main/java/com/meta/wearable/dat/externalsampleapps/cameraaccess/
cp Secrets.kt.example Secrets.kt
```

Set `gatewayBaseUrl` in `Secrets.kt` to your gateway and leave `gatewayToken`
empty: the app asks for your access code on first launch.

### 4. Build and run

1. Let Gradle sync in Android Studio (it will download the DAT SDK from GitHub Packages)
2. Select your Android phone as the target device
3. Click Run (Shift+F10)

> **Wireless debugging:** You can also install via ADB wirelessly. Enable **Wireless debugging** in your phone's Developer Options, then pair with `adb pair <ip>:<port>`.

### 5. Try it out

**Without glasses (Phone mode):**
1. Tap **"Start on Phone"** -- uses your phone's back camera
2. Tap the **AI button** (sparkle icon) to start a voice session (Gemini Live, through your gateway's LiveKit worker)
3. Talk to the AI -- it can see through your phone camera

**With Meta Ray-Ban glasses:**

Enable Developer Mode in the Meta AI app (same steps as iOS above), then:
1. Tap **"Start Streaming"** in the app
2. Tap the **AI button** for voice + vision conversation

---

## OpenClaw is not required

Upstream VisionClaw sent tasks from the phone to a self-hosted OpenClaw. That path
is gone: tasks now go from the `agent/` worker to the gateway, and neither the
phone web app nor the Android app has an OpenClaw setting. The iOS app still
carries upstream's "self-hosted" backend setting, which points it at another
server instead of the gateway; it is not part of the supported product. Some iOS
file and setting names still say `OpenClaw` (for example `OpenClawBridge`, now
only a gateway error parser); they are kept so saved settings survive updates.

---

## Native app internals (glasses path)

The architecture of the whole product is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); this section covers only the native apps.

### Where things are

| Path | What it is |
|---|---|
| `samples/CameraAccess/CameraAccess/OpenClaw/LiveKitSession.swift` | iOS: joins the LiveKit room with the phone or glasses camera and microphone; fetches the room ticket from the gateway |
| `samples/CameraAccess/CameraAccess/Settings/` | iOS: gateway, access code, connected apps, recent tasks |
| `samples/CameraAccess/CameraAccess/ViewModels/WearablesViewModel.swift` | iOS: Ray-Ban Meta glasses through the DAT SDK |
| `samples/CameraAccessAndroid/.../cameraaccess/livekit/` | Android: LiveKit session and the glasses video capturer |
| `samples/CameraAccessAndroid/.../cameraaccess/settings/GatewayApi.kt` | Android: gateway calls (room ticket, apps, tasks) |
| `samples/CameraAccessAndroid/.../cameraaccess/wearables/` | Android: Ray-Ban Meta glasses through the DAT SDK |
| `agent/main.py` | The voice worker both apps and the web app talk to: LiveKit room to Gemini Live, tasks to the gateway |

### How a spoken request becomes work

1. The app publishes microphone and camera (phone or glasses) into a LiveKit room.
2. The `agent/` worker runs the conversation with Gemini Live, so audio,
   interruptions and echo cancellation are handled there and in WebRTC.
3. When you ask for something that takes work, Gemini calls one tool,
   `execute(task, context)`, and the worker hands it to the gateway, which runs
   it as a durable task for your employee.
4. The result comes back as speech, and as a task card with evidence in the app.

Android also keeps upstream's WebRTC "Live" sharing of the glasses view
(`webrtc/`); it needs its own `wss://` signaling server and is separate from
the employee.

---

## Requirements

### iOS
- iOS 17.0+
- Xcode 15.0+
- A running gateway and `agent/` worker (see [docs/SETUP.md](docs/SETUP.md))
- Meta Ray-Ban glasses (optional -- use iPhone mode for testing)

### Android
- Android 14+ (API 34+)
- Android Studio Ladybug or newer
- GitHub account with `read:packages` token (for DAT SDK)
- A running gateway and `agent/` worker (see [docs/SETUP.md](docs/SETUP.md))
- Meta Ray-Ban glasses (optional -- use Phone mode for testing)

---

## Troubleshooting

### General

**Stuck on "Waiting for agent"** -- The gateway answered but no voice worker joined the room. Start the `agent/` worker, and give it the same LiveKit credentials as the gateway (`bash deploy/doctor.sh` checks this).

**The access code is rejected** -- Codes come from the gateway the app points at, not from the author. Check that the app points at your gateway and that the code matches one in its `GATEWAY_TOKENS`.

**The camera or microphone never starts in the web app** -- Browsers expose them only on an HTTPS origin; typing, photos and tasks still work without them.

**Gemini doesn't hear me** -- Check that microphone permission is granted, and speak at a normal volume.

### iOS-specific

**Echo/feedback in iPhone mode** -- The app mutes the mic while the AI is speaking. If you still hear echo, try turning down the volume.

### Android-specific

**Gradle sync fails with 401 Unauthorized** -- Your GitHub token is missing or doesn't have `read:packages` scope. Check `github_token` in `local.properties` (or the `GITHUB_TOKEN` environment variable). Generate a new token at [github.com/settings/tokens](https://github.com/settings/tokens).

**Audio not working** -- Ensure `RECORD_AUDIO` permission is granted. On Android 13+, you may need to grant this permission manually in Settings > Apps.

**Phone camera not starting** -- Ensure `CAMERA` permission is granted. CameraX requires both the permission and a valid lifecycle.

For DAT SDK issues, see the [developer documentation](https://wearables.developer.meta.com/docs/develop/) or the [discussions forum](https://github.com/facebook/meta-wearables-dat-ios/discussions).

## Citation

If you use VisionClaw in your research, please cite our paper:

```bibtex
@article{liu2026visionclaw,
  title={VisionClaw: Always-On AI Agents through Smart Glasses},
  author={Liu, Xiaoan and Lee, DaeHo and Gonzalez, Eric J and Gonzalez-Franco, Mar and Suzuki, Ryo},
  journal={arXiv preprint arXiv:2604.03486},
  year={2026}
}
```

## License

This source code is licensed under the license found in the [LICENSE](LICENSE) file in the root directory of this source tree.
