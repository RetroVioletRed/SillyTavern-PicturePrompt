# Picture Prompt

Let your [SillyTavern](https://github.com/SillyTavern/SillyTavern) characters **see** the world you're building. Picture Prompt gives your multimodal LLM a visual reference — how your character looks, how your persona looks, and a bunch of extra images for the scene.

Works with any vision-capable model behind a Chat Completion API: OpenRouter, Ollama, vLLM, KoboldCpp, Featherless, NanoGPT etc.

## Features

- **Avatar injection** — character and persona avatars go into the prompt
- **Extra images per persona** — upload reference images for your personas, they ride alongside the avatar
- **Gallery images injection** — inject gallery images to the prompt with per-character storage
- **Lorebook entry images** — attach images to world lorebook entries, injected when the entry fires
- **Per-image on/off toggle** — enable or disable individual images without deleting them
- **Custom labels** — describe each image to your model however fits your scene
- **Token estimation** — estimated token cost in settings, updates as you flip switches
- **Per-source quality override** — different quality per source (avatars, extras, gallery, lorebook) to balance detail and token cost

## Requirements

- SillyTavern 1.14+
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

Open the persona management panel and you'll see a new **Extra Images** section. Upload as many images as you want per persona. Your browser stores them and injects them into prompts alongside your persona avatar.

Enable/disable injection and cap the max image count per prompt from extension settings. Drag and drop the thumbnails to reorder. The same drag-to-reorder works for lorebook entry images.

## Gallery Images

SillyTavern's built-in gallery now has an "𖡡Inject Mode" switch. In inject mode you can select any image to pin it for injection.

Pinned images are per-character and you can label them.

As with Extra Images, extension settings control enable/disable and max image count.

## Lorebook Entry Images

Open any world lorebook entry, scroll to the bottom. There's a **Lorebook Images** section. Upload images per entry — they get injected whenever that entry activates.

Add a label so the model knows what it's looking at. Without a label the image is just… an image. With one it becomes "a dusty attic in Prague."

The extension tracks active entries automatically, so there's nothing to manage.

## How it works

When you hit send, Picture Prompt catches the prompt before the model sees it. It injects your images as `image_url` content blocks into the system messages.

- **Character avatar + gallery images** land in the character's personality system message
- **Persona avatar + extra images** land in the persona description system message
- **Lorebook images** land in the world info system message, right after their entry's text
- **Per-source quality** lets you set different detail levels per image type (Global | Low | Auto | High), defaulting to ST's global inline image quality

The settings panel estimates token cost live based on your current config. `/pp-images` shows exactly what'll get injected next. After each generation, a small indicator ("🖼 5 images · ~1,200 tokens") confirms what was sent.

## FAQ

**"The images aren't showing up?"**  
Picture Prompt works silently in the background — it shows your images only to the model, never in the chat UI. To verify what's being injected:
- Check the token estimator in extension settings (it reflects actual injection count)
- Use `/pp-images` to see a detailed preview of what will be sent on the next message
- Look for the small "🖼 N images · ~X tokens" indicator that appears after each generation
- Make sure "Inline image media" is enabled in AI Response settings

**"Does this work with my local model?"**  
If you use OpenAI-compatible Chat Completion, yes. Ollama, vLLM, KoboldCpp, llama.cpp — they all work.

**"How many tokens does this cost me?"**  
Depends on image size and quality. Low quality is ~85 tokens per image. High quality can run 500-2000+ depending on resolution. The estimator in settings gives you the real number with your current config.

**"How do i add extra images to my persona?"**  
Persona Management → pick your persona → Extra Images → Upload. Saved per persona, injected every request.

**"How to use Lorebook entry images?"**  
Turn on Lorebook images in settings, open any world lorebook entry, find the Lorebook Images section at the bottom. Upload an image, give it a label. When the entry activates during chat, the image comes along. Toggle individual images off anytime without deleting them.
