<p align="center">
  <img src="assets/colibri.svg" width="500" alt="colibrì — tiny engine, immense model">
</p>

# KingIcyCreamProjects/colibri

**A Windows-native fork of [colibrì](https://github.com/JustVugg/colibri), focused on consumer hardware** — a Ryzen 9 9950X3D, an RTX 5090, and a Gen5 NVMe. Run **GLM-5.2 (744B-parameter MoE)** at int4 by streaming its experts from disk, in pure C, with zero runtime dependencies.

> **Be honest with yourself about what this is.** This is **disk-streaming, batch-style inference** — on a single consumer NVMe you are in the **~1–4 tok/s class**, not the tens-of-tokens class of a GPU-resident model. It answers *correctly*; it does not answer *instantly*. Treat it as a local batch engine for a frontier-class model, not a snappy interactive assistant.

```
$ ./coli chat
  🐦 colibrì v1.0 — GLM-5.2 · 744B MoE · int4 · streaming CPU
  ✓ ready in 32s · resident 9.9 GB
  › ciao!
  ◆ Ciao! 😊 Come posso aiutarti oggi?
```

## Contents

- [Forked from JustVugg/colibri](#forked-from-justvuggcolibri-apache-20)
- [The idea](#the-idea)
- [Windows quick start](#windows-quick-start)
- [Measured on this fork's reference box](#measured-on-this-forks-reference-box)
- [What's implemented](#whats-implemented)
- [Web dashboard & desktop](#web-dashboard--desktop)
- [Other platforms](#other-platforms)
- [Repo layout](#repo-layout)
- [License](#license)

## Forked from JustVugg/colibri (Apache 2.0)

This project is a fork of **[JustVugg/colibri](https://github.com/JustVugg/colibri)** by JustVugg, released under the Apache License 2.0. The original is a genuinely excellent piece of engineering — a single-file C engine that runs a 744B model on hummingbird rations — and all of the hard architectural work (streaming MoE, MLA compressed KV, the learning cache, the FP8→int4 converter) is theirs. Please go star the upstream repo.

**Change notice (Apache 2.0 §4(b)):** this fork carries local modifications to the original files. The focus is a first-class **native Windows 11 build path** (MSYS2 UCRT64, a runtime `coli_cuda.dll` loaded via `LoadLibrary`, an O_DIRECT twin mapped to `FILE_FLAG_NO_BUFFERING`) and consumer-hardware tuning for the 9950X3D + RTX 5090 + Gen5 NVMe reference box. The `LICENSE` file is unchanged.

## The idea

A 744B Mixture-of-Experts model activates only ~40B parameters per token — and only ~11 GB of those change from token to token (the routed experts). So colibrì treats VRAM, RAM, and storage as one managed memory hierarchy:

- the **dense part** (attention, shared experts, embeddings — ~17B params) stays **resident in RAM at int4** (~9.9 GB);
- the **19,456 routed experts** (75 MoE layers × 256 experts + the MTP head, ~19 MB each at int4) live **on disk** (~370 GB) and are **streamed on demand**, with a per-layer LRU cache, an optional pinned hot-store, and the OS page cache as a free L2.

Insufficient fast memory reduces *speed*, not precision: the default policy never silently changes quantization or router semantics. The engine is a single C file (`c/glm.c`) plus small headers — no BLAS, no Python at runtime, no GPU required (an opt-in CUDA tier for pinned experts exists).

## Windows quick start

Native Windows 11 x86-64, no WSL. All platform differences live in `c/compat.h` (POSIX I/O → Win32); the engine source is unchanged from upstream.

**1. Toolchain:** [MSYS2](https://www.msys2.org/) **UCRT64** shell with gcc + make (`pacman -S mingw-w64-ucrt-x86_64-gcc make`), and — for the GPU tier — **CUDA 13.3** + MSVC Build Tools (`cl.exe` + `nvcc` on PATH).

**2. Build the engine** (tuned for this CPU — the banner must confirm the kernel):

```bash
cd c
make glm CUDA_DLL=1 ARCH=native      # -> glm.exe; banner prints "idot: avx512-vnni"
```

`ARCH=native` enables the Zen5 `avx512-vnni` integer-dot kernel (the portable `x86-64-v3` default compiles it out). `CUDA_DLL=1` links the runtime loader so `glm.exe` uses `coli_cuda.dll` if present and falls back to CPU if not.

**3. Build the CUDA DLL** (from a shell with the MSVC env set, `sm_120` for Blackwell / RTX 50-series):

```bash
make cuda-dll CUDA_ARCH=sm_120
```

For the raw `nvcc` invocation this expands to (and the MSVC `-Xcompiler=-W3` reason), see [docs/tuning-9950x3d-5090.md](docs/tuning-9950x3d-5090.md).

**4. Download the model** — use the version with **int8 MTP heads** (`hf` CLI = `huggingface_hub`):

```bash
pip install -U huggingface_hub
hf download mateogrgic/GLM-5.2-colibri-int4-with-int8-mtp --local-dir C:\models\glm52_i4
```

The download is **~370 GB** and skips the FP8→int4 conversion entirely. **The MTP head must be int8** — int4 heads give 0% draft acceptance and speculation silently never engages ([#8](https://github.com/JustVugg/colibri/issues/8)). Verify the three head files:

```powershell
Get-ChildItem C:\models\glm52_i4\out-mtp-*      # int8 (correct): 3527131672 / 5366238584 / 1065950496
```

If you instead see `1765523544 / 2686077736 / 536747200`, those are int4 heads — replace just those three files from the int8 mirror.

**5. Run.** On Windows the `coli` launcher already applies the measured
lossless defaults automatically — `DIRECT=1` (unbuffered reads), `PIPE=1`
(load/matmul overlap, byte-identical output), `PILOT_REAL=1` (cross-layer
prefetch) and the OpenMP hot-team tuning — each overridable by setting the
variable yourself (e.g. `$env:DIRECT="0"`; `COLI_NO_OMP_TUNE=1` disables just
the OMP block):

```powershell
$env:MLOCK="1"                                # optional: wire the pinned tier into RAM
python coli chat --model C:\models\glm52_i4
```

To add the GPU tier on an RTX card (all measured on the reference box, see
[docs/tuning-9950x3d-5090.md](docs/tuning-9950x3d-5090.md)):
`$env:COLI_CUDA="1"; $env:COLI_GPU="0"; $env:CUDA_EXPERT_GB="24"; $env:REPIN="16"; $env:CUDA_DENSE="1"; $env:COLI_CUDA_ATTN="1"`.

Every engine knob is documented in [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md); the CLI/server flags in [docs/SETTINGS.md](docs/SETTINGS.md).

## Measured on this fork's reference box

Ryzen 9 9950X3D (avx512-vnni) · RTX 5090 (sm_120) · Samsung 9100 PRO Gen5 NVMe · native Windows 11 · CUDA 13.3. Full detail and build lines: **[docs/tuning-9950x3d-5090.md](docs/tuning-9950x3d-5090.md)**. Every number is a single-box engineering datapoint, not a portable guarantee.

| measurement | result |
|---|---|
| disk — `iobench` O_DIRECT (19 MB × 64, 8 threads) | **~10.7 GB/s** |
| CUDA fixture replay — CPU streaming (avx512-vnni) | 8–9 tok/s |
| CUDA fixture replay — hot experts pinned in VRAM | **152–162 tok/s** |
| real-model decode table | **pending** (370 GB download + tuning ladder) |

> The fixture is the deterministic **313M-parameter `glm_moe_dsa`** model with **random weights** — it preserves the real MLA/MoE/streaming shapes to isolate the CUDA hot-expert kernel, but it is **not a language model**. Those tok/s are fixed-token replay throughput, not real generation. Real-model decode is bounded by expert streaming from disk and is far lower — expect the ~1–4 tok/s class this box's ~10.7 GB/s drive implies.

### Upstream reference results

The upstream project maintains a community leaderboard of real-machine measurements (stock `setup.sh` build, greedy decoding, `--ngen 32`, MTP active). These are **upstream's numbers on other people's hardware**, kept here for context:

| machine | disk (iobench) | config | measured |
|---|---|---|---|
| Intel Core Ultra 7 270K Plus (24T) · WSL2 · 24 GB · NVMe VHDX ([#2](https://github.com/JustVugg/colibri/issues/2)) | 2.74 GB/s O_DIRECT | `--topp 0.7` | 0.11 tok/s · hit 11% |
| Apple M5 Max (18C) · macOS · 128 GB unified ([#4](https://github.com/JustVugg/colibri/issues/4)) | ~4 GB/s cold | default, MTP off | 1.06 tok/s · hit 23% |
| Apple M5 Max · **Metal backend** · 46.9 GB pin ([#103](https://github.com/JustVugg/colibri/issues/103)) | — | Metal (experts+attn) · MTP off | **2.06 tok/s** · hit 72.5% |
| Ryzen 9 9950X · Linux · 123 GB · Samsung 9100 PRO PCIe 5.0 ([#31](https://github.com/JustVugg/colibri/issues/31)) | 8.81 GB/s O_DIRECT | usage history retained | 0.28 tok/s · hit 57% · 57% matmul-bound |
| Ryzen 7 9800X3D (16T) · WSL2 · 70 GB · 9100 PRO PCIe 5.0 · RTX 5090 ([#101](https://github.com/JustVugg/colibri/issues/101)) | 10.51 GB/s O_DIRECT | MTP off · learned pin 24 GB · `--topp 0.7` | **0.52 tok/s** · disk-bound (CUDA tier ≈ 0% — AVX-512 CPU matches the 5090) |
| Ryzen 9 9950X3D (16C/32T, avx512-vnni) · Linux · 121 GB · 9100 PRO Gen5 · RTX 5090 ([#120](https://github.com/JustVugg/colibri/issues/120)) | 11.48 GB/s O_DIRECT | `MTP=0 DIRECT=1 PIPE_WORKERS=16 PREFETCH=1` | **1.23 tok/s** · fastest x86 datapoint |
| Intel i5-12600K (10C/16T) · **native Windows 11, no WSL** · 32 GB · MinGW ([#113](https://github.com/JustVugg/colibri/issues/113)) | buffered | int8 MTP head · cold, small-RAM | 0.08 tok/s · **MTP 57% acceptance** — port validated |
| Dell Pro Max GB10 (DGX Spark, aarch64 i8mm/sve2) · Linux · 121 GB unified ([#136](https://github.com/JustVugg/colibri/issues/136)) | 5.58 GB/s O_DIRECT | int8 MTP head · warm | 0.21 cold → **0.50 tok/s** warm · matmul-bound |

Also see upstream's [GLM-5.2 on 6× RTX 5090](docs/experiments/glm52-6x5090-2026-07-12.md) experiment (full expert residency across VRAM+RAM reaches 6.84 tok/s single-request decode).

**The takeaways** that survive across all of these: on small-RAM machines the **RAM cap, not the disk, is the binding constraint** (the engine auto-caps the expert cache from `MemAvailable`); `--topp 0.7` reliably buys ~1.6× end-to-end by reducing expert disk reads (a lossy expert-routing knob, [see below](#a-note-on-lossy-speed)); and the **GPU expert tier earns its VRAM only when the CPU is the weak link** — on an AVX-512/VNNI CPU the disk stays the bottleneck and the 5090 buys ≈ 0%.

## What's implemented

- **Faithful GLM-5.2 (`glm_moe_dsa`) forward** — validated token-exact against a `transformers` oracle (teacher-forcing 32/32, greedy 20/20 on a tiny-random model with the real architecture).
- **MLA attention** (q/kv-LoRA, interleaved partial RoPE) with a **compressed KV-cache**: 576 floats/token instead of 32,768 (57× smaller — GLM-5.2 has 64 heads and no GQA).
- **Streaming MoE** — DeepSeek-V3-style sigmoid router; the 19,456 routed experts stream from disk with a per-layer LRU cache, async readahead (`WILLNEED`), an optional pinned hot-store, and the OS page cache as a free L2.
- **Native MTP speculative decoding** — GLM-5.2's own multi-token-prediction head drafts tokens the main model verifies in one batched forward. **The head must be int8**; at int8 it's 39–59% acceptance, 2.2–2.8 tokens/forward ([#8](https://github.com/JustVugg/colibri/issues/8)). Lossless in exact arithmetic but not byte-identical to non-speculative greedy in practice ([#100](https://github.com/JustVugg/colibri/issues/100)); `DRAFT=0` forces exact decode.
- **Integer-dot kernels** — Q8_0-style int8 activations; on this box's Zen5 the `avx512-vnni` kernel is selected by `ARCH=native`. `IDOT=0` returns the exact f32 path for A/B checks.
- **Grammar / JSON-Schema forced drafts** (`GRAMMAR=file.gbnf` or `SCHEMA=file.json`, [#48](https://github.com/JustVugg/colibri/issues/48)) — for constrained output (JSON/NDJSON, function calling), forced single-legal-byte spans are injected as pre-accepted drafts; it never constrains sampling, so a wrong grammar can only cost rejected drafts. Full reference: [docs/grammar-draft.md](docs/grammar-draft.md).
- **The learning cache** — the engine records which experts your usage routes to (`.coli_usage`, updated every turn) and auto-pins the hottest ones in spare RAM at startup. It literally gets faster the more you use it.
- **KV-cache persistence** — `coli chat` appends the compressed MLA KV to `.coli_kv` after each turn (~182 KB/token, crash-safe) and resumes it with zero re-prefill; validated byte-identical to an uninterrupted session. `KVSAVE=0` disables.
- **Opt-in resident CUDA tier** — model-resident tensors (and, with a measured `PIN` profile, the hottest experts) live in VRAM; streaming experts deliberately stay on the CPU path so the disk bottleneck isn't just traded for a PCIe one. On Windows this is the runtime `coli_cuda.dll` loaded via `LoadLibrary`.
- **Offline FP8→int4 converter** (`c/tools/convert_fp8_to_int4.py`) — downloads one shard at a time, requantizes, deletes the shard; the 756 GB FP8 checkpoint never needs to exist on disk at once. Resumable. (The pre-converted model above skips this.)

### A note on lossy speed

Some knobs buy speed by giving up quality — they are **off by default** and print a warning when set. Reach for them deliberately, not as free wins:

- **`--topp` / `TOPP`, `--topk` / `TOPK`** — expert-routing reduction: drop low-weight routed experts for ~30–40% fewer disk reads, at a small quality cost. (These are *not* token-sampling filters — token nucleus/top-p is `NUCLEUS`.)
- **`CACHE_ROUTE`** (+ `ROUTE_J/M/P/ALPHA`) — cache-aware routing that substitutes resident experts for some true top-K; keep off for quality-comparable runs. See [docs/CACHE_ROUTE.md](docs/CACHE_ROUTE.md).
- **`COLI_POLICY=experimental-fast`** — trades output quality for speed.

`--policy quality` (default) and `--policy balanced` preserve checkpoint precision and router decisions.

## Web dashboard & desktop

One command serves the OpenAI-compatible API **and** the web console on the same port, opening the browser when the engine is ready:

```bash
cd web && npm install && npm run build   # once
./coli web --model <model-dir>            # add --no-browser to skip auto-open
```

You get **Chat** with live token metrics, a **Runtime panel** (hardware + the live VRAM/RAM/disk expert-tier bar), and **Brain** — all 19,456 experts as a 76×256 cortex, colour = storage tier, brightness = routing heat, experts routed in a turn flash white. It talks to the engine over two tiny protocol lines (`TIERS`, `EMAP`/`HITS`) plus plain JSON.

The `web/` UI is a pure OpenAI-API client (React + TypeScript) — it never touches the engine directly, so it works against `coli serve`/`coli web` or any OpenAI-compatible endpoint. `desktop/` wraps that same UI in a Tauri v2 native window.

<p align="center">
  <img src="docs/media/colibri-dashboard.png" width="820" alt="colibrì web dashboard — live metrics, hardware panel, expert tiers">
</p>

### OpenAI-compatible API

`coli serve` keeps one model process loaded and exposes a text-only OpenAI-compatible HTTP API (`GET /v1/models`, `POST /v1/chat/completions`, legacy `POST /v1/completions`), with SSE streaming, usage counts, `temperature`, `top_p`, and the `enable_thinking` / `reasoning_effort` extensions. The gateway uses only the Python standard library.

```bash
COLI_MODEL=C:\models\glm52_i4 COLI_API_KEY=local-secret ./coli serve --host 127.0.0.1 --port 8000
```

One mutable KV context means HTTP generation uses a bounded FIFO admission queue (`--max-queue`, `--queue-timeout`) rather than faking parallel sequences; `GET /health` exposes the counters. `--kv-slots N` allocates up to 16 independent sequence contexts (select one with the `cache_slot` request field). The default bind is localhost — set `COLI_API_KEY` before exposing it, and add `--cors-origin` for browser UIs.

## Other platforms

The engine also runs on **Linux / WSL2** (the upstream-native target — `cd c && ./setup.sh`) and on **Apple Silicon with an experimental Metal backend**. Those paths, their build flags, and their measured numbers are documented upstream — see [JustVugg/colibri](https://github.com/JustVugg/colibri) and [docs/METAL-M5MAX-PERF-REPORT.md](docs/METAL-M5MAX-PERF-REPORT.md). This fork's focus and reference measurements are the native-Windows + RTX 5090 path above.

## Repo layout

```
Makefile                  root build/check entry point
c/
├── glm.c                 single-file GLM engine
├── st.h, tok.h, json.h   runtime headers
├── compat.h              Windows/POSIX I/O compatibility layer
├── backend_cuda.*        optional CUDA tier
├── backend_loader.c      runtime coli_cuda.dll loader (Windows GPU path)
├── Makefile              build and local checks
├── coli                  user-facing CLI
├── openai_server.py      OpenAI-compatible HTTP gateway
├── setup.sh              one-command local setup (Linux/macOS)
├── tools/                offline conversion, fixtures and benchmarks
└── tests/                dependency-free C and Python tests
web/                      browser UI (pure OpenAI-API client, community-maintained)
desktop/                  Tauri v2 desktop shell wrapping the web UI
docs/                     ENVIRONMENT.md, SETTINGS.md, tuning + experiment notes
```

The runtime path stays flat and readable: `glm.c` plus its small headers. From the root, `make`, `make check`, and `make clean` delegate to the engine Makefile.

## License

Apache 2.0, inherited from [JustVugg/colibri](https://github.com/JustVugg/colibri); the `LICENSE` file is unchanged, and the [change notice above](#forked-from-justvuggcolibri-apache-20) satisfies §4(b). GLM-5.2 weights are released by Z.ai under MIT.
