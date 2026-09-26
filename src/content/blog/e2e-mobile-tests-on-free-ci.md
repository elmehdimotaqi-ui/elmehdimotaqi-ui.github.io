---
title: "Step by step: end-to-end tests for your mobile app on every pull request, for free"
description: "A complete tutorial. Maestro flows that run on Android and iOS from the same YAML, one script that runs on a laptop and in CI, a CircleCI pipeline on the free plan that boots one emulator per suite, failures you can read in two minutes, and the traps that cost days."
date: 2026-09-26
tags: [mobile, android, ios, testing, ci, maestro]
---

## What you will build

By the end of this tutorial you will have:

- an app that exposes **stable ids** to a UI test tool, on Android and iOS;
- a Maestro **workspace** organised so it still makes sense at fifty flows;
- **one script** that runs any suite, identically on your laptop and in CI;
- a **CircleCI pipeline on the free plan** that builds once, runs one emulator per suite in parallel, and posts a per-test check on the pull request, with GitHub Actions as the alternative provider;
- artifacts and a chat summary that make a **red run diagnosable** without re-running it;
- the same flows running on the **iOS simulator**.

Nothing here needs a paid device farm, a Mac in a closet or a dedicated automation engineer. It needs a set of decisions made in the right order. The tutorial is that order.

**Prerequisites.** An Android app (the tagging step assumes Jetpack Compose or Compose Multiplatform; Views and SwiftUI are noted where they differ), a GitHub repository, JDK 17, the Android SDK with the emulator, and optionally Xcode for the iOS part. The CI part uses CircleCI's free plan; Step 6 shows the same pipeline on GitHub Actions.

**The example app.** Every snippet uses a fictional shopping app, `com.example.shop`, with three bottom tabs (Catalog, Cart, Account), a login screen, product cards with a favorite heart, and a checkout. Replace the names with yours.

---

## Step 0. Install Maestro and run one flow

Maestro drives the *installed* app the way a user does: tap, type, scroll, and check what is on screen. A test is a YAML file.

```bash
curl -fsSL "https://get.maestro.mobile.dev" | bash
maestro --version
```

```yaml
# first_flow.yaml
appId: com.example.shop
---
- launchApp
- tapOn:
    id: "home_tab_cart"
- assertVisible:
    id: "cart_screen"
```

```bash
maestro test first_flow.yaml
```

Why Maestro rather than Espresso, Compose UI tests or XCUITest:

1. **Black box.** It tests the APK or `.app` against a real backend. What the user gets, not an internal simulation.
2. **One test, two platforms.** With Compose Multiplatform, a `testTag` is the Android resource-id *and* the iOS accessibility identifier. The same YAML runs on both. Espresso and XCUITest are each one platform, and they live inside the codebase where QA cannot author them.
3. **QA can write it.** `maestro studio` opens an inspector: click an element, see its id, record steps, save YAML.

Two rules to set on day one:

- **Pin the version.** Behaviour shifts between minor versions. Write the version in one place (`MAESTRO_VERSION` in your CI config), install exactly that version on laptops, and have CI refuse to run on a mismatch.
- **Ids, not text.** Text selectors break on every copy change and every locale. `id:` selectors are stable. Use text only for things that cannot carry an id (OS dialogs, server-driven labels), and write the reason next to the selector.

Maestro Cloud exists if you want to rent devices. This tutorial runs everything on emulators and simulators you already have.

---

## Step 1. Make the app testable (app code, do it first)

This is the step most teams skip, and the reason their first flows are brittle. Before writing the second flow, tag the app.

### Compose `testTag` and the Android opt-in

On Android, Compose does not expose `testTag` values to UI Automator (what Maestro reads) unless a root node opts in with `testTagsAsResourceId = true`. On iOS, Compose Multiplatform already uses the tag as the accessibility identifier. In a shared module that is an `expect`/`actual` pair:

```kotlin
// commonMain
expect fun Modifier.enableTestTagsAsResourceId(): Modifier
expect fun Modifier.testTagAsResourceId(tag: String): Modifier

// androidMain
actual fun Modifier.enableTestTagsAsResourceId(): Modifier =
    this.semantics { testTagsAsResourceId = true }

actual fun Modifier.testTagAsResourceId(tag: String): Modifier =
    this.semantics {
        testTagsAsResourceId = true
        testTag = tag
    }

// iosMain: a testTag is already the accessibility identifier
actual fun Modifier.enableTestTagsAsResourceId(): Modifier = this
actual fun Modifier.testTagAsResourceId(tag: String): Modifier = this.testTag(tag)
```

Apply the opt-in once, on the `NavHost` modifier. The flag merges down the semantics tree, so every `Modifier.testTag("...")` below it becomes a Maestro `id:`.

```kotlin
NavHost(
    navController = navController,
    startDestination = startDestination,
    modifier = modifier.enableTestTagsAsResourceId(),
)
```

**The trap:** a `Dialog` or a `ModalBottomSheet` renders in its own window, which starts a new semantics tree. The opt-in on the NavHost never reaches it. Apply the opt-in on the overlay's root too, or use `testTagAsResourceId(tag)` on the elements inside it.

*Not on Compose?* Android Views expose `android:id` as the resource-id already. SwiftUI and UIKit expose `accessibilityIdentifier`. The rest of this tutorial applies unchanged.

### One constants object per screen, shared by app and tests

Tags are a contract between the app and the test workspace. Keep them in one `object` per screen in the app, and mirror it in the test selector map (Step 2). When a tag changes, there are exactly two files to update.

```kotlin
object CatalogTestTags {
    const val SCREEN = "catalog_screen"
    const val PRODUCT_CARD = "catalog_product_card"
    const val PRODUCT_CARD_TITLE = "catalog_product_card_title"
    const val PRODUCT_CARD_FAVORITE = "catalog_product_card_favorite"
    const val SORT_CHIP_PREFIX = "catalog_sort_chip_"   // + option name
}
```

Naming convention: `<feature>_<screen>_<element>` in snake_case. Every screen root gets `<feature>_screen`, so a flow can assert "I landed on the right screen" without caring about its content.

### Expose state, not just presence

A favorite heart, a selected chip, a chosen payment method: the flow needs to know *which* one is on, not just that it exists. Add `semantics { selected = ... }` next to the tag.

```kotlin
IconButton(
    onClick = onToggleFavorite,
    modifier = Modifier
        .testTag(CatalogTestTags.PRODUCT_CARD_FAVORITE)
        .semantics { selected = isFavorite },
) { /* heart icon */ }
```

A flow can then wait for the state instead of guessing:

```yaml
- tapOn:
    id: "catalog_product_card_favorite"
    retryTapIfNoChange: false   # see the traps section
- extendedWaitUntil:
    visible:
      id: "catalog_product_card_favorite"
      checked: true             # Android reports Compose `selected` as `checked`
    timeout: 10000
```

Note the word `checked`. UI Automator reports Compose's `selected` as `checked`; the iOS accessibility tree reports it as `selected`. Step 8 deals with that.

### The team rule

