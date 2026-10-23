# aibuddy handover

State as of **2026-10-22**, written by Jacky for whoever takes the project over.
It covers what the code and the plan documents do not say: how things are
deployed, which board is which, and the traps that already cost time. Read
`README.md` first for what the components are and how to run them.

Where a section says "verify", the fact was true on that date but drifts
(IP addresses, which build a board runs, what the host has pulled).

## 1. Snapshot

- **Product:** a Cantonese AI companion plush on the Spotpear AI Toy board
  (ESP32-C3), a Next.js web app (wrapped later in a native WebView shell) and a
  FastAPI/pipecat voice server, on self-hosted Supabase.
- **Launch target:** mass production complete and leaving the factory on
  **2027-01-15**. Three white-label brands: A HKJC 快活 (2,500), B 政協青年聯會
  (500), C our own AI Buddy (after 1/15). Plan: `docs/roadmap.md`.
- **Owners:** Jacky holds software (firmware, web, voice server, admin,
  deployment). Design, characters/content, the native app shell and store
  submission are **待定 (unassigned)**, and so is the coordinator for the
  factory, Spotpear, test lab and clients. See the PEOPLE table in
  `docs/roadmap/plan.py`.
- **Not deployed yet:** `dev` holds everything since `mygithub/main` (e488c0a;
  list it with `git log mygithub/main..dev`): firmware 1.1.0 with the install
  prompt, low-battery-safe OTA, the Wi-Fi reconnect change, battery
  charging/full, Online/Asleep/Offline presence and crash reports. At the owner's
  request it all goes out together with the next release (see §3). The runbook
  already covers its migrations up to 20261022120000.

## 2. Repositories and branches

### Remotes: the obvious one is wrong

| remote | repo | use |
|---|---|---|
| `mygithub` | jackylee-cpu/aibuddy | **the real repo; push here** |
| `origin` | jackylee-cpu/ElatoAI | a different repo. `git push origin main` looks plausible and goes to the wrong place |
| `upstream` | akdeb/elatoai | the open-source project this was forked from |

- Work happens on `dev`, which has no upstream. `main` is kept a strict
  ancestor, so deploying is `git push mygithub dev:main` (a fast-forward).
  Pushing `dev` to `mygithub/dev` deploys nothing.
- Feature work: one branch plus one git worktree per task (`../aibuddy-<task>`),
  rebased onto `dev`, then merged.
- Docs-only commits trigger no image build.

### Branches not merged into `dev`

