# Picture Prompt

Let your characters **see** the world you're building. Picture Prompt gives your multimodal LLM a visual reference — how your character looks, how your persona looks, or soon, anything you want in the scene.

Works with any vision-capable model behind a Chat Completion API: OpenRouter, Ollama, vLLM, KoboldCpp, Featherless, NanoGPT, and more.

## Features

- **Avatar injection** — your character and persona avatars become part of the roleplay context
- **System prompt injection** — images serve as a part of your roleplay context for each message
- **Custom labels** — describe each image to your model however fits your scene

## Requirements

- SillyTavern 1.12+
- A **Chat Completion** API (Text Completion is not supported)
- A vision-capable model (Lattest Gemma 4, Qween, ChatGPT, Grok etc.)
- **"Inline image media"** enabled in AI Response settings

## Installation

1. In SillyTavern, go to **Extensions** → **Install Extension**
2. Paste `https://github.com/RetroVioletRed/SillyTavern-PicturePrompt`
3. Restart SillyTavern
4. Enable in Extensions panel → **Picture Prompt**

## How it works

Every time you send a message, Picture Prompt injects your images into the system message as a part of model instruction.

Image quality follows the global **Inline Image Quality** setting in AI Response Configuration (`low` / `high` / `auto`).

## FAQ

**"The images aren't showing up?"**
Right, the extension works in the background and shows your images only to the model.

**"Does this work with my local model?"**  
If you use OpenAI-compatible Chat Completion, yes. Ollama, vLLM, KoboldCpp, llama.cpp — they all work.

**"How many tokens does this cost me?"**  
Around 500–2000 tokens per image, mostly depending on resolution. Stick with the "low" quality setting if you want to save some in exchange of quality.
