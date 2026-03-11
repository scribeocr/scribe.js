# scribe-document-tools MCP Server

MCP server that enables Claude Code to extract text from documents and create highlighted PDFs using scribe.js.

## What This Does

This server gives Claude Code three tools:

- **`list_documents`** - Find PDF and image files in a directory
- **`extract_document_text`** - Extract text from a document with page:line numbers
- **`create_highlighted_pdf`** - Create a PDF with specified lines highlighted

The key workflow: Claude extracts text, reasons semantically about which passages are relevant to your query, then creates highlighted PDFs marking those passages. This enables complex queries like "highlight all clauses discussing limitation of liability" that keyword search cannot handle.

## Setup

Add this to `.mcp.json` in your project root (create the file if it doesn't exist):

```json
{
    "mcpServers": {
        "scribe": {
            "command": "node",
            "args": ["/absolute/path/to/scribe.js/mcp/index.js"]
        }
    }
}
```

Then open Claude Code in your project directory. The tools will be available automatically.

## Usage Examples

Just ask Claude in natural language:

- "Search all documents in this folder for discussions of indemnification and create highlighted PDFs"
- "Extract text from contract.pdf and highlight the sections about payment terms"
- "Find all forward-looking statements in these financial reports and highlight them"

Claude will use the tools automatically to extract text, analyze it, and produce highlighted PDFs.
