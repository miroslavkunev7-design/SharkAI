# SharkAI Windows acceptance

The installer workflow builds an x64 setup on GitHub's Windows runner. It executes the installer in per-user mode, checks the shortcuts and Windows uninstall registration, starts the packaged offline screen, exercises restart and an occupied legacy port, upgrades from the verified v1.0.0 release, then checks uninstall and profile retention. The artifact contains `SharkAI-Setup-<version>.exe` and metadata with its SHA-256, byte size, Authenticode state and runner OS. A Windows Server runner covers this build and smoke test.

## Windows 11 client acceptance

Use a clean, disposable Windows 11 x64 VM or workstation with PowerShell 7, an interactive standard Windows account and the `sharkai-win11-clean` self-hosted runner label in this repository. Configure `SHARKAI_WINDOWS_TEST_ORIGIN` as the approved HTTPS staging origin serving the same SharkAI version with working authentication, persistence and a chat provider. Set `SHARKAI_WINDOWS_TEST_EMAIL` and `SHARKAI_WINDOWS_TEST_PASSWORD` to the existing dedicated staging account with server-validated Ultra access. Dispatch the workflow on the review branch with `run_windows_11_acceptance` selected.

The client job downloads the installer from the Windows build and verifies its size and hash. It uses the installed application’s own login form and chat composer, confirms the server-validated Ultra plan and a persisted reply, and checks that the session and reply survive restart and the install and upgrade sequence. The previous installer is executed as part of the upgrade, and account verification uses the current Internet-connected client. The job publishes verification metadata without login data or conversation IDs. GitHub may report `NotSigned` when no authorized signing credentials are configured.

## Interactive setup on the same Windows 11 snapshot

Download the setup from the reviewed Windows build. Compare SHA-256 with the build metadata. In a clean Windows 11 snapshot under a standard user, double-click the installer, select a path with spaces and keep the Start Menu and desktop shortcuts. Open SharkAI from a shortcut and check the startup and retry screen with the network disconnected. Reconnect, sign in to the approved staging account and check the Ultra plan, a real chat reply and its persistence after reopening. Confirm the Windows Settings uninstall entry removes shortcuts and app files. Record the Windows edition, build, architecture, installer hash and observed results. The automated job uses silent NSIS and the interactive wizard remains a manual check.

The checkout and workflows also require write access to the specified SharkAI repository. The workflow uploads review artifacts to GitHub Actions. A public release and a production deployment have separate approval.
