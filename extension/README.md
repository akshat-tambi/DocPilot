# DocPilot Extension

AI-powered VS Code extension that ingests documentation and enhances GitHub Copilot with relevant context through a dedicated sidebar panel.

## Features

- Smart Documentation Ingestion: Crawl and parse HTML/Markdown documentation from any URL with configurable depth and page limits
- AI-Powered Embeddings: Convert documentation into searchable vector embeddings using local processing
- Copilot Integration: Seamlessly inject relevant documentation context into GitHub Copilot Chat via @docpilot participant
- Sidebar Interface: Manage documentation sources directly from the VS Code sidebar with real-time scraping progress
- Context Augmentation: Automatically enhance chat conversations with relevant documentation chunks
- Local Processing: Everything runs locally - no external API keys required

## Quick Start

1. Install the extension from VSIX or build from source
2. Click the DocPilot rocket icon in the VS Code Activity Bar to open the sidebar
3. Add documentation sources using the form in the sidebar
4. Configure scraping settings (max depth, max pages, external links)
5. Start scraping to build your documentation knowledge base
6. Use @docpilot in GitHub Copilot Chat to get context-aware responses

## Usage

### Adding Documentation Sources
- Open the DocPilot sidebar from the Activity Bar
- Enter a documentation URL (e.g., https://docs.example.com)
- Optionally customize the source name
- Set max depth (1-4 levels) and max pages (10-100)
- Click "Add Source" to start scraping

### Using with Copilot Chat
- Type @docpilot followed by your question in any GitHub Copilot chat
- DocPilot will search your configured documentation sources
- Relevant context will be generated in form of markdown file
- Attach the files as context for Copilot.

### Configuration
- Enable/disable context augmentation globally
- Set maximum number of context chunks (1-10) to include in each chat
- Manage documentation sources (enable/disable/remove)

## Architecture

The extension consists of:
- Sidebar provider for documentation source management
- Background worker for web scraping and content processing
- Vector storage system for semantic search
- Chat participant integration for Copilot enhancement
- Local embedding engine for context retrieval