Cleaned up on 2026-10-22: every finished branch is merged into `dev` and
deleted, with its worktree. These are the only ones left. **They exist only on
the dev Mac** (not pushed, by the owner's choice), so hand them over with the
machine or push them before it goes.

| branch | worktree | what it is | next step |
|---|---|---|---|
| `r-25-brand-themes` | `../aibuddy-brands` | runtime brand themes (`BRAND` env, `brands/<key>/brand.json`); hkjc follows the Figma design | was held until the final designs arrive; merge then |
| `tool-call-rag` | `../aibuddy-tools` | R-42/R-43: set_volume, end_conversation and search_knowledge (BM25 KB). Merges into `dev` without conflicts; 330 tests pass | held by decision (2026-10-23) until 20 real-voice turns on the dev board pass, then merge. The KB is on only when `KNOWLEDGE_BASE_FILE` is set, but volume and end-conversation have no switch: once merged, every board session gets them in the next release |
| `r-21-ble-provisioning` | `../aibuddy-r21` | BLE provisioning probe (`spotpear-ai-toy-bleprobe`), 4MB app table | must be in the 11/27 factory image; not finished |
| `p0-07-rotate-secrets` | `../aibuddy-p007` | secret rotation runbook | release it after the handover (§4) |
| `debug-1.0.1-iwdt` | — | 1.0.1 with crash crumbs and heap logging, for the C3 TLS / interrupt-watchdog hunt | debug only; never release |

Two more worktrees under `.claude/worktrees/` belong to finished desktop-app
sessions. Their branches are merged; archiving those sessions removes them.

On `mygithub` only `main` is left. The old merged branches
(fix/barge-in-interruption, lock-character-writes, modes-and-ips) were deleted.

## 3. Environments and deployment

### What runs where

- **Host:** one server (`aibuddy-dev`), reached through Cloudflare at
  `https://elatoai.hkqft.com`. There is no key-based SSH from the dev Mac; the
  owner runs commands on the host.
- **Today's stack is the UAT** until the per-brand stacks exist. It will later
  become brand C (AI Buddy). HKJC and 政協青年聯會 each get their own stack:
  their own Supabase, web and voice server, from the same images with config-only
  differences (§3.4).
- **Supabase is self-hosted** (official docker stack in `~/supabase-selfhost`),
  mounted under a path: `NEXT_PUBLIC_SUPABASE_URL` is
  `https://elatoai.hkqft.com/supabase-api`. Code that keeps only the host of that
  URL works locally (`http://127.0.0.1:54321`) and breaks in the cloud.
- **Check what is running** on the host:
  `docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' <container>`.
  On 2026-10-16 UAT ran 63f3b06; `mygithub/main` is now e488c0a. Verify.

### Release flow

1. Push `dev` to `mygithub/main`. `.github/workflows/ghcr-fastapi.yml` and
   `ghcr-frontend.yml` build images to GHCR. A push touching
   `supabase/migrations/**` rebuilds both. `supabase-migrate.yml` is written for
   hosted Supabase. Here it skips with a yellow warning, and that is expected.
2. **The push does not deploy.** On the host: `cd ~/aibuddy && git pull origin main`
   (the server checkout's remote is `origin`, and it asks for a GitHub username
   and PAT), then run the release runbook.
3. Current runbook: `RELEASE=<sha> bash docs/deploy/release-2026-10-14-audit-usage.sh`.
   It can be re-run. It applies the migrations in order, adds the missing env vars
   (DEVICE_CLAIM_LIST, DEVICE_VOICE_URL, DEVICE_BACKEND_URL), sets nginx's
   16 MB upload limit, pulls the images and runs checks. Pull first, so that the
   host has the latest runbook.
4. Any release that adds a migration or an env var must extend the runbook and
   rehearse it (§5.2).

Containers: `fastapi-fastapi-1` (compose `docker-compose.ghcr.yml`, service
`fastapi`) and the frontend (`frontend-nextjs/docker-compose.ghcr.yml`, service
`frontend`, env `.env.production`). Inside the network the voice server is
`http://fastapi-fastapi-1:7860`. That is the container name, not the service name.

### Migrations on self-hosted Supabase

- `supabase link`, `supabase db push` and the GitHub migrate job **do not apply**.
  The DB has no `schema_migrations` history, and the base migration is not
  idempotent, so `db push` would fail.
- Apply a migration on the host:
  `docker exec -i supabase-db psql -X -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < supabase/migrations/<file>.sql`.
  `-1` makes the file one transaction, so a failure rolls back cleanly.
- Order matters even for "additive" files. For example, `firmware_releases` needs
  `has_role()` from 20261007180000.
- New migrations should be re-runnable: put `DROP POLICY IF EXISTS` before every
  `CREATE POLICY`.
- To check what prod has without SSH, call the public REST API with the anon key
  (it is in the `/login` JS bundle). A missing column answers 42703, a column the
  anon role can't read answers 42501, a missing RPC answers PGRST202.

### Per-brand stacks (decided, not built)

- One codebase, deployed three times. Brands differ only in env vars, the brand
  pack (`brands/<key>/`) and DB content. There are no brand branches and no
  `if brand == …` in code.
- Each stack has its own secrets, including `DEVICE_JWT_SECRET` and its own AI
  vendor keys. Never add a cross-brand table.
- Releases go to AI Buddy first and to the other two a day later.
- Firmware must read its server host from NVS, written by the factory station
  (R-35), because no OTA can run before a unit's first connection.

## 4. Secrets and accounts to transfer

None of these values belong in git. Hand them over in person, then **rotate
them** (`p0-07-rotate-secrets`).

| what | where it lives |
|---|---|
| host login, Cloudflare, domain `hkqft.com` | owner's accounts |
| GitHub `jackylee-cpu/aibuddy` (code, GHCR images, Actions secrets incl. the baked `NEXT_PUBLIC_SUPABASE_URL`) | GitHub |
| Supabase service key, JWT secret, `POSTGRES_PASSWORD` | host: `~/supabase-selfhost/.env`, `~/aibuddy/frontend-nextjs/.env.production`. The service key is **not** on the dev Mac |
| `DEVICE_JWT_SECRET`, `INTERNAL_API_TOKEN` | both server envs; **must be identical** in the web and voice envs, or the web returns 500s and every device is refused |
| OpenRouter, Azure STT, MiniMax/Azure TTS keys | `server/fastapi/.env` (dev Mac), host env |
| Google OAuth client, Apple/Google developer accounts (one per brand, needs D-U-N-S) | owner / clients; not created yet for all brands |
| Figma file (Haivivi-App, page "AI Buddy App UI v1") | Figma team |

Local files to clean up: `frontend-nextjs/.env.local.bak-admin`, `.bak-p006` and
`.bak-p017` are old copies holding secrets.

The OpenRouter key refuses all OpenAI, Google and Anthropic models (HTTP 403
"violation of provider Terms Of Service"). DeepSeek, Qwen, Kimi, Mistral, Llama,
MiniMax and Gemma work.

## 5. Local development

### Running it

- **Voice server:** use the venv at `server/fastapi/.venv`, not a system or
  conda Python. pipecat is pinned `<1.8` (1.8 renames the TaskManager API).
  Tests: `.venv/bin/python -m pytest -q`.
- `bot.py` calls `load_dotenv(override=True)`, so `.env`'s `PORT=7860` beats the
  environment. Start a second instance with
  `.venv/bin/python -m uvicorn server:app --port <N>`.
- The local env points at the **local** Supabase. Without a real
  `SUPABASE_SERVICE_ROLE_KEY`, every lookup fails open and memory silently stays
  off. The startup line "provider stack validated" only checks that keys are
  present.
- **Web:** `frontend-nextjs`, next 14.2.7 pinned by the lockfile (package.json
  says "latest", so `npx next` without a local install pulls next 16). The dev
  board's builds expect the web app on port 52727 and the voice server on 7860.
- **Two `next dev` servers in one folder corrupt `.next`.** Every route then
  404s and the log shows `Caching failed for pack … rename`. Run one per checkout.
- `next build` fetches Google Fonts. A network blip fails the build with a wall of
  webpack errors; re-run it.
- Don't symlink `node_modules` into a copy that builds with
  `output: "standalone"`: the second build's clean followed the symlink and
  emptied the real `node_modules`. Fix with `npm ci`.

### Local Supabase and migration checks

- The dev Mac's own stack runs in Docker; its DB container is `supabase_db_ElatoAI`.
  No `psql` or `supabase` CLI is on the host, so go through `docker exec`.
- **Check a migration without changing anything:**
  `{ echo BEGIN; cat <file>.sql; echo ROLLBACK; } | docker exec -i supabase_db_ElatoAI psql -U postgres -d postgres -v ON_ERROR_STOP=1`.
  Concatenate the file twice to prove it can be re-run.
- **Rehearse a release from prod's schema:** run a throwaway
  `public.ecr.aws/supabase/postgres:15.8.1.085` container, add the `auth.*`
  helper functions and storage columns it lacks, apply `git show <prod sha>:<file>`
  in name order, then point the runbook at it with `DB=relcheck-db REPO=<dir>`.
- **RLS tests:** the local `.env.local` anon key is actually a `sb_secret_` key,
  so the local web app bypasses RLS and a UI check proves nothing. The real
  publishable key is in the kong container's `/home/kong/kong.yml`. Self-signed
  JWTs are rejected (PGRST301), so count only `42501` as a denial and get user
  tokens from the local GoTrue.
- `supabase db reset` wipes the dev board's local `devices` row; re-claim it after.

### Testing without a board

`server/fastapi/scripts/simulate_device.py --target local --mac … --token …`. Mint
the token with `DEVICE_JWT_SECRET` (HS256, `aud=aibuddy-device`, `typ=device`,
`sub=<device_id>`, `mac`) for a throwaway claimed device row, and delete the row
afterwards.

## 6. Firmware

Arduino on ESP32 (Arduino core 2.0.17, platform espressif32 6.10.0), in
`firmware-arduino/`. Board facts and pin tables: `firmware-arduino/BOARDS.md`.

### Build environments

| env | use |
|---|---|
| `spotpear-ai-toy` | production/cloud build (wss to `elatoai.hkqft.com`) |
| `spotpear-ai-toy-localall` | dev board: websocket **and** web API point at the Mac. Set `AIBUDDY_DEV_WS_HOST`, `AIBUDDY_DEV_WS_PORT`, `AIBUDDY_DEV_BACKEND_PORT` |
| `spotpear-ai-toy-localws` | only the voice websocket goes to the Mac (older) |
| `*-audiotest` | codec self-test; flash first when bringing up a new audio board |
| `xmini-c3`, `waveshare-s3-audio`, `esp32-s3-devkitc-1` | other boards (reference / fallback) |

- `PLATFORMIO_BUILD_FLAGS` appends, and a later `-D` wins, so constants can be
  overridden without editing the repo (`-DFIRMWARE_VERSION=\"x.y.z\"`,
  `-DIDLE_SLEEP_SECONDS=0`, …).
- PlatformIO wipes `.pio/build` when build env vars change, so copy each
  `firmware.bin` out before building the next variant.
- **Check `firmware.bin` against the partition size, not pio's percentage.** An
  image 50KB over the 2MB slot boot-looped silently while pio said "Flash 99%,
  SUCCESS".

### Partition tables: the biggest trap

- `spotpear-ai-toy` now builds with **`partition_16m.csv`** (4MB app slots, a 2MB
  assets partition at 0x810000 for brand sounds, coredump). That is the
  production table for the factory image.
- **Every board already in the field (all cloud boards) still has the old
  `partition.csv` (2MB app slots).** OTA can never change the partition table. So:
  - Every OTA image for those boards must stay **under 2MB**.
  - They have no assets partition, so no Wi-Fi voice prompts. That is safe:
    "Assets: none", and the built-in sounds play.
  - Moving a board to the new table needs a USB `pio -t upload`. NVS and otadata
    offsets don't change, so Wi-Fi and the device secret survive. Before any USB
    flash, set the matching release to current in prod (0% is enough), or the
    server will "update" the board back to the old version.

### OTA

- Boards report `firmware: {board, version, failed_version?}` in
  `/api/generate_auth_token`; the 200 reply carries `ota`. The board installs the
  current `firmware_releases` row for its board.
- **Publishing:** admin page `/admin#ota` (super admin) accepts the `.bin`.
  Images carry `aibuddy-build;kind=release;board=…;version=…;`, and dev builds are
  refused. The same version cannot be uploaded twice. Rollout: whitelist one
  board, then 10% / 50% / 100%. (`firmware-arduino/tools/release_firmware.py`
  is the older CLI path and needs the service key.)
- **Probation:** a new image is confirmed only after it has stayed up 120s past
  server auth. Any reset before that, including idle sleep's restart, a
  ServerReach restart or a flat battery, rolls back. After 2 lost installs the
  board reports the version as failed.
- **Auto-pause:** at least 2 counted rollbacks **and** more than 5% of the stage.
  Power-loss installs (`failed_reason=lost_installs`) are ignored. This needs
  migration 20261022120000 and firmware after 1.1.0; older boards send no reason.
- **Local OTA also downgrades:** it offers `is_current` whenever the version
  differs. Label dev test builds exactly the local `is_current` version.
- Crash-loop fallback: 3 crash resets in a row switch to the other slot.

**Current OTA state (verify in `/admin#ota`):**
- Prod release **1.1.0 is auto-paused** since 2026-10-16. Its only stage board,
  AIBuddy-16C0, rolled back. The root cause was its battery dying during the
  install, not the firmware. A USB repro of 1.1.0 on 42:34 against prod ran clean.
- Prod's 1.1.0 is the 67a3f9f build **without** the 「系統更新中，請稍候。」
  install prompt (c74d039). Next release: build **1.1.1** from `dev`. It carries the
  prompt and the low-battery-safe install. Clear `devices.ota_failed_version` for
  16C0 if it should be offered again.

### Network, TLS and audio behaviour worth knowing

- **C3 heap fragmentation:** TLS needs two ~17KB contiguous blocks. Shipped 1.0.1
  could fail every wss connect with 65KB free but a 28KB largest block. Any change
  must leave room for them after audio init and the auth HTTPS call. Arduino's
  mbedtls has no dynamic-buffer option.
- **Reconnect and recovery (P2-25):**
  - The TLS handshake is capped at 15s (`src/TlsTimeout.cpp`).
  - No server for 60s: Wi-Fi resets. 180s: one silent restart.
  - LED colours:
    - cyan blink: on Wi-Fi, no server yet
    - yellow: internet is fine, our server is down
    - magenta: setup AP is open
  - An outage on our side must never tell parents to redo their Wi-Fi.
- **Wi-Fi reconnect (70b3ea4 on `dev`, tested on the dev board 2026-10-22):**
  - It waits 60s before opening the setup AP.
  - The AP runs as AP+STA and keeps scanning. It has no timeout.
  - Joins back off from 15s, doubling up to 300s.
  - The last-joined SSID wins at -70 dBm or stronger.
  - Off every saved network, it looks again after 10s, doubling up to 300s; a
    BOOT press starts over at 10s.
  - Idle sleep also applies while the AP is only looking, so a long outage
    doesn't drain the cell.
  - Test hook: `-DWIFI_TEST_SKIP_SSID`.
  - It was modelled on xiaozhi's `esp-wifi-connect`.
- **Uplink:** mic audio was raw 16kHz PCM (256 kbps). P2-24 adds IMA ADPCM
  (`X-Mic-Codec: ima-adpcm`; the server keeps accepting PCM). Opus encode costs
  ≥49% CPU on the C3, so don't use it there.
- **Live settings:** 1.0.1 ignores `{"type":"volume"}` but applies a second
  `auth` frame at once. No `X-Firmware-Version` header means 1.0.1 or older.
  `RESPONSE.COMPLETE` arrives after the audio finishes (up to 16s late), so never
  carry state on it.
- **Shipped-firmware traps the server works around:**
  - `SESSION.END` flushes the speaker at once, so it is sent 1.5s after the bot
    stops.
  - Audio is dropped for 1s after `RESPONSE.COMPLETE`, so it is held until a tool
    answer arrives.
- **Codec boards fail silently.** With a wrong sample rate the ES8311/ES7210 are
  never configured, yet every log looks normal. A wrong clock register only adds
  hiss. Diff register sequences against Espressif's `esp_codec_dev`.
- **Battery on Spotpear:** the board cannot measure the cell (no divider, CHRG goes
  only to an LED). The low-battery reminder comes from VDD sag on GPIO0
  (`SupplyMonitor.cpp`): below 95.5% of the first reading, it says
  「電量不足，請充電。」. A real percentage needs a PCB revision: V_BAT divider to
  GPIO1 (R-16). The only firmware-readable key is BOOT (GPIO9); K1 is a hardware
  power latch; there is no reset button.

## 7. Boards inventory

Several Spotpear units look identical. **Always read the MAC first**
(`esptool.py read_mac`) before trusting which board is plugged in.

| MAC (short) | board | role | firmware (2026-10-22) |
|---|---|---|---|
| f8:5b:1b:53:**62:70** (AIBuddy-6270) | Spotpear | **permanent local dev board**, keep it on `-localall`, never flash it to cloud | dev 630eee2 + Wi-Fi reconnect, labelled 1.8.4, baked Mac IP 10.6.1.127, WS 7860 / web 52727, `partition_16m.csv` |
| f8:5b:1b:53:**42:34** | Spotpear | cloud | 1.1.0 (c74d039 build) in app0 by USB, 1.0.1 in app1; old table |
| f8:5b:1b:51:**16:c0** (AIBuddy-16C0) | Spotpear | cloud; **never use for local tests** | 1.1.0 (c74d039) in app1 by USB, 1.0.1 in app0; prod has `ota_failed_version=1.1.0` |
| f8:5b:1b:53:**63:64** | Spotpear | cloud (ex-dev board) | 1.0.1 |
| f8:5b:1b:51:**2b:84** | Spotpear | cloud | 1.0.1 |
| ac:27:6e:eb:dd:4c | xiaozhi xmini-c3 | reference: has a real battery divider (GPIO2) | stock xiaozhi 2.2.6 restored |
| e0:72:a1:f7:20:00 | ESP32-S3 DevKitC (breadboard) | early dev | old |
| a0:f2:62:e3:64:2c | Waveshare ESP32-S3-AUDIO | former fallback board | old |

- Stock flash backups, NVS dumps and the official Spotpear schematic
  (`Toy-AI-Core-C3-MINI.pdf`) are in `~/Desktop/小智備份/` on Jacky's Mac. **Copy
  that folder over in the handover.** It is not in git.
- A `-localall` board can only reach the Mac IP it was built with. When the Mac's
  IP changes, rebuild it. On this Mac `localhost:3001` resolves to IPv6, where
  another project listens, so use `127.0.0.1`.
- Office Wi-Fi "HKQF - Guest" reaches the Mac; an iPhone hotspot does not.
- If the cloud answers 401 instead of 202 after a board's NVS was wiped, delete
  that MAC's `device_secrets` row (trust on first use).

## 8. Flashing and recovery

- **Spotpear (C3):**
  - It enumerates as `/dev/cu.usbmodem*`; the number follows the USB port.
  - Erase before the first flash.
  - Opening the serial port resets the board (`rst:0x15`), so every capture is a
    boot capture.
  - In idle light sleep it ignores esptool and DTR/RTS; press BOOT.
  - After esptool's hard reset it sits in download mode. Replug it, or pulse RTS
    with pyserial (`dtr=False, rts=True`, 0.1s, `rts=False`).
- **Vanished from USB?**
  1. Is the power switch on?
  2. Is it a flat cell? The board runs from the cell even on USB. A flat cell can
     take 5–35 min to enumerate, and a write can die halfway. Charge it, hold BOOT
     while replugging, then rewrite only the app with
     `esptool.py write_flash 0x10000 firmware.bin`.
  3. Is it a charge-only cable?
- Only one process may hold the port. A forgotten monitor makes `pio -t upload`
  fail with `[upload] Error 1` (`lsof /dev/cu.usbmodem*`).
- Full 16MB reads drop off USB on long transfers. Back up only NVS and otadata
  (`read_flash 0x9000 0x7000`), and restore the app from the release `.bin`.
- **Waveshare S3:** use `--no-stub` for large writes (the stub dies on the 1.4MB
  app). Replug to leave the bootloader.
- macOS has no `timeout` command, which silently breaks capture scripts. A capture
  reader must reconnect, because the port name changes across resets.

## 9. Voice, memory and content

- **Voice LLM:** `google/gemma-4-26b-a4b-it` (65/66 in the R-02 Cantonese child
  check) or `deepseek/deepseek-v4-flash` (61/66). `minimax/minimax-m2.7` fails:
  it writes simplified characters and emoji.
  - OpenRouter routing sends `provider.order` with `allow_fallbacks:false`.
    Without it, a rate-limited host falls back to bad hosts.
  - Recommended host order: azure, alibaba, novita, siliconflow, gmicloud.
  - `llm_output_guard.py` strips control tokens.
  - pipecat's OpenRouter service sends the greeting as a **user** message. A test
    harness must do the same.
  - Re-run a spot check before switching models.
- **Memory:**
  - One LLM call every 6 turns and at session end
    (`memory/summarise.py:consolidate`) writes a summary to `memory_segments` and
    facts to `memory_facts`. Active facts (max 40) go into every system prompt.
  - Memory is **per device**: key `(user_id, device_id, ip_key)`.
  - `devices.memories_revision` plus a trigger stop late writes after a clear.
  - The web playground has no memory.
  - VoiceMem was removed on 2026-09-24; don't bring it back.
  - Eval harness: `server/fastapi/evals/beam` (100K: prod 0.33). Fact replacement
    almost never fires.
- **IPs:** an IP is a physical toy's identity. `devices.ip_key` locks a board to
  its plush (set by a super admin, later by the factory station). A locked board
  never speaks as another toy.
- **Knowledge base (HKJC 快活, on `tool-call-rag`):**
  - BM25 over a YAML file set by `KNOWLEDGE_BASE_FILE`.
  - Content comes in through `docs/knowledge/快活知識庫_範本.xlsx` and
    `server/fastapi/scripts/knowledge_excel.py`.
  - A KB miss returns a fixed sentence (the model invents facts otherwise).
  - Betting tips are refused 100% of the time.
  - Target: 80% on the 100-question test set.
  - The reranker reaches 88% retrieval but costs 1.6s.
  - `MIN_SCORE` must be re-measured on the real HKJC corpus.
  - Keep gemma for 快活: DeepSeek invents answers on partial hits.
  - Eval: `server/fastapi/.venv/bin/python -m evals.voice_tools.eval`.
  - The `experiments/` folder (incl. `kb_tools_mvp`) is gitignored, so it isn't in
    the repo.
- **Device auth:**
  - A board gets a random device secret (in NVS) on first contact, then a 24h
    device token once claimed (202 + pairing while unclaimed).
  - Browsers get a 5-minute web voice token.
  - Both are signed with `DEVICE_JWT_SECRET`, so web, voice server and firmware
    must ship together.
- **Binding (planned):** Bluetooth provisioning in the native app with a one-time
  bind ticket (`POST /api/device_bind_ticket`); one account per device; unbind
  before transfer. The SoftAP page stays for dev/ops only. Still open: HKJC member
  binding (own accounts vs HKJC SSO, Q12) and BLE PoP.

## 10. Plans, trackers and open items

| file | what | how to edit |
|---|---|---|
| `docs/production-readiness.xlsx` | every task (P0 security, P1 child safety, P2 engineering, R product) with status and **test evidence** | only via `.claude/skills/prod-readiness/scripts/tracker.py`; a task is done only when its test passed |
| `docs/roadmap.md`, `docs/roadmap/roadmap.html`, `docs/毛公仔打版與量產時間表_草案v0.6.xlsx` | the plan and the toy-factory timeline | **generated**: edit `docs/roadmap/plan.py`, then `python3 docs/roadmap/build.py` |
| `docs/project-schedule.xlsx` | weekly milestones and Jacky's dev/test items | **hand-maintained in Excel; never regenerate** |
| `docs/原生App殼接口文檔_v0.2.xlsx` | interface spec for the native shell (bridge, BLE, login, push) | generated by `docs/app-shell/build_xlsx.py` |
| `docs/deploy/*.sh` | release runbooks | one per release; the latest is the one to run |

Open items that block the 1/15 launch (details in the tracker):
- **Unassigned roles:** design (three UI sets, characters, store art,
  packaging), the native shell and store submission, and the coordinator.
- **R-21** BLE provisioning plus **R-35** host-from-NVS, both needed in the
  **11/27** Spotpear factory image. Secure Boot / flash encryption eFuses are
  burned at Spotpear's first power-on, so that image must be final.
- **R-34** the HKJC and 政協青年聯會 stacks; **R-25** brand pages after the designs.
- **R-01 scorecard** still untested on Spotpear: a 2-hour conversation, heap during
  conversation, Secure Boot v2 + flash encryption, and price/lead time/FCC/CE.
- **R-37** web Wi-Fi management: real-network tests ①② and the OTA rollout.
- Next OTA (1.1.1) and resuming the paused rollout (§6.3).
- Barge-in: about 1 in 3 interrupted turns used to lose their first audio (STT
  still muted). Re-measure before quoting it.
- Memory: turns still queued when the server restarts are not replayed.