**A screen without testTags is not done.** Root, primary CTAs, inputs. A PR that changes a screen adds or updates its tags in the same PR. Asking a developer for a tag is a normal request, not an interruption.

---

## Step 2. Organise the workspace before the tenth flow

Flows with literal ids inside them work until the same id appears in twelve files. Structure the workspace at flow one.

### Page Object Model, Maestro style

Maestro can run JavaScript files that write into a shared `output` object. That gives you a Page Object Model for free: one selector map per screen, no literal selector in any flow.

```js
// elements/common.js
output.nav = {
    tabCatalog: 'home_tab_catalog',   // id
    tabCart: 'home_tab_cart',         // id
    tabAccount: 'home_tab_account',   // id
};
output.firstLaunch = {
    appReady: 'home_tab_catalog',     // id — anything that proves the app rendered
    notificationsLater: 'Not now',    // text — permission sheet, no id reachable
};

// elements/login.js
output.login = {
    screen: 'login_screen',           // id
    email: 'login_email',             // id
    password: 'login_password',       // id
    submit: 'login_submit',           // id
};
output.account = { screen: 'account_screen' };

// elements/catalog.js  (mirrors CatalogTestTags.kt)
output.catalog = {
    screen: 'catalog_screen',
    productCard: 'catalog_product_card',
    productCardTitle: 'catalog_product_card_title',
    productCardFavorite: 'catalog_product_card_favorite',
};
```

```yaml
# elements/loadElements.yaml — run once at the top of every flow
appId: com.example.shop
---
- runScript: common.js
- runScript: login.js
- runScript: catalog.js
- runScript: testdata.js
```

Flows reference `${output.catalog.productCardFavorite}`. One id change, one file. Comment each entry with `id` or `text` so the stopgaps are visible.

### Subflows for anything reused

Launch, first-run dialogs, login, going back, opening a deep link: each is a subflow. The launcher matters most, because the app id differs per platform and this is the only file that knows it:

```yaml
# subflows/launch_clean.yaml — wipe data, start logged out
appId: com.example.shop
---
- runFlow:
    when:
      platform: Android
    commands:
      - launchApp:
          appId: com.example.shop
          clearState: true
- runFlow:
    when:
      platform: iOS
    commands:
      - launchApp:
          appId: com.example.shop.ios
          clearState: true
```

Write a `launch_warm.yaml` twin with `clearState: false` and `stopApp: true`: it keeps login and preferences but restarts the process, so every flow starts on the home screen instead of wherever the previous one stopped.

