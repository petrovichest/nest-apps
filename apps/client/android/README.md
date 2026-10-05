# Android build

CodexNest targets Android 10 (API 29) and newer. The app uses `http://localhost` as its
Capacitor origin. Network Security Configuration permits the user-selected LAN/VPN HTTP
deployment and trusts system CA certificates plus CA certificates explicitly installed
by the device owner, without disabling normal TLS hostname/IP verification. Install only
a private CA that you control and use it only for trusted LAN/VPN services.

LAN HTTP does not encrypt the bearer token, session contents, command output, or approval
decisions. Prefer HTTP inside a private WireGuard/Tailscale tunnel, or use it only on a
fully trusted LAN. Do not expose port `4310` to the internet or use direct HTTP on
guest/public Wi-Fi. A captured token grants owner-level CodexNest access until it is
rotated. See the complete HTTP threat model in
[`deploy/DEPLOYMENT.md`](../../../deploy/DEPLOYMENT.md#вариант-a-http-внутри-приватного-vpn-или-доверенной-lan).

On Android 15 and newer, the existing edge-to-edge layout uses theme-colored
chat gradients instead of Android's three-button navigation contrast scrim.
Android 10–14 retain their existing window layout and opaque system-bar styles.
In edge-to-edge mode, system-bar icon styles follow
the resolved app theme through Capacitor's built-in `SystemBars`, independently
of the device theme. `MainActivity` emits `codexnest:system-bars-reset` after
configuration changes, page load and resume so the UI reapplies its selected style.
The IME continues to own its navigation bar while the keyboard is visible.

Build from the repository root:

```bash
npm run build
npm run android:sync -w @codexnest/client
cd apps/client/android
./gradlew assembleDebug
```

Android updates must always be signed with the same key as the installed APK.
CodexNest's existing signing key can continue to be used as long as it has not
been disclosed. Keep the keystore readable only by its owner (`chmod 600`) and
store an encrypted offline backup together with its passwords. Losing or
replacing the key prevents direct updates to existing installations.

For a new distribution that does not already have an established signing key,
generate a dedicated key once:

```bash
install -d -m 700 "$HOME/.config/codexnest-signing"
keytool -genkeypair \
  -keystore "$HOME/.config/codexnest-signing/codexnest-release.jks" \
  -alias codexnest \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000
chmod 600 "$HOME/.config/codexnest-signing/codexnest-release.jks"
```

For a signed release, provide all four values outside the repository:

```bash
export CODEXNEST_KEYSTORE_PATH=/absolute/path/codexnest.jks
export CODEXNEST_KEY_ALIAS=codexnest
export CODEXNEST_KEYSTORE_PASSWORD=...
export CODEXNEST_KEY_PASSWORD=...
./gradlew assembleRelease
```

Every successful push to `main` that is still the branch head updates the GitHub
`Latest` release, `rolling-latest`, with signed `CodexNest-latest.apk`, installers,
and the Chrome extension from the same verified commit. The pipeline runs
`testDebugUnitTest assembleRelease`, verifies the APK signature against the
configured keystore certificate, and checks `com.codexnest.app`, version name,
and version code. Only the public certificate SHA-256 digest is printed.

`CODEXNEST_ANDROID_VERSION_NAME` matches the rolling release version, while
`CODEXNEST_ANDROID_VERSION_CODE` is `2000000 + GITHUB_RUN_NUMBER`. The higher base
keeps new repository builds above the previous repository's APK version codes.
Preserve the existing signing key to update installed APKs without reinstalling.
Versioned `v*` releases continue to publish installers and extension assets
without an APK.

The repository needs four Android signing secrets:

- `CODEXNEST_ANDROID_KEYSTORE_BASE64`: the existing keystore encoded as base64.
- `CODEXNEST_ANDROID_KEY_ALIAS`: its signing key alias.
- `CODEXNEST_ANDROID_KEYSTORE_PASSWORD`: its keystore password.
- `CODEXNEST_ANDROID_KEY_PASSWORD`: its key password.

The two other migrated repository secrets, `WEB_EXT_API_KEY` and
`WEB_EXT_API_SECRET`, are retained but unused. Firefox packaging and signing
remain disabled.

`CodexNest-latest.json` mirrors `NestApps-latest.json`. Both manifests pin Android
and Linux installations to the same commit; all APK, installer, and extension
assets are uploaded before the manifests, with the authoritative
`NestApps-latest.json` uploaded last.

Notifications do not use Firebase, Google Play Services, or a third-party push provider.
The Android app starts a `remoteMessaging` foreground service that keeps an authenticated
WebSocket connection to the configured CodexNest server. Android displays a permanent,
low-priority connection notification while this service is active; this is required for
reliable real-time delivery when the app is in the background.

The service reads the existing server URL and encrypted bearer token from the same native
storage as the UI, reconnects after network loss and device reboot, and emits local
notifications for completed/failed tasks and attention requests. No additional account or
server credential is required. The signing keystore, passwords, and APKs remain ignored.
