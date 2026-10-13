# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GitLab MCP (Model Context Protocol) Server - a TypeScript implementation providing 95+ GitLab API operations as MCP tools. Supports multiple authentication methods (PAT, OAuth2, remote per-session auth) and transport protocols (stdio, SSE, Streamable HTTP).

## Build & Development Commands

```bash
npm run build       # Compile TypeScript to build/
npm run dev         # Build and run the server
npm run watch       # Watch mode for TypeScript compilation
```

## Testing

```bash
npm test            # API validation + remote auth tests
npm run test:integration    # API validation only
npm run test:remote-auth    # Remote authorization tests (uses mock GitLab)
npm run test:mcp:readonly   # Read-only MCP tests
npm run test:oauth          # OAuth flow tests
npm run test:server         # Build and run test transport server
npm run test:all            # All tests including readonly and OAuth
```

## Linting & Formatting

```bash
npm run lint        # ESLint check
npm run lint:fix    # ESLint with auto-fix
npm run format      # Prettier format
npm run format:check  # Prettier check only
```

## Architecture

### Core Files (root directory)

- **index.ts** (~5000+ lines): Main server implementation containing:
  - MCP server setup with `@modelcontextprotocol/sdk`
  - All tool implementations (95+ GitLab API operations)
  - Three transport handlers: stdio, SSE, Streamable HTTP
  - Session management for multi-user remote authorization
  - Rate limiting and metrics endpoints

- **schemas.ts**: Zod schemas for GitLab API types and responses (pipelines, jobs, MRs, issues, etc.)

- **customSchemas.ts**: Custom Zod schema helpers (e.g., `flexibleBoolean`)

- **oauth.ts**: OAuth2 PKCE authentication flow implementation with token storage/refresh

### Key Patterns

**Tool Definition**: Each tool is registered via `allTools` array with Zod schema validation:
```typescript
server.setRequestHandler(ListToolsRequestSchema, async () => { /* returns filtered tools */ })
server.setRequestHandler(CallToolRequestSchema, async (request) => { /* switch on tool name */ })
```

**Authentication Modes**:
1. Personal Access Token (`GITLAB_PERSONAL_ACCESS_TOKEN`)
2. OAuth2 (`GITLAB_USE_OAUTH=true` with client ID)
3. Remote per-session (`REMOTE_AUTHORIZATION=true` with Streamable HTTP)

**Feature Flags**: Wiki, milestone, and pipeline tools are toggled via env vars (`USE_GITLAB_WIKI`, `USE_MILESTONE`, `USE_PIPELINE`)

### Test Structure

- `test/validate-api.js` - API schema validation
- `test/remote-auth-simple-test.ts` - Remote authorization tests
- `test/utils/mock-gitlab-server.ts` - Mock GitLab for testing
- `test/clients/` - Transport-specific MCP clients for testing

## Important Notes

- Never create labels on GitLab (issues or merge requests) per user instructions
- The server removes `$schema` from tool schemas for Gemini compatibility
- Read-only mode (`GITLAB_READ_ONLY_MODE=true`) filters to safe operations only
- `GITLAB_DENIED_TOOLS_REGEX` can exclude tools by regex pattern