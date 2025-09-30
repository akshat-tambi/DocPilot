# DocPilot

AI-powered VS Code extension that ingests documentation and enhances GitHub Copilot with relevant context.

## ✨ Features

- 🔍 **Smart Documentation Ingestion**: Crawl and parse HTML/Markdown documentation from any URL
- 🧠 **AI-Powered Embeddings**: Convert documentation into searchable vector embeddings 
- 💬 **Copilot Integration**: Seamlessly inject relevant documentation context into GitHub Copilot Chat
- 📚 **Semantic Search**: Find the most relevant documentation snippets for your coding questions
- ⚡ **Local Processing**: Everything runs locally - no external API keys required

## 🚀 Quick Start

1. **Build Extension**: `pnpm install && pnpm build`
2. **Launch**: Press F5 in VS Code to open Extension Development Host
3. **Ingest Documentation**: Run `DocPilot: Ingest Documentation URL` from Command Palette
4. **Use with Copilot**: Type `@docpilot` in Copilot Chat with your questions

## 🎯 Commands

- `DocPilot: Ingest Documentation URL` - Start ingesting documentation from a URL
- `DocPilot: Cancel Ingestion` - Cancel the current ingestion job  
- `DocPilot: Query Documentation` - Search your ingested documentation directly

## 🏗️ Architecture

- `extension/` – VS Code extension sources (TypeScript)
- `worker/` – Background workers for scraping, embedding, and retrieval
- `shared/` – Shared types and utilities
- `assets/` – Static assets like models and icons
- `docs/` – Architecture and setup documentation
