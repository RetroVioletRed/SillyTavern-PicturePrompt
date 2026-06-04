# Picture Prompt

Let your [SillyTavern](https://github.com/SillyTavern/SillyTavern) characters **see** the world you're building. Picture Prompt gives your multimodal LLM a visual reference — how your character looks, how your persona looks, and a bunch of extra images for the scene.

Works with any vision-capable model behind a Chat Completion API: OpenRouter, Ollama, vLLM, KoboldCpp, Featherless, NanoGPT, and more.

## Features

- **Avatar injection** — your character and persona avatars become part of the roleplay context
- **Extra images per persona** — upload reference images for each of your personas, they get injected alongside the avatar
- **Gallery images injection** — inject gallery images to the prompt with per-character storage
- **Per-image on/off toggle** — individually enable or disable which extra images get injected, without deleting them
- **System prompt injection** — injects into the system message on every response
- **Custom labels** — describe each image to your model however fits your scene
- **Token estimation** — the extension estimates how many tokens will be used with your current settings automatically

## Requirements

- SillyTavern 1.12+
- A **Chat Completion** API (Text Completion is not supported)
- A vision-capable model (latest Gemma 4, Qwen, ChatGPT, Grok etc.)
- **"Inline image media"** enabled in AI Response settings

## Installation

Install via the SillyTavern extension installer: **Extensions** → **Install Extension**:

```txt
https://github.com/RetroVioletRed/SillyTavern-PicturePrompt
```

Then enable in Extensions panel → **Picture Prompt**

## Extra Images

Open the persona management panel and you'll see a new **Extra Images** section. Upload any number of images per persona. They'll be stored locally in your browser and injected into prompts alongside your persona avatar.

Controls in extension settings let you enable/disable injection and set a max image count per prompt.

## Gallery Images

SillyTavern's built-in gallery now has an "𖡡Inject Mode" switch. In inject mode you can select any image to pin it for injection.

Pinned images are stored per-character and can be labeled.

As with Extra Images, extension settings let you enable/disable injection and set a max image count.

## How it works

Every time you send a message, Picture Prompt injects your images into the system message as part of the model instruction.

Image quality follows the global **Inline Image Quality** setting in AI Response Configuration (`low` / `high` / `auto`).

## FAQ

**"The images aren't showing up?"**  
Right, the extension works in the background and shows your images only to your model.

**"Does this work with my local model?"**  
If you use OpenAI-compatible Chat Completion, yes. Ollama, vLLM, KoboldCpp, llama.cpp — they all work.

**"How many tokens does this cost me?"**  
It depends. The extension displays token count automatically in the settings. Aproximate cost will be around 500-2000 tokens per image. Stick with the "low" quality setting if you want to save some.

**"How do i add extra images to my persona?"**  
You go to Persona Management → Your persona → Extra Images → Upload Image. Extra images are saved per persona and injecting to the system message at each reques.
