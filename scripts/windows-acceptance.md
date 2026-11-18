# SharkAI Windows acceptance

The installer workflow builds an x64 setup on GitHub's Windows Server runner. It executes the installer in per-user mode, checks the shortcuts and Windows uninstall registration, starts the packaged offline screen, exercises restart and an occupied legacy port, and checks uninstall and profile retention on upgrade from the verified v1.0.0 release. The artifact contains `SharkAI-Setup-<version>.exe` and metadata with its SHA-256, byte size, Authenticode state and runner OS.

## Windows 11 client acceptance

Use a clean, disposable Windows 11 x64 VM or workstation with PowerShell 7, an interactive standard Windows account and the `sharkai-win11-clean` self-hosted runner label in this repository. Configure `SHARKAI_WINDOWS_TEST_ORIGIN` as the approved HTTPS staging origin serving the candidate commit with working authentication, persistence and a chat provider. Set `SHARKAI_WINDOWS_TEST_EMAIL` and `SHARKAI_WINDOWS_TEST_PASSWORD` to the existing dedicated staging account with server-validated Ultra access. Dispatch the workflow on the review branch with `run_windows_11_acceptance` selected. For a manual PowerShell run, set `SHARKAI_WINDOWS_TEST_COMMIT` to the lowercase 40-character commit reported by that staging origin's `/api/status`.

The staging server reports its full Git commit through `VERCEL_GIT_COMMIT_SHA`. On another host set `SHARKAI_BUILD_REVISION` to the exact deployed commit. The packages from a run with `run_windows_11_acceptance` point to the staging origin. The approved production HTTPS origin is used for the separately prepared public installer.

The job downloads the Windows-built candidate and the 1.0.1 staging baseline and checks their sizes, hashes and build metadata. The baseline uses the pinned 1.0.1 desktop source and packages the same approved origin. The published 1.0.0 installer starts a localhost server, so its coverage is the separate Windows Server upgrade check.

On the pristine Windows 11 profile, the test installs 1.0.1 and opens the installed login form and chat composer. It confirms server-validated Ultra access, saves a real conversation, changes that conversation to Work mode, and reopens it after restarting. It upgrades in place from 1.0.1 to the candidate, launches the candidate from the installed Start Menu shortcut, and checks clean process shutdown. It also temporarily blocks the staging origin and clicks the packaged Retry control after restoring access. The test requires the same session cookie, saved reply and Work mode before and after upgrade. Verification metadata omits credentials and conversation IDs. Windows may report `NotSigned` when no signing credentials are configured.

## Interactive setup on the same Windows 11 snapshot

Download the setup from the reviewed Windows build. Compare SHA-256 with the build metadata. In a clean Windows 11 snapshot under a standard user, double-click the installer, select a path with spaces and keep the Start Menu and desktop shortcuts. Open SharkAI from a shortcut and check the startup and retry screen with the network disconnected. Reconnect, sign in to the approved staging account and check the Ultra plan, a real chat reply and its persistence after reopening. Confirm the Windows Settings uninstall entry removes shortcuts and app files. Record the Windows edition, build, architecture, installer hash and observed results. The automated job uses silent NSIS and the interactive wizard remains a manual check.

The checkout and workflows also require write access to the specified SharkAI repository. The workflow uploads review artifacts to GitHub Actions. A public release and a production deployment have separate approval.