Flows call `launch_clean` or `launch_warm`, never `launchApp` directly. Do the same for `navigate_back` (Maestro's `back` is Android-only) and `open_deeplink` (iOS shows an "Open in app?" system dialog on custom-scheme links).

```yaml
# subflows/dismiss_onboarding.yaml — every step optional, so it is a no-op on warm state
appId: com.example.shop
---
- extendedWaitUntil:
    visible:
      id: ${output.firstLaunch.appReady}
    timeout: 30000
- extendedWaitUntil:
    visible: ${output.firstLaunch.notificationsLater}
    timeout: 5000
    optional: true
- tapOn:
    text: ${output.firstLaunch.notificationsLater}
    optional: true
```

### Folder = tag = suite

Put tests in `flows/<area>/<sub_area>/`, and give every flow the tag `<area>-<sub_area>`. That tag is the suite name, locally and in CI. Adding a flow needs no other wiring.

```
.maestro/
├── config.yaml                # flows: ["flows/**"]
├── elements/                  # selector maps, one per screen (+ credentials.template.js)
├── subflows/                  # launch_clean, launch_warm, dismiss_onboarding, navigate_back, …
│   └── <area>/<sub_area>/     # feature-specific building blocks
└── flows/
    ├── bootstrap/             # first launch on a fresh install (run by path, not a suite)
    ├── user/login/            # tag: user-login
    ├── catalog/browse/        # tag: catalog-browse
    ├── cart/checkout/         # tag: cart-checkout
    └── marketing/deeplink/    # tag: marketing-deeplink
```

```yaml
# .maestro/config.yaml
appId: com.example.shop
flows:
  - "flows/**"     # elements/ and subflows/ are excluded on purpose: never run standalone
```

Use the *product's* taxonomy, not the code's, so a product manager can read the tree and tick a backlog. Keep empty folders with a `.gitkeep` so the whole map is visible.

### A lint, because paths and tags fail silently

Maestro resolves `runFlow` paths relative to the calling file. Move a file one level and the reference breaks only when a device runs it. A flow with a wrong tag silently never runs. Write a short script, no device and no Maestro binary needed, and make it the first step of every local run and every CI job. It checks two things:

- every `runFlow`, `file:` and `runScript` target exists, resolved from the referencing YAML;
- every flow under `flows/a/b/` carries the tag `a-b` (or a tag prefixed by it, like `a-b-all`).

### Credentials that never touch git

A committed template, a gitignored real file, and command-line values that always win:

```js
// elements/credentials.template.js — committed. cp → credentials.js (gitignored)
output.credentials = {
    user: 'user@example.com',
    pass: 'CHANGE_ME',
};
```

```yaml
# in the login flow: CLI -e wins, else the file, else skip the login block
- runScript: ../../../elements/credentials.js
- evalScript: "${output.creds = { user: typeof USER !== 'undefined' ? USER : output.credentials.user, pass: typeof PASS !== 'undefined' ? PASS : output.credentials.pass }}"
```

In CI, the runner script (Step 3) writes `credentials.js` from secrets with `chmod 600` and deletes it on exit. Never declare these as `env:` defaults in the flow: in Maestro 2.x a flow's `env:` default *overrides* a value passed with `-e`.

### A complete flow, once all of this is in place

```yaml
appId: com.example.shop
name: user_login_email
tags: [user-login, smoke]
---
- runFlow: ../../../elements/loadElements.yaml
- runFlow: ../../../subflows/launch_clean.yaml
- runFlow: ../../../subflows/dismiss_onboarding.yaml
- runScript: ../../../elements/credentials.js
- evalScript: "${output.creds = { user: typeof USER !== 'undefined' ? USER : output.credentials.user, pass: typeof PASS !== 'undefined' ? PASS : output.credentials.pass }}"

# The Account tab shows the login screen when logged out
- tapOn:
    id: ${output.nav.tabAccount}
- assertVisible:
    id: ${output.login.screen}
- tapOn:
    id: ${output.login.email}
- inputText: ${output.creds.user}
- tapOn:
    id: ${output.login.password}
- inputText: ${output.creds.pass}
- tapOn:
    id: ${output.login.submit}
- extendedWaitUntil:
    visible:
      id: ${output.account.screen}
    timeout: 15000
- takeScreenshot: "screenshots/account_after_login"
```

Every flow ends with an assertion that proves the scenario, not just a tap. A flow that only taps proves nothing.

---

## Step 3. One command that runs everything, identical on a laptop and in CI

This is the most important design decision of the whole setup, and it is not about Maestro.

**CI configuration only runs on the CI provider.** You cannot execute a CircleCI config or a GitHub Actions file on your laptop. Any logic you put there is untestable without pushing commits, and invisible to developers. So the CI config stays a thin wrapper, and every real decision lives in one script that developers run at their desk with the exact command CI runs:

```bash
scripts/e2e.sh --suite pr --apk "$APK" --fresh-install --junit --retry-failed
```

What the script owns:

- **Lint first.** The path-and-tag check from Step 2.
- **Credentials.** Generate `credentials.js` from environment variables when they are set; delete it on exit.
- **Fresh install.** Uninstall, install the APK, apply device setup that tests need (for example `pm set-app-links` so https deep links open the app on an emulator).
- **Bootstrap.** A tiny first flow that dismisses first-launch dialogs (language, notification permission). Otherwise the first real test fails on a popup.
- **Suites in a fixed order.** A suite is a tag. If one suite leaves the app in a state that breaks another (a different account type, a changed preference), it runs last, and the rule is written in the script, once.
- **Preconditions.** A suite that needs a logged-in session gets the login flow run before it.
- **Reports.** `--format junit --output junit-<suite>.xml` per suite, and `--debug-output` into one artifacts folder, so every run leaves the same files in the same layout.
- **Retry once.** A red suite is re-run once before it is declared red, and the retry is reported as such.
- **Keep going.** A failed suite does not stop the others. One run reports everything.

A skeleton to start from (the real one grows, but the shape stays):

```bash
#!/usr/bin/env bash
# scripts/e2e.sh — one command for laptops and CI
set -u -o pipefail
WORKSPACE=".maestro"; ARTIFACTS="build/e2e-artifacts"; APP_ID="com.example.shop"
SUITE="pr"; APK=""; FRESH=0; JUNIT=0; RETRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --suite) SUITE="$2"; shift 2 ;;
    --apk) APK="$2"; shift 2 ;;
    --fresh-install) FRESH=1; shift ;;
    --junit) JUNIT=1; shift ;;
    --retry-failed) RETRY=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

scripts/lint-flows.sh || exit 2

# Credentials from CI secrets, never printed, deleted on exit.
CREDS="$WORKSPACE/elements/credentials.js"
if [ -n "${E2E_USER:-}" ] && [ ! -f "$CREDS" ]; then
  printf "output.credentials = { user: '%s', pass: '%s' };\n" "$E2E_USER" "$E2E_PASS" > "$CREDS"
  chmod 600 "$CREDS"
  trap 'rm -f "$CREDS"' EXIT
fi

if [ "$FRESH" = 1 ]; then
  adb uninstall "$APP_ID" >/dev/null 2>&1 || true
  adb install -r "$APK"
fi
adb shell pm set-app-links --package "$APP_ID" 2 all >/dev/null 2>&1 || true

case "$SUITE" in
  pr)      PLAN="catalog-browse cart-checkout marketing-deeplink-all user-login" ;;
  nightly) PLAN="catalog-browse cart-checkout marketing-deeplink user-login" ;;
  *)       PLAN="$SUITE" ;;
esac

run_suite() {
  local suite="$1"
  local cmd=(maestro test --debug-output "$ARTIFACTS/maestro-debug/$suite" --flatten-debug-output)
  [ "$JUNIT" = 1 ] && cmd+=(--format junit --output "$ARTIFACTS/junit-$suite.xml")
  "${cmd[@]}" --include-tags "$suite" "$WORKSPACE"
}

maestro test "$WORKSPACE/flows/bootstrap/first_launch.yaml" || exit 1

FAILED=""
for s in $PLAN; do
  run_suite "$s" && continue
  if [ "$RETRY" = 1 ] && run_suite "$s"; then echo "$s: PASS (on retry)"; continue; fi
  FAILED="$FAILED $s"
done
[ -z "$FAILED" ] || { echo "failed suites:$FAILED"; exit 1; }
echo "all suites green"
```

Bash, not Python or Kotlin, because it needs zero runtime on a bare CI machine and is mostly orchestration of CLI tools. The same script can later be called by any CI provider without a port.

Three layers, deliberately separated:

| Layer | Where | Job |
|---|---|---|
| Orchestration | `.circleci/config.yml` (or a GitHub Actions workflow) | *when* to run, *where*, report to the PR and chat |
| Test running | `scripts/e2e.sh` | *what* to run, in *which order*: retries, credentials, reports, artifacts |
| Machine | an emulator helper locally, the provider's emulator steps in CI | boot and kill the emulator reliably |

When CI is red, a developer reproduces it with one line at their desk. That property also pays for itself the day you switch CI providers (Step 6).

---

## Step 4. Run headless, and know what "headless" means

Nobody sees an emulator window during a headless run, and the first reaction is "the test is frozen". Put these two statements in your docs and your team presentation:

> **The emulator runs without a window on purpose, and the test doesn't need one.**
>
> **Maestro never looks at the window.** It talks to the device over `adb` and a small driver app it installs on the device; it reads the UI hierarchy from that driver and sends taps and text the same way. A headless run is identical to a windowed one.

To *watch* a run, boot the same AVD with a window from Android Studio and run the flow. App data and login survive.

A boot recipe that works on a laptop and on GPU-less Linux CI machines alike (the CircleCI config in Step 5 uses exactly these flags):

```bash
emulator -avd ci_avd \
  -no-window -noaudio -no-boot-anim -no-snapshot-save \
  -dns-server 8.8.8.8,1.1.1.1 \
  -gpu swiftshader_indirect -camera-back none -camera-front none

adb wait-for-device
while [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" != "1" ]; do sleep 3; done
adb shell input keyevent 82   # dismiss the lock screen

adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
```

Why each flag matters:

- `-dns-server 8.8.8.8,1.1.1.1`: emulator DNS can die silently (IP traffic works, hostnames do not, `adb reboot` does not fix it). Pin it.
- `-gpu swiftshader_indirect`, no cameras: a Linux VM in CI has no GPU and no webcam; without these the emulator fails to start or probes hardware that is not there.
- A `google_apis` system image, never `*_playstore`: `pm set-app-links` needs a debuggable image with the link verifier.
- Animations off: fewer swallowed taps, faster runs.

Same idea on iOS: `xcrun simctl boot <udid>`. The simulator does not need Simulator.app open.

---

## Step 5. CI on CircleCI: build once, one emulator per suite, a check on the PR

### Why CircleCI for the main example

- **An independent free bucket.** The free plan includes a monthly allowance of credits (30,000 at the time of writing) that nothing else in your GitHub organisation consumes. GitHub Actions minutes, by contrast, are shared by every workflow of every repository in the organisation.
- **An Android machine image.** A Linux VM with the SDK, `sdkmanager`, several JDKs and nested virtualisation (KVM) preinstalled. The x86_64 emulator boots with hardware acceleration and nothing to install but the system image.
- **`parallelism`.** One job, N containers, one suite each. No matrix to maintain.
- **GitHub stays the source of truth.** CircleCI is reached through its GitHub App and posts a status on the PR. Repo, reviews, secrets ownership and branch protection do not move.

One arithmetic fact decides the rest of the architecture, whichever provider you pick: **hosted macOS costs about ten times hosted Linux.** Android E2E on Linux is affordable; iOS on hosted Macs is not. iOS is Step 8.

### Connect the project (once)

1. Install the CircleCI GitHub App on the organisation and create the project. Point its pipeline definition at `.circleci/config.yml`. (A GitHub organisation can be connected to one CircleCI organisation only.)
2. Create the **triggers**: "PR opened or pushed to" and "PR marked ready for review". Two are needed because the first does not fire when a PR leaves draft. With the CLI:

   ```bash
   circleci project trigger create --pipeline-definition-id <definition-id> --repo-id <github-repo-id> --event-preset only-build-prs
   circleci project trigger create --pipeline-definition-id <definition-id> --repo-id <github-repo-id> --event-preset only-ready-for-review-prs
   ```

3. Create a **context** for the secrets and restrict it to the project. Values are prompted, never echoed:

   ```bash
   circleci context create e2e-secrets --org <org-id>
   circleci context secret set e2e-secrets --name E2E_USER
   circleci context secret set e2e-secrets --name E2E_PASS
   circleci context secret set e2e-secrets --name SLACK_WEBHOOK_URL   # optional, Step 7
   ```

4. Turn on **auto-cancel redundant workflows**, so a new push cancels the outdated run on the same branch:

   ```bash
   circleci project setting set auto-cancel-builds true
   ```

5. Add a **weekly schedule** in the project settings (branch `main`, parameter `suite=nightly`). Manual full runs at any time:

   ```bash
   circleci run trigger --branch main --parameter suite=nightly
   ```

Flags and command names follow the CLI at the time of writing; every setting also exists in the project settings UI.

### The config, piece by piece

The whole file is `.circleci/config.yml`. Four jobs:

```
decide ─► build ─► test (parallelism: one container per suite) ─► report
```

**Header: parameters, the AVD contract, executors and two reusable commands.**

```yaml
version: 2.1

parameters:
  suite:
    description: "pr | nightly | one <area>-<sub_area> tag"
    type: string
    default: pr
  shards:
    description: "Parallel test containers: one per suite of the plan, 1 for a single tag"
    type: integer
    default: 4

# Shared by every job: the pinned tool version and the AVD contract.
# target must stay google_apis (never *_playstore): pm set-app-links needs it.
common-env: &common-env
  MAESTRO_VERSION: "2.8.0"
  APP_ID: com.example.shop
  ARTIFACTS_DIR: build/e2e-artifacts
  AVD_NAME: ci_avd
  AVD_PACKAGE: "system-images;android-34;google_apis;x86_64"
  AVD_PROFILE: pixel_7
  AVD_RAM_MB: "3072"
  EMULATOR_BOOT_TIMEOUT: "900"

executors:
  # Linux VM with the Android SDK, sdkmanager, JDKs and KVM preinstalled.
  # The gen2 image needs gen2 class names ("large" alone is rejected).
  android-vm:
    machine:
      image: android:current
    resource_class: large.gen2
    environment:
      <<: *common-env
  # For the seconds-long jobs that only need git, bash and python.
  tiny:
    docker:
      - image: cimg/python:3.12
    resource_class: small
    environment:
      <<: *common-env

commands:
  # JDK 17 for Gradle and for Maestro (a JVM tool); exported to later steps.
  use-jdk-17:
    steps:
      - run:
          name: Use JDK 17
          command: |
            if ! java -version 2>&1 | grep -q '"17'; then
              HOME17="$(ls -d /usr/lib/jvm/*17* | head -n 1)"
              echo "export JAVA_HOME=$HOME17" >> "$BASH_ENV"
              echo "export PATH=$HOME17/bin:\$PATH" >> "$BASH_ENV"
            fi
  # The project's gradle.properties is sized for developer machines. The
  # Gradle user home overrides it, so CI gets a cap without touching the repo.
  # "\<<" because "<<" alone is CircleCI's parameter syntax.
  cap-gradle-memory:
    steps:
      - run:
          name: Cap Gradle memory for the CI machine
          command: |
            mkdir -p ~/.gradle
            cat >> ~/.gradle/gradle.properties \<<'EOF'
            org.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g -Dkotlin.daemon.jvm.options=-Xmx2g
            org.gradle.daemon=false
            org.gradle.workers.max=3
            EOF
```

**`decide`: lint, then turn the parameter into the list of suites the containers will read.**

```yaml
jobs:
  decide:
    executor: tiny
    steps:
      - checkout
      - run:
          name: Lint flow references
          command: scripts/lint-flows.sh
      - run:
          name: Plan the run
          command: |
            PR_SUITES='["catalog-browse","cart-checkout","marketing-deeplink-all","user-login"]'
            NIGHTLY_SUITES='["catalog-browse","cart-checkout","marketing-deeplink","user-login"]'
            LABEL="<< pipeline.parameters.suite >>"
            case "$LABEL" in
              pr)      SUITES="$PR_SUITES" ;;
              nightly) SUITES="$NIGHTLY_SUITES" ;;
              *)       SUITES="[\"$LABEL\"]" ;;    # a single <area>-<sub_area> tag
            esac
            mkdir -p plan
            echo "$SUITES" > plan/suites.json
            echo "$LABEL" > plan/label
      - persist_to_workspace:
          root: .
          paths: [ plan ]
```

**`build`: once, cached, and the APK goes to the workspace, not to the artifacts.**

```yaml
  build:
    executor: android-vm
    steps:
      - checkout
      - attach_workspace:
          at: .
      - use-jdk-17
      - cap-gradle-memory
      - restore_cache:
          keys:
            - gradle-v1-{{ checksum "gradle/libs.versions.toml" }}-{{ checksum "gradle/wrapper/gradle-wrapper.properties" }}
            - gradle-v1-
      - run:
          name: Build the debug APK
          no_output_timeout: 40m
          command: ./gradlew :app:assembleDebug --stacktrace
      - save_cache:
          key: gradle-v1-{{ checksum "gradle/libs.versions.toml" }}-{{ checksum "gradle/wrapper/gradle-wrapper.properties" }}
          paths:
            - ~/.gradle/caches
            - ~/.gradle/wrapper
      - run:
          name: Hand the APK to the test containers
          command: |
            APK="$(ls app/build/outputs/apk/debug/*.apk 2>/dev/null | head -n 1)"
            [ -n "$APK" ] || { echo "no APK after the build"; exit 1; }
            mkdir -p apk && cp "$APK" apk/
      - persist_to_workspace:
          root: .
          paths: [ apk ]
```

**`test`: one container per suite. Each boots its own emulator, so no session leaks between suites.**

```yaml
  test:
    executor: android-vm
    parallelism: << pipeline.parameters.shards >>
    steps:
      - checkout
      - attach_workspace:
          at: .
      # Container N runs suite N of the plan and halts when there is none.
      - run:
          name: Pick this container's suite
          command: |
            SUITE="$(python3 -c 'import json,sys; s=json.load(open("plan/suites.json")); i=int(sys.argv[1]); print(s[i] if i < len(s) else "")' "$CIRCLE_NODE_INDEX")"
            [ -n "$SUITE" ] || { echo "no suite for container $CIRCLE_NODE_INDEX"; circleci-agent step halt; exit 0; }
            echo "export SUITE=$SUITE" >> "$BASH_ENV"
      - use-jdk-17
      - run:
          name: Preflight — SDK, KVM, Maestro at the pinned version
          command: |
            SDK="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
            echo "export ANDROID_HOME=$SDK" >> "$BASH_ENV"
            echo "export PATH=$SDK/platform-tools:$SDK/emulator:$SDK/cmdline-tools/latest/bin:\$HOME/.maestro/bin:\$PATH" >> "$BASH_ENV"
            [ -r /dev/kvm ] && [ -w /dev/kvm ] || sudo chmod 666 /dev/kvm
            curl -fsSL "https://get.maestro.mobile.dev" | bash
            ACTUAL="$(~/.maestro/bin/maestro --version 2>/dev/null | tail -n 1)"
            [ "$ACTUAL" = "$MAESTRO_VERSION" ] || { echo "maestro is '$ACTUAL', expected $MAESTRO_VERSION"; exit 1; }
      - run:
          name: Install the emulator and the system image, create the AVD
          command: |
            yes 2>/dev/null | sdkmanager --licenses >/dev/null || true
            sdkmanager --install "emulator" "platform-tools" "$AVD_PACKAGE"
            echo no | avdmanager create avd -n "$AVD_NAME" -k "$AVD_PACKAGE" -d "$AVD_PROFILE" --force
            CFG="$HOME/.android/avd/$AVD_NAME.avd/config.ini"
            sed -i '/^hw.ramSize=/d' "$CFG" && echo "hw.ramSize=$AVD_RAM_MB" >> "$CFG"
      # CircleCI kills every process a step started when the step ends, so the
      # emulator cannot be nohup'ed from a normal step. A background step keeps
      # its foreground process alive until the job ends: that process IS the emulator.
      - run:
          name: Start the emulator (kept alive in the background)
          background: true
          command: |
            exec "$ANDROID_HOME/emulator/emulator" -avd "$AVD_NAME" \
              -no-window -noaudio -no-boot-anim -no-snapshot-save \
              -dns-server 8.8.8.8,1.1.1.1 -gpu swiftshader_indirect \
              -camera-back none -camera-front none
      - run:
          name: Wait for the emulator to boot, disable animations
          command: |
            DEADLINE=$(( $(date +%s) + EMULATOR_BOOT_TIMEOUT ))
            adb wait-for-device
            while [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]; do
              [ "$(date +%s)" -lt "$DEADLINE" ] || { echo "emulator not booted after ${EMULATOR_BOOT_TIMEOUT}s"; exit 1; }
              sleep 3
            done
            adb shell input keyevent 82 || true
            for s in window_animation_scale transition_animation_scale animator_duration_scale; do
              adb shell settings put global "$s" 0
            done
      # The script's exit code goes to a status file instead of failing the job:
      # CircleCI does not start a dependent job after a failure, and `report`
      # must always run (chat summary, then the red light).
      - run:
          name: Run the suite
          no_output_timeout: 35m
          command: |
            START="$(date +%s)"
            mkdir -p e2e-out/status
            if scripts/e2e.sh --suite "$SUITE" --apk "$PWD/apk/$(ls apk | head -n 1)" --fresh-install --junit --retry-failed; then
              CONCLUSION=success
            else
              CONCLUSION=failure
            fi
            python3 - "$SUITE" "$CONCLUSION" "$START" "$CIRCLE_BUILD_URL" \<<'EOF'
            import json, sys, time
            suite, conclusion, start, url = sys.argv[1:]
            json.dump({"conclusion": conclusion, "url": url, "duration_s": int(time.time()) - int(start)},
                      open(f"e2e-out/status/{suite}.json", "w"))
            EOF
            echo "suite $SUITE → $CONCLUSION"
      # Storage: a green suite keeps only JUnit + maestro.log. Files only, never
      # folders — a <flow>-2 folder is how the report detects a retry.
      - run:
          name: Prune artifacts of a green suite
          when: always
          command: |
            [ -d "$ARTIFACTS_DIR" ] || exit 0
            if grep -q '"conclusion": "success"' "e2e-out/status/$SUITE.json" 2>/dev/null; then
              find "$ARTIFACTS_DIR" -type f \( -path '*/screenshots/*' -o -path '*/screen-hierarchy/*.json' \
                -o -name 'logcat.txt' -o -name 'device-logcat.txt' -o -name '*.mp4' \) -delete
            fi
      - run:
          name: Collect artifacts for the report job
          when: always
          command: |
            mkdir -p "e2e-out/e2e-$SUITE"
            [ -d "$ARTIFACTS_DIR" ] && cp -R "$ARTIFACTS_DIR"/. "e2e-out/e2e-$SUITE/" || true
      - store_test_results:
          path: build/e2e-artifacts        # junit-*.xml → the job's Tests tab
      - store_artifacts:
          path: build/e2e-artifacts
          destination: e2e
      - persist_to_workspace:
          root: .
          paths: [ e2e-out ]
```

**`report`: one place for the whole run, then the red light.**

```yaml
  report:
    executor: tiny
    steps:
      - checkout
      - attach_workspace:
          at: .
      - run:
          name: Per-suite summary
          command: |
            echo "Suite set: $(cat plan/label)"
            for f in e2e-out/status/*.json; do
              [ -e "$f" ] || { echo "no status files — every container halted or crashed"; break; }
              python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); s=int(d["duration_s"]); print(f"{sys.argv[1].split(\"/\")[-1][:-5]:<28} {d[\"conclusion\"]:<8} {s//60}m {s%60:02d}s")' "$f"
            done
      # Optional: one message per run in the team channel (Step 7). Never fails the job.
      - run:
          name: Chat summary
          command: |
            [ -n "${SLACK_WEBHOOK_URL:-}" ] || { echo "no webhook configured — skipped"; exit 0; }
            python3 - \<<'EOF' > payload.json
            import glob, json, os
            rows = []
            for p in sorted(glob.glob("e2e-out/status/*.json")):
                d = json.load(open(p)); suite = os.path.basename(p)[:-5]; s = int(d["duration_s"])
                icon = ":large_green_circle:" if d["conclusion"] == "success" else ":red_circle:"
                rows.append(f"{icon} `{suite}` {s // 60}m {s % 60:02d}s")
            url = "https://app.circleci.com/pipelines/workflows/" + os.environ.get("CIRCLE_WORKFLOW_ID", "")
            print(json.dumps({"text": f"E2E on `{os.environ.get('CIRCLE_BRANCH', '?')}` — <{url}|open the run>\n" + "\n".join(rows)}))
            EOF
            curl -sS -o /dev/null -X POST -H 'Content-type: application/json' --data @payload.json "$SLACK_WEBHOOK_URL" || true
      - run:
          name: Fail if any suite failed
          command: |
            FAILED=""
            for f in e2e-out/status/*.json; do
              [ -e "$f" ] || { echo "no suite ran"; exit 1; }
              grep -q '"conclusion": "success"' "$f" || FAILED="$FAILED $(basename "$f" .json)"
            done
            [ -z "$FAILED" ] || { echo "failed suites:$FAILED — see the Tests tab and the e2e artifacts of the test job"; exit 1; }
            echo "all suites green"
```

**The workflow: non-draft PRs, pushes to `main`, the schedule, and manual triggers. Nothing else.**

```yaml
workflows:
  e2e:
    # A push to a draft PR still creates a pipeline, but the workflow is
    # "not run", which costs no credits. The event-name check must come
    # first: pipeline.event.github.* is only populated on PR events.
    when: >-
      (pipeline.event.name == "pull_request" and pipeline.event.github.pull_request.draft == false)
      or pipeline.event.name == "schedule"
      or pipeline.event.name == "api"
      or (pipeline.event.name == "push" and pipeline.git.branch == "main")
    jobs:
      - decide
      - build:
          requires: [ decide ]
      - test:
          requires: [ build ]
          context: e2e-secrets
      - report:
          requires: [ test ]
          context: e2e-secrets
```

Validate before pushing: `circleci config validate`.

### Four things that are not on the first page of the docs

They are all in the config above; this is why.

1. **The emulator must be a `background: true` step.** CircleCI kills every process a step started when the step ends, so a `nohup emulator &` inside a normal step is dead one step later (`adb: error: closed`). The background step's foreground process *is* the emulator, and a separate step polls `sys.boot_completed`.
2. **A red suite must not fail the `test` job.** CircleCI does not start a dependent job after a failure, and `report` must always run. Hence the status files; `report` turns the workflow red at the end, and the suite's own failures stay visible in the Tests tab through the JUnit files.
3. **Shards are `parallelism`, not a matrix.** CircleCI matrices are static; the suite list depends on a parameter. Container *i* reads suite *i* and halts if there is none, so the `shards` parameter can exceed the plan.
4. **Draft PRs cost nothing** with the two triggers plus the `when` expression. Team rule: open PRs as drafts while iterating, mark ready when you want the run.

### What a run looks like

- The PR shows one CircleCI status. The `test` job's **Tests** tab lists every flow by name, green or red.
- The `test` job's **Artifacts** tab holds `e2e/` per container: JUnit and Maestro's log for a green suite, everything (screenshots, logcats, hierarchy dumps) for a red one. `decide`, `build` and `report` upload nothing on purpose.
- With a warm Gradle cache, expect a build of one or two minutes, the longest shard around ten minutes, and a verdict on the PR in about a quarter of an hour.

### Keeping it free

**Credits.** Do the arithmetic once: **free runs per month = allowance ÷ credits of one full run**, where one full run = container-minutes × the class rate. Linux VM rates at the time of writing: `medium.gen2` 18 credits per minute, `large.gen2` 36. For example, a five-minute build plus four eight-minute shards is 37 container-minutes; on `large.gen2` that is about 1,300 credits, so 30,000 credits buy roughly 20 full runs a month. Read your own numbers from the Insights page rather than the header comment of your config. Levers, in order of effect: draft PRs (free until ready for review), auto-cancel, a weekly full pass instead of a nightly, the cheaper `medium.gen2` class with a lower Gradle cap, and an `approval` job between `decide` and `build` as a last resort.

**Storage.** The free plan includes a small allowance (2 GB-months at the time of writing), charged at save time as size × retention days, with a fixed retention and no way to delete artifacts by hand. The usual culprit is not the test artifacts: it is the **Gradle cache**, over a gigabyte per key and saved again whenever a dependency bump changes the key. So: no APK artifact, prune green suites (already in the config), and if the cache is the hog, cache only `~/.gradle/caches/modules-2` and `~/.gradle/wrapper` or drop the `gradle-v1-` prefix fallback that restores old dependencies next to new ones. Storage overage is billed out of credits, not blocking. Watch it in the first week.

---

## Step 6. The alternative: GitHub Actions on hosted Linux

If your organisation has Actions minutes to spare, or the day the CircleCI credits run short, the same pipeline runs on GitHub-hosted Linux. Because everything real lives in `scripts/e2e.sh`, the port is a day of orchestration.

**The money facts.** Private repositories get a monthly bucket of Actions minutes (2,000 on the Free plan, 3,000 on Team at the time of writing), shared by the whole organisation. Linux counts ×1, macOS ×10. Overage is about $0.008 per Linux minute. The organisation's spending limit defaults to $0, so when the minutes are gone, jobs refuse to start, which is exactly why a second provider is worth having ready.

**The shape** is the same, with a matrix instead of `parallelism`:

```
decide ─┬─► build ───────┐
        └─► prepare-avd ─┴─► test (matrix, one job per suite) ─► report
```

`prepare-avd` creates the AVD and saves a boot snapshot when the cache misses, so every shard only restores it. The pieces worth copying:

```yaml
- name: Enable KVM               # hosted Linux runners have /dev/kvm, not world-accessible
  run: |
    echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' \
      | sudo tee /etc/udev/rules.d/99-kvm4all.rules
    sudo udevadm control --reload-rules && sudo udevadm trigger --name-match=kvm

- name: Reclaim disk space       # the emulator refuses to start with too little free disk
  run: |
    sudo rm -rf /usr/share/dotnet /usr/local/.ghcup /opt/ghc \
      /opt/hostedtoolcache/CodeQL /usr/local/lib/android/sdk/ndk \
      /usr/share/swift /usr/local/share/powershell
    docker image prune --all --force

- name: Cache the AVD boot snapshot
  uses: actions/cache@v4
  with:
    path: ~/.android/avd/*
    key: avd-34-google_apis-x86_64-pixel_7-3072M-v1

- name: Run the suite on the emulator
  uses: reactivecircus/android-emulator-runner@v2
  with:
    api-level: 34
    target: google_apis
    arch: x86_64
    profile: pixel_7
    ram-size: 3072M
    force-avd-creation: false
    emulator-options: -no-snapshot-save -no-window -gpu swiftshader_indirect -noaudio -no-boot-anim -camera-back none -camera-front none -dns-server 8.8.8.8,1.1.1.1
    disable-animations: true
    script: scripts/e2e.sh --suite ${{ matrix.suite }} --apk "$APK_PATH" --fresh-install --junit --retry-failed
```

Plus the Gradle cache (`gradle/actions/setup-gradle`, read-only on PRs, written on the default branch), the same memory cap as Step 5, a concurrency group keyed on the PR number with `cancel-in-progress`, and a JUnit action for the check (Step 7).

Three things that bite on the first runs:

- **`ram-size` matters.** Too little guest RAM on a small host starves the app's cold start, the launcher raises an "isn't responding" dialog on top of everything, and Maestro sees only the dialog. Give the AVD 3 GB.
- **The emulator-runner `script` runs each line in its own shell.** No shared variables, no `\` continuations. Compute the APK path in a previous step, export it through `$GITHUB_ENV`, keep `script` to one line.
- **Hosted emulators are two to three times slower than a laptop**, on either provider. A scroll that takes a second locally can take five seconds in CI, and a 10-second `scrollUntilVisible` budget buys one or two attempts. A timeout is a *ceiling*, not a wait: the command returns the moment it succeeds, so a generous budget costs a fast machine nothing. Size waits for the slowest machine: 30 s for the first screen after a process start, 15 to 20 s per transition, 30 s for `scrollUntilVisible`, 10 s for a state change after a tap.

**A note on self-hosted runners.** A spare Mac registered as a runner is tempting: minutes are not billed, caches stay warm, and it can run the iOS simulator. It also runs one job at a time, sleeps, travels, fills its disk, and ties the team's CI to one person. Keep the option for iOS (Step 8). For Android, hosted Linux is better.

---

## Step 7. Make a red run readable in two minutes

A red check nobody can diagnose gets re-run until green, and then nobody trusts it. Three things fix that.

### JUnit per suite, so the PR shows test names

`maestro test --format junit --output junit-<suite>.xml` writes standard `<testsuite><testcase>` XML. CircleCI's `store_test_results` turns it into the Tests tab with every flow's name; on GitHub Actions an action such as `mikepenz/action-junit-report` turns it into a check. A retry overwrites the file, so the XML always reflects the final attempt. Every JUnit file also carries a `time` attribute, so each run publishes its own per-suite breakdown: measure before you shard.

### Artifacts, same layout locally and in CI

| Artifact | What it tells you |
|---|---|
| `junit-<suite>.xml` | per-test results; what the PR check is built from |
| `maestro-debug/<suite>/<flow>/` | Maestro's own log, a screenshot of the exact failure moment, the UI hierarchy dump, and the *per-flow* device log |
| `screenshots/` | the screenshots the flows take at checkpoints |
| `logcat.txt` | the device log of the **last flow only**: Maestro clears the buffer at every flow start, so read the per-flow one above |

Locally they land in `build/e2e-artifacts/`; in CI they are the job's artifacts. Same files, same paths, so the debugging guide is one document.

### A chat summary built by a script, not by YAML

Every run, green or red, posts to the team channel. The minimal version is in the `report` job of Step 5: one line per suite with its status and duration, and a link to the run. Grow it from the artifacts: which flow failed on what assertion (the JUnit `<failure>` message), whether the suite passed on retry (a `<flow>-2` folder under `maestro-debug/`), and whether the screen was covered by a system dialog rather than the app failing (a hierarchy dump containing `android:id/aerr_close`). Keep it a stdlib-only script that reads *only* files on disk, so it runs identically at a desk against downloaded artifacts and can be unit-checked in the `decide` job against one green and one red fixture. Make it `continue-on-error`: a chat problem never turns a run red. Pass user-controlled text (PR title, branch) through environment variables only, never interpolated into a shell body.

### The flake policy, written down

CI retries each red suite once. **Green on retry is an environment flake** (an interstitial hijacked the screen, content arrived without the expected element) and is reported as such. **Red twice is real.** Investigate, do not re-run and hope. A flow that is red twice without a bug gets a `flaky` tag and a ticket. The gate only works if it stays trustworthy.

---

## Step 8. iOS with the same files

With Compose Multiplatform, the same flows and the same selector maps run on the iOS simulator. "Same files" does not mean "nothing to do".

### What differs, and where it lives

Every platform difference lives in exactly one subflow, never inline in a flow. Three come from the iOS accessibility tree:

- **Interactive nodes are hoisted.** On iOS, Compose Multiplatform places buttons and chips as *siblings* after their container, not inside it, so `childOf` never matches there. A `tap_favorite` subflow uses `childOf` the card root on Android and `index` on iOS.
- **`selected` is `selected`.** Android reports Compose's `selected` as `checked`; iOS reports `selected`. Maestro wants literal booleans there, so a `wait_favorited` subflow has an Android branch and an iOS branch.
- **Text fields never report `focused`.** The focus ring is visible, the tree says false. Any "did the tap focus the field?" loop is Android-only.

Plus the system: `back` is a no-op on iOS (tap the top-bar arrow by its accessibility label instead, which means every top bar must label its arrow); custom-scheme deep links raise an "Open in app?" dialog; https links go to Safari on a simulator; and the **App Store review prompt** is a system alert that, while shown, is the *only* thing in the accessibility tree, so every wait behind it fails. Run an optional dismiss subflow before any wait that can coincide with an app resume.

### The build chain

```bash
cd iosApp && pod install && cd ..
./gradlew :shared:linkDebugFrameworkIosSimulatorArm64     # pre-link from a plain shell
xcodebuild -workspace iosApp/iosApp.xcworkspace -scheme iosApp -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build/ios ARCHS=arm64 CODE_SIGNING_ALLOWED=NO build
scripts/e2e.sh --platform ios --suite pr --app build/ios/Build/Products/Debug-iphonesimulator/iosApp.app
```

Two flags matter more than they look. `ARCHS=arm64`: without it the generic simulator destination asks for x86_64, and a KMP framework built for Apple Silicon has no such target. And the Gradle pre-link: on a clean checkout, letting Xcode's run-script phase do the cold Kotlin/Native compile can make the KMP CocoaPods plugin spawn a nested `xcodebuild` *inside* Xcode's build, inheriting its environment and crashing the build service. Local builds never show it because the cache already exists. Run the link task from a plain shell first, and Xcode's call becomes a no-op.

### The driver

Maestro's iOS driver is an XCTest runner started by `xcodebuild test-without-building`, and that process outlives the `maestro` CLI. Left alone, the previous suite's orphan relaunches its runner on top of the next suite's driver ("Device became unreachable" mid-flow). Kill stale drivers before every suite (`pgrep -f "xcodebuild test-without-building"`), and reboot the simulator after a driver death before a retry.

### The honest decision

Hosted macOS costs ten times Linux, on every provider. If nobody can offer an Apple Silicon Mac as a runner, park iOS CI: keep a manual-only job, and add a PR-template checkbox, *run the iOS suite locally for PRs touching iOS code*. The flows stay green because they are the same files as Android's, and the day a Mac is registered as a runner, iOS comes back with no code change.

---

## The traps: each of these costs a day

Symptom first, fix second.

1. **`index` sorts by screen position, not by hierarchy.** `index: 0` picks from all matches sorted by (y, x). In a two-column grid, two elements of the same card can sort into different rows by a single pixel, so `title index 0` and `favorite index 0` may be different cards. Fix: pick the card root once, then select inside it with `childOf` plus `containsDescendants` (Android). Never combine bare indexes on two different tags of the same card.

2. **`retryTapIfNoChange` double-taps toggles.** It is on by default: if the hierarchy did not change after a tap, Maestro taps again. An icon swap is not a hierarchy change, so a favorite toggles straight back off. Set `retryTapIfNoChange: false` on every toggle, then wait for the state.

3. **Flow `env:` defaults override `-e` values** in Maestro 2.x. Never declare defaults for injectable variables; guard with `typeof VAR !== 'undefined'`.

4. **`hideKeyboard` can act like Back** in apps that handle the back dispatch themselves, and pop the screen. Tap the next element with the keyboard open instead.

5. **A tap during scroll deceleration is swallowed.** It stops the scroll and is never delivered as a click; Maestro reports the tap as completed. After every `scrollUntilVisible` that precedes a tap: `waitForAnimationToEnd`, then a guarded single re-tap with `repeat: {times: 1, while: {notVisible: <expected state>}}`.

6. **Elements under a sticky footer count as visible.** The tap lands on the footer. A target cut by the bottom edge gets a tap that never arrives. Center the element, or scroll to the page end and settle, then tap and verify the state.

7. **`retry` prints the failed attempt at the end of a passing run.** Exit code 0, but the console looks red. `repeat` with `while` prints nothing.

8. **`launchApp clearState: true` right after another flow can kill the new process.** Android removes the previous task asynchronously, and the removal can land on the freshly started process: blank window, empty hierarchy, and the first-launch dialog appearing on the *next* flow. Fix: wait generously (45 s) for anything to render, and relaunch without clearing if nothing did. Size that guard for the slowest machine: too short and it kills a healthy app just before its first frame, on every run.

9. **The APK on the device was built from another branch**, without the tags. Same byte size, so size proves nothing. Compare `git reflog` with the APK's modification time; rebuild and `adb install -r`.

10. **A full disk looks like a hung test.** The emulator stalls on writes, `adb devices` still lists it, Maestro sits on its current command forever, and on CI the job vanishes with no report. Add a preflight that fails fast under 15 GB free. Usual hogs on a Mac: Xcode DerivedData, `iOS DeviceSupport`, old Kotlin/Native toolchains, simulator data.

11. **Maestro Studio open, or a stale driver on the device, kills every CLI run instantly** (`DeviceServerDiedException`, zero steps, exit 1). Quit Studio; `adb uninstall dev.mobile.maestro` and let the CLI reinstall its driver.

12. **Things that hijack the screen:** an ad interstitial opening a browser over the app, a launcher "isn't responding" dialog raised during the APK install on a starved runner, the iOS review prompt. Give the emulator enough RAM, set `adb shell settings put global hide_error_dialogs 1`, sweep for standing ANR dialogs before each suite, and grep the hierarchy dumps for `android:id/aerr_close` when every step of a shard fails the same way.

13. **A timeout is a ceiling.** Size every wait for the slowest machine that will run it. It costs a fast machine nothing (Step 6).

14. **Maestro clears logcat at every flow start.** The top-level `logcat.txt` covers the last flow only. The per-flow `device-logcat.txt` under `--debug-output` is the real source.

15. **Overlays are new windows.** Tags inside a `ModalBottomSheet` or `Dialog` are invisible to Maestro on Android until the overlay root opts in (Step 1).

---

## Making it a team habit, not a one-person project

The tooling is the easy half. Three documents and one rule make it stick.

**A coverage plan with side effects marked.** Derive every end-to-end scenario from the app's navigation graph, one row each, with a status (covered / partial / to do), a priority (P0 must stay green on every PR, P1 weekly, P2 on demand), the account it needs, and a warning when the scenario changes real data. Some rows are deliberately "assert up to the last step, then stop": account deletion, real payments, bulk destructive actions, card forms in webviews, OTP resend loops. If the suites run against production with test accounts, write down what they leave behind, where everyone can see it, before someone is surprised.

**A team plan, one step at a time.** Setup and one existing suite green on everyone's machine; then a first flow (developers add tags on a screen they own, QA writes one scenario with Maestro Studio); then the product manager's scenario list; then the rhythm: one flow per PR, the coverage row ticked, a 15-minute weekly review of the list.

**Two guides for two audiences.** A QA guide in plain words (running suites, authoring with Studio, the rules that save your day) and a developer guide (every script and *why* each decision was made). Explaining the why is what stops the next person from undoing a decision that looks arbitrary.

**The rule:** a PR that changes a screen adds or updates its tags and its flow, in the same PR.

If you use an AI coding assistant, Maestro ships an MCP server (`maestro mcp`) that lets it inspect the live screen hierarchy and run flows. Point the assistant at it, give it the workspace rules and the traps above as a checklist, and let it draft flows that you then review and repair against a real device.

---

## What "free" really means

Public plan numbers at the time of writing, and how to turn them into your own budget:

| Provider | Free allowance (private repo) | Unit cost | What to measure |
|---|---|---|---|
| CircleCI | 30,000 credits/month, 2 GB-months storage, not shared with anything else | Linux VM classes: `medium.gen2` 18 credits/min, `large.gen2` 36 | container-minutes per full run × the class rate, from the Insights page |
| GitHub Actions, hosted Linux | 2,000 min/month (Free), 3,000 (Team), shared by the whole organisation | Linux ×1, macOS ×10; overage ≈ $0.008 per Linux minute | job minutes per full run, from the run's Usage tab |

Then do the arithmetic: **free runs per month = allowance ÷ cost of one full run**. With a build, an emulator boot and a handful of shards, a full run is typically a few thousand credits on CircleCI or 100 to 200 Linux minutes on GitHub. Either way, "free" means **enough for a small team that opens PRs as drafts and marks them ready when it wants the run**, with a weekly full pass instead of a nightly.

When you outgrow it, the bill is small and predictable, and the *architecture* does not change, because the tests never knew which provider was calling the script.

---

## Where to go from here

- **Delivery.** Once every PR is tested, add signed, numbered builds, nightly delivery to testers gated on a green run, a store internal track for release candidates, and production as one human approval with a staged rollout.
- **iOS in CI** the day a Mac runner exists. No code change needed.
- **A pre-production environment** with seeded test accounts, so the suites stop leaving data on production.
- **Close the P0 gaps** in the coverage plan, one flow per PR.

---

## The checklist

If you keep one section, keep this one.

1. **Choose Maestro**, pin the version, decide on `id:` selectors.
2. **Tag the app first**: `testTag` on every screen root, CTA and input; one constants object per screen; the Android `testTagsAsResourceId` opt-in on the NavHost *and* on every overlay root; `semantics { selected }` on toggles.
3. **Structure the workspace at flow one**: selector maps in JS, subflows for launch / onboarding / login / back / deep link, `flows/<area>/<sub_area>/` with folder = tag = suite, a lint for paths and tags, credentials from a gitignored file or CLI values.
4. **One script** that lints, installs fresh, bootstraps, runs suites in order with a login precondition, writes JUnit and debug output per suite, retries once, keeps going, cleans up. The same command locally and in CI.
5. **Boot headless** with pinned DNS, software GPU, no cameras, a `google_apis` image, animations off. Tell the team that no window is normal.
6. **CircleCI on the free plan**: the Android machine image, `decide → build → test → report`, the emulator as a background step, `parallelism` one container per suite, status files so `report` always runs, draft PRs dropped by the workflow `when`, green suites pruned before upload.
7. **Keep the alternative ready** (GitHub Actions on hosted Linux with KVM and a cached AVD snapshot); the script makes the port a day.
8. **Make red readable**: JUnit on the PR, artifacts on failure only, a chat summary, a written flake policy.
9. **iOS with the same files**, platform differences in per-platform subflows only, and an honest decision about hosted macOS.
10. **Write the coverage plan, the team plan and two guides.** Then: one flow per PR.
