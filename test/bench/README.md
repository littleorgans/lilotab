Written by tm/generalist (GPT-6).

# Lilotab overlay benchmark

```sh
mise exec -- just bench
mise exec -- just bench --tabs 25 --runs 20
mise exec -- just bench compare test/bench/baseline.json .bench/runs/RUN/results.json
mise exec -- just bench ab BASE CANDIDATE
```

The defaults are 100 tabs and 20 pairs of cold and warm trials. The fixture needs three tabs to leave two destinations after filtering. The runner caps launches at 100 tabs. A further cold and warm pair captures CPU and renderer traces outside the latency statistics.

The recipe uses `just build-timing` and the pinned Chrome for Testing and loopback fixture from `test/chrome/`. It needs an absolute `TMPDIR` and either Linux `flock` or macOS `lockf` with file descriptor support. First use downloads the pinned browser, while the workload loads pages solely from the fixture server.

The runner holds a file lock on `lilotab-bench.lock.guard` through Chrome shutdown and publishes its PID in `lilotab-bench.lock`. The guard file stays in place so waiters share one inode. A waiter checks once a minute for up to 30 minutes and can replace a reservation whose owner PID is gone. An older lock directory has no PID and stays reserved until it is removed. Chrome uses a disposable profile under `TMPDIR`.

Standalone and A/B use the same fresh browser profile for each cold and warm pair. An unmeasured toolbar action grants the source tab access during setup. The probe requests Search tabs from the active source tab's extension isolated world with `chrome.runtime.sendMessage`. In the timing build, `registerEntry` calls the registered `chrome.commands.onCommand` callback with `search-tabs` and Chrome's sender tab. A cold trial closes and detaches the setup worker through CDP and verifies that the new worker's clock starts after the request. The warm trial uses that same new worker. Cold samples include the request to worker time origin and time origin to command entry as diagnostics. Each trial reloads the source document. The visible list starts with all rows, then the harness sends A, L, P, H, three Down presses and Enter. The runner checks each list and highlight before sending the next key, verifies the active destination and checks the existing gesture timing record.

The headless benchmarks pass `--disable-frame-rate-limit`, `--disable-gpu-vsync` and `--run-all-compositor-stages-before-draw`. A DOM update schedules an animation callback, which posts a `MessageChannel` task. The frame marker is recorded in that task after the renderer turn. This captures style, layout and Paint deferred out of the update task without waiting for a second frame tick. Open spans use this same endpoint after initial list render. Each search and move starts at trusted keydown in window capture. The switch boundary is Chrome's `tabs.onActivated` event. Native shortcut and hardware key latency, real display presentation, OS focus and the hold dwell path remain unmeasured in the search trials.

Each run writes `results.json`, `summary.md`, `cold.trace.json` and `warm.trace.json` under the ignored `.bench/runs/` directory. The JSON includes the measured commit, the tracked tree's dirty flag, logical CPU count and the 1, 5 and 15 minute system load averages for each trial. The median averages the middle values for an even sample count. p95 uses nearest rank. Worker wake and open to first frame are reported separately by boot condition. The other rows pool both conditions. The tab query measures `liveFacts` through its populated windows read and conversion. Summaries and traces retain the keydown to DOM spans for diagnosis. `compare` uses the keydown to frame spans and expects current results. Trace summaries record the wait from DOM update to animation callback and the completed renderer events from DOM update to frame marker. The frame entries are ordered as initial render followed by the input sequence. Chrome browser and compositor work outside those JavaScript threads is visible in the trace.

## Shortcut tap

```sh
mise exec -- just bench tap --tabs 100 --padding 400
```

The tap probe compares zero padding with the given number of synthetic rows. It runs the 0, 30, 60, 120 and 250 ms keyup cases on a live target in the source window, plus a case that holds injection until the page records a trusted Meta keyup. `--delays` accepts a comma separated list in milliseconds. The four activation controls send Meta keyup after the overlay shows and use live and discarded targets in the same window and a second window. The second window takes two existing tabs, and the worker callback seeds the inactive target's recency before measurement. The headless fixture supplies the Command+E binding.

The timing build and browser are disposable under `TMPDIR`. Each invocation uses one fresh profile and the same Chrome launch switches as the search probe. The runner waits for the shared bench lock up to 30 minutes and writes results under `.bench/tap/`. Results include a load sample per case, the worker's timer events and timestamps for the visible list update, listener installation, trusted keyup, release post, overlay cut and removal, tab activation, focus request and final API result. Native shortcuts, hardware key release and macOS window raising are unverified.

## Synthetic scale

```sh
mise exec -- just bench scale
mise exec -- just bench scale compare test/bench/scale-baseline.json .bench/scale/RUN/results.json
mise exec -- just bench scale ab BASE CANDIDATE
```

The scale probe shares the bench lock. It writes each run's results, samples, Markdown summary and two CPU traces to `.bench/scale/`. The committed scale baseline includes the aggregate results and trace summaries.

Node measures 100 rows in 1 window, 1,000 in 10 and 3,000 in 30. The fixtures have mixed title and address matches, shuffled recency, and unique favicon keys. Message sizes are compact UTF-8 JSON. Start and Arrow Down encode, decode and validation costs are separate. The arrow has the full, unfiltered result set. Search timing rebuilds candidates and ranks each successive prefix. Favicon delivery uses the real adapter with in-memory PNGs supplied in place of cache reads. Synthetic patch entries are about 2.3 KB each.

The first two sizes also run in one headless Chrome tab. The fixture bundles the real overlay in timing mode for its existing marks and keeps minification disabled for readable CPU samples. Its local runtime adapter sends core-generated messages and checks trusted Arrow Down, A, L, P and H input. Each trial mounts a fresh overlay, moves three times through the full list, types the four filters, then applies the favicon patch. Each search and arrow has a DOM span and a frame span. The patch span includes validation and image assignment through the DOM update. The fixture checks image decode after the timed span. Counts include the connected list rows and the elements inside the closed shadow root. Browser launch and the setup that supplies synthetic data are outside the stage timings.

## Interleaved comparisons

`ab` archives each commit into its own temporary tree, installs its locked dependencies and builds there. Both sides use the same probes and pinned Chrome settings. The regular bench accepts `--tabs` and `--runs` after the refs. It launches one fresh headless profile per side's cold and warm pair and verifies shutdown before the next launch. Scale alternates individual Node and Chrome trials within each size and environment, with one headless profile and tab per Chrome arm.

Each block runs both sides in random order. The JSON under `.bench/ab/` or `.bench/scale-ab/` records block order, both sets of samples and load before each measured trial. Scale A/B also takes separate Chrome traces for both arms at each size. The comparison shows both medians and p95s, plus paired bootstrap intervals from 2,000 resamples of whole blocks. Use `just bench ab HEAD HEAD` to measure the noise with identical builds.

For a search or selection change, the keep rule uses the input to frame rows. A target median needs at least a 5% and 0.30 ms gain, with its bootstrap interval entirely below zero. Each other scored stage must hold its median and p95 within the guardrail, which flags a regression above both 10% and 0.50 ms. The A/B table marks eligible target gains, guardrail regressions and the diagnostic DOM rows.
