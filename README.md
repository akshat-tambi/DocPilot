# DocPilot

AI-powered VS Code extension that ingests documentation and enhances GitHub Copilot with relevant context through an integrated sidebar interface.

## Features

- Smart Documentation Ingestion: Crawl and parse HTML/Markdown documentation from any URL with configurable depth and page limits
- AI-Powered Embeddings: Convert documentation into searchable vector embeddings using local machine learning models
- Copilot Integration: Seamlessly inject relevant documentation context into GitHub Copilot Chat via @docpilot participant
- Sidebar Interface: Dedicated Activity Bar panel for managing documentation sources with real-time scraping progress
- Context Augmentation: Automatically enhance chat conversations with relevant documentation chunks
- Semantic Search: Find the most relevant documentation snippets for coding questions using vector similarity
- Local Processing: Everything runs locally with no external API dependencies

## Quick Start

1. **Build Extension**: `pnpm install && pnpm build`
2. **Package Extension**: `node extension/scripts/prepare-package.cjs`
3. **Install**: Install the generated .vsix file in VS Code
4. **Open Sidebar**: Click the DocPilot rocket icon in the Activity Bar
5. **Add Sources**: Use the sidebar form to add documentation URLs
6. **Use with Copilot**: Type `@docpilot` in GitHub Copilot Chat with your questions

## Usage

### Managing Documentation Sources
- Open the DocPilot sidebar from the VS Code Activity Bar
- Add documentation URLs with customizable scraping parameters
- Monitor real-time scraping progress with page and chunk counts
- Enable/disable sources or remove them as needed

### Integration with GitHub Copilot
- Use @docpilot in any GitHub Copilot chat conversation
- DocPilot automatically searches your configured documentation
- Relevant context is injected to provide more accurate, documentation-specific responses
- Configure the number of context chunks and enable/disable the feature globally

## New Features (2025 Update)

- **Inline Documentation Suggestions**: See relevant documentation snippets directly in VS Code hovers as you move your cursor or hover over code.
- **Sidebar Doc Suggestions**: The sidebar now shows the latest relevant documentation for your current code context, with quick actions.
- **User Actions**: Pin, bookmark, or rate documentation suggestions from the sidebar for future reference and feedback.
- **Performance**: Fast, cached lookups for repeated queries and efficient sidebar updates.
- **Accessibility**: Sidebar doc suggestions are accessible with ARIA roles and keyboard navigation.

### How to Use the New Features

- **Hover or move your cursor** over code to see relevant documentation in a popup and in the sidebar.
- **Sidebar Actions**: Use the pin and rate buttons to mark useful suggestions or provide feedback.
- **Settings**: Adjust the number of context chunks and enable/disable features from the sidebar settings panel.

---

## Architecture

- `extension/` - VS Code extension implementation with sidebar interface and chat participant
- `worker/` - Background workers for web scraping, content processing, and vector operations
- `shared/` - Shared TypeScript types and utilities used across components
- `assets/` - Static assets and documentation
- `docs/` - Architecture documentation and setup guides

### Core Components

- **Sidebar Provider**: Main UI for managing documentation sources and monitoring progress
- **Context Augmenter**: Chat participant that integrates with GitHub Copilot
- **Worker Manager**: Coordinates background processing tasks
- **Ingestion Worker**: Handles web scraping and content extraction
- **Retrieval Engine**: Performs semantic search using vector embeddings
- **Vector Store**: Local storage for document embeddings and metadata
