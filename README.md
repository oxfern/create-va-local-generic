# Local voice agent

Talk to a voice assistant in your browser. Whisper hears you, a local language model answers, and Kokoro speaks the reply. The app runs on your computer; after setup, conversation audio and inference stay local.

## Start

On macOS or Linux, open a terminal and run:

```sh
git clone https://github.com/oxfern/create-va-local-generic.git
cd create-va-local-generic
./start.sh
```

The first run downloads Bun, llama.cpp, and about **2.9 GB** of model files. They are installed inside this folder; you do not need Hermit, Homebrew, or Node. Allow extra disk space for dependencies and temporary downloads. Later runs use the files already on your computer. Keep the terminal open while using the app. The installer uses `curl`, `tar`, and `unzip` from your system.

Open **http://127.0.0.1:3000** in your browser and allow microphone access. Click **Connect microphone**, then hold **Space** or **Hold to talk** while speaking. Release to send. The first reply may take longer while speech models load. Use headphones if you enable hands-free interruption.

Run `./start.sh` again whenever you want to use it. Press **Ctrl+C** in the terminal to stop it.

## Settings

Edit `config.json` to change the port, voice, or language model settings. `llama.gpuLayers` defaults to `99`; set it to `0` to run the language model on CPU. The server listens only on your computer.

If startup fails, run the built-in diagnosis:

```sh
./scripts/install-tools.sh
./.tools/bin/bun run doctor
```

For microphone errors, use the localhost address above and check your browser's site permission. Model downloads need internet access on the first run. No GitHub account is needed to run the app.

## For contributors

The app uses Bun for its server, browser build, and separate speech worker, plus llama.cpp for local language model inference. `scripts/install-tools.sh` downloads pinned releases and verifies their SHA-256 checksums. `models.lock.json` pins the model revisions and checksums. Downloaded tools and models are ignored by Git.

```sh
export PATH="$PWD/.tools/bin:$PATH"
bun run typecheck
bun run build
bun run test
bun run smoke
```
