# Changelog

## 1.1.0 - 2026-10-07

### Free AI, no key needed
- The AI writer now works straight away: the new **Free AI (Claude)** option is the default, with no
  key or account. It runs on Claude Opus 5.5 through the Studio's own AI server, which keeps the key
  private, allows 10 requests a minute per person and stores nothing.
- Players who had picked a provider but never added a key are moved to the Free AI automatically.
  Anyone with their own key keeps using it, and every provider from 1.0.0 is still available.
- Pressing **Stop** cancels the request on the server too.

## 1.0.0 - 2026-10-04

The first public release.

### Editor
- A Word-style editor for 3DXChat profile and gift texts: a toolbar with bold, italic, colour, size, grow/shrink, clear formatting, undo and redo, and a card that looks like the game's profile panel.
- Gradients per letter or per word, with adjustable colour steps and a live cost estimate. Colours blend in OKLab.
- About 790 symbols in categories, 16 flags, dividers and eight fancy-letter styles.
- Profile and Gift modes with separate drafts and templates; `%username%` and a Mass gift maker.
- Import existing code, or paste code straight onto the card.

### Code
- Generates the shortest code it can: nesting ordered by how long each style lasts, colour names for red/white/blue/yellow/black, spaces merged into neighbouring colours.
- Counts like the game: 1000 characters for profiles, 240 characters and 255 bytes for gifts, line breaks count twice. Flags symbols that don't show in gifts.

### AI writer
- Write it for me, Shorten to fit, Fix spelling, Change tone, Translate and Style it, each previewed with its character count before you accept it.
- Works with a key from Anthropic, OpenAI, Google Gemini, OpenRouter, Mistral, DeepSeek, xAI, Together AI, Perplexity or Cohere, or a local OpenAI-compatible server (Ollama, LM Studio). Requests go straight from the page to the provider.
