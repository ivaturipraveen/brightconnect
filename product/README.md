# Product

The application the agent fleet maintains: a chat service and the UI in front of it.

```
backend/    Chat API      Node + Fastify, answers questions via Claude
frontend/   Chat UI       React + Vite, streams the answer as it arrives
.claude/    The fleet     17 agent definitions that work on this codebase
```

## Running it

```bash
npm install --prefix backend && npm install --prefix frontend
npm run start  --prefix backend      # http://localhost:8080
npm run dev    --prefix frontend     # http://localhost:5174
```

Set `ANTHROPIC_API_KEY` in the repository-root `.env`. Per-app settings go in
`backend/.env` and override it.

## Why `.claude/` lives here

The agents work on *this* codebase, so their definitions sit with it. That makes
`product/` a self-contained Claude Code project: the same seventeen agents load
whether they are driven by the dashboard or by the Claude Code CLI run from this
directory. Editing an agent's prompt and editing the code it maintains happen in
the same place.

The dashboard is deliberately outside this directory. It observes the work and
cannot be modified by the agents doing it.
