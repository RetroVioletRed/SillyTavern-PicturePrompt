# Picture Prompt

Let your [SillyTavern](https://github.com/SillyTavern/SillyTavern) characters **see** the world you're building. Picture Prompt gives your multimodal LLM a visual reference — how your character looks, how your persona looks, and a bunch of extra images for the scene.

Works with any vision-capable model behind a Chat Completion API: OpenRouter, Ollama, vLLM, KoboldCpp, Featherless, NanoGPT etc.

[![SillyTavern](https://img.shields.io/badge/SillyTavern-1.14%2B-6e5494)](https://github.com/SillyTavern/SillyTavern)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![Stars](https://img.shields.io/github/stars/RetroVioletRed/SillyTavern-PicturePrompt?style=flat&color=F1C40F)](https://github.com/RetroVioletRed/SillyTavern-PicturePrompt/stargazers)

## Who it's for

Anyone using SillyTavern with a vision model who wants richer, more consistent scene/character understanding. Especially useful for detailed world-building, consistent character appearance, or "show, don't tell" prompting.

---

## Features

- **Avatar injection**: The model sees character and persona avatars as pure images, each inside its description prompt block
- **Extra images per persona**: Upload reference images for your personas, they pass alongside the avatar
- **Gallery images injection**: Inject gallery images to the prompt, use them as extra images for character, items and scene references
- **Lorebook entry images**: Attach images to Lorebook entries, they pass alongside entry text; solid for NPCs, places and artifacts
- **Fully local and offline**: Images are stored in your browser and never leave your machine if you are using a local model
- **Custom labels**: Attach a text hint to each image; it helps to steer the model and get the best results
- **Token estimation**: The extension shows you token cost overhead in settings before generation
- **Per-source quality override**: Different quality per source (avatars, extras, gallery, lorebook) to balance detail and token cost

---

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

---

## Extra Images

Open the persona management panel and you'll see a new **Extra Images** section. Upload as many images as you want per persona. Your browser stores them and injects them into prompts alongside your persona avatar.

Enable/disable injection and cap the max image count per prompt from extension settings. Drag and drop the thumbnails to reorder.

## Gallery Images

SillyTavern's built-in gallery now has an "𖡡Inject Mode" switch. In inject mode you can select any image to pin it for injection.

Pinned images are per-character and you can label them.

As with Extra Images, extension settings control enable/disable and max image count.

## Lorebook Entry Images

Open any Lorebook entry, scroll to the bottom of the editor. There's a **Lorebook Images** section. Upload images per entry — they get injected whenever that entry activates.

Add a label if you want to explain the image to the model. Drag and drop the thumbnails to reorder.

The extension tracks active entries fully automatically.

---

## How it works

When you hit send, Picture Prompt catches the prompt before the model sees it and injects your images as `image_url` content blocks into the relevant places across the prompt.

By default:

- **Character avatar + gallery images** land in the character's personality system message
- **Persona avatar + extra images** land in the persona description system message
- **Lorebook images** land in the world info system message, right after their entry's text

**Per-source quality** lets you set different detail levels per image type (Global | Low | Auto | High), defaulting to ST's global inline image quality

The settings panel estimates token cost live based on your current config. `/pp-images` shows exactly what'll get injected next. After each generation, a small indicator ("🖼 5 images · ~1,200 tokens") confirms what was sent.

---

## FAQ

**"The images aren't showing up?"**  
Picture Prompt works silently in the background — it shows your images only to the model, never in the chat UI. To verify what's being injected:
- Check the token estimator in extension settings (it reflects actual injection count)
- Use `/pp-images` to see a detailed preview of what will be sent on the next message
- Look for the small "🖼 N images · ~X tokens" indicator that appears after each generation

**"Does this work with my local model?"**  
If you use OpenAI-compatible Chat Completion, yes. Ollama, vLLM, KoboldCpp, llama.cpp — they all work.

**"How many tokens does this cost me?"**  
Depends on image size and quality. Low quality is ~85 tokens per image. High quality can run 500-2000+ depending on resolution. The estimator in settings gives you the real numbers with your current config.

**"How do i add extra images to my persona?"**  
You go to Persona Management Panel → pick your persona → Extra Images → Upload. Saved per persona, injected every request.

**"How to use Lorebook entry images?"**  
Open any Lorebook entry editor, find the Lorebook Images section at the bottom. Upload an image, give it a label. When the entry activates during chat, the image comes along. Toggle individual images off anytime without deleting them.
